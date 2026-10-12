import type { VectorStoreInterface } from '@langchain/core/vectorstores';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';

/**
 * Streamed message content is usually a string, but some providers (Cloudflare
 * Workers AI among them) emit blocks or a final usage chunk with no text.
 * StringOutputParser throws on those, so text is extracted here instead.
 */
export function chunkText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(chunkText).join('');
  if (content && typeof content === 'object') {
    const c = content as Record<string, unknown>;
    if (typeof c.text === 'string') return c.text;
    if (typeof c.response === 'string') return c.response;
  }
  return '';
}

/** What the model must say when the workspace's documents do not contain the answer. */
export const NOT_FOUND = "I can't find that in this workspace's documents.";

export interface Source {
  n: number;
  source: string;
  chunk: number;
  relevance: number;
  excerpt: string;
}

export type AnswerEvent =
  | { type: 'sources'; sources: Source[] }
  | { type: 'token'; text: string }
  | { type: 'done'; grounded: boolean };

export interface RagOptions {
  /** How many chunks to retrieve. */
  k?: number;
  /** Chunks below this relevance (0..1) are ignored. If none pass, the model is never called. */
  minRelevance?: number;
  /** Chroma (cosine space) returns a distance; in-memory stores return a similarity. */
  scoreIsDistance?: boolean;
  /** Turns a workspace id into the store's filter format. */
  filterFor?: (workspace: string) => unknown;
  chunkSize?: number;
  chunkOverlap?: number;
}

const PROMPT = ChatPromptTemplate.fromMessages([
  [
    'system',
    'You answer questions using ONLY the numbered context below. ' +
      'Cite the passages you used as [1], [2] and so on. ' +
      'If the context does not contain the answer, reply exactly: "{notFound}" and nothing else.\n\n' +
      'Context:\n{context}',
  ],
  ['human', '{question}'],
]);

/**
 * Retrieval-augmented answers scoped to one workspace. Framework-free on purpose:
 * NestJS, the Socket.IO gateway and the MCP server all wrap this same class, and
 * the tests drive it with an in-memory store.
 */
export class RagEngine {
  private readonly splitter: RecursiveCharacterTextSplitter;
  private readonly k: number;
  private readonly minRelevance: number;
  private readonly scoreIsDistance: boolean;
  private readonly filterFor: (workspace: string) => unknown;

  constructor(
    private readonly store: VectorStoreInterface,
    private readonly llm: BaseChatModel,
    opts: RagOptions = {},
  ) {
    this.k = opts.k ?? 4;
    this.minRelevance = opts.minRelevance ?? 0.5;
    this.scoreIsDistance = opts.scoreIsDistance ?? true;
    this.filterFor = opts.filterFor ?? ((workspace) => ({ workspace }));
    this.splitter = new RecursiveCharacterTextSplitter({
      chunkSize: opts.chunkSize ?? 800,
      chunkOverlap: opts.chunkOverlap ?? 120,
    });
  }

  async ingest(input: { workspace: string; source: string; text: string }): Promise<{ chunks: number }> {
    const workspace = input.workspace.trim();
    const source = input.source.trim();
    if (!workspace || !source || !input.text.trim()) {
      throw new Error('workspace, source and text are required');
    }
    const docs = await this.splitter.createDocuments([input.text], [{ workspace, source }]);
    docs.forEach((d, i) => (d.metadata.chunk = i));
    // Stable ids: re-ingesting the same source replaces its chunks instead of duplicating them.
    const ids = docs.map((_, i) => `${workspace}::${source}::${i}`);
    await this.store.addDocuments(docs, { ids });
    return { chunks: docs.length };
  }

  async retrieve(workspace: string, question: string): Promise<Source[]> {
    const hits = await this.store.similaritySearchWithScore(question, this.k, this.filterFor(workspace) as any);
    return hits
      .map(([doc, score]) => ({
        source: String(doc.metadata.source),
        chunk: Number(doc.metadata.chunk ?? 0),
        relevance: this.scoreIsDistance ? 1 - score : score,
        excerpt: doc.pageContent,
      }))
      .filter((s) => s.relevance >= this.minRelevance)
      .sort((a, b) => b.relevance - a.relevance)
      .map((s, i) => ({ n: i + 1, ...s }));
  }

  /** Streams sources first, then the answer token by token. */
  async *answer(workspace: string, question: string): AsyncGenerator<AnswerEvent> {
    const sources = await this.retrieve(workspace, question);
    yield { type: 'sources', sources };

    // Guard: with nothing relevant retrieved, refuse without calling the model,
    // so it cannot fill the gap with an invented answer.
    if (sources.length === 0) {
      yield { type: 'token', text: NOT_FOUND };
      yield { type: 'done', grounded: false };
      return;
    }

    const context = sources.map((s) => `[${s.n}] (${s.source}) ${s.excerpt}`).join('\n\n');
    const chain = PROMPT.pipe(this.llm);
    let full = '';
    for await (const chunk of await chain.stream({ context, question, notFound: NOT_FOUND })) {
      const text = chunkText(chunk.content);
      if (!text) continue;
      full += text;
      yield { type: 'token', text };
    }
    yield { type: 'done', grounded: !full.includes(NOT_FOUND) };
  }

  /** Non-streaming convenience used by the REST endpoint, the MCP server and the evals. */
  async ask(workspace: string, question: string): Promise<{ answer: string; sources: Source[]; grounded: boolean }> {
    let answer = '';
    let sources: Source[] = [];
    let grounded = false;
    for await (const ev of this.answer(workspace, question)) {
      if (ev.type === 'sources') sources = ev.sources;
      else if (ev.type === 'token') answer += ev.text;
      else grounded = ev.grounded;
    }
    return { answer: answer.trim(), sources, grounded };
  }
}
