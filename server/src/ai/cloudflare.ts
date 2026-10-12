import { Embeddings, type EmbeddingsParams } from '@langchain/core/embeddings';
import { BaseChatModel, type BaseChatModelParams } from '@langchain/core/language_models/chat_models';
import { AIMessageChunk, type BaseMessage } from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';

/**
 * Cloudflare Workers AI over its REST API, so the whole stack runs on the free
 * tier with no other provider account. Credentials come from the environment
 * only (CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_AI_TOKEN).
 */
export interface CloudflareConfig {
  accountId: string;
  token: string;
  embeddingModel: string;
  chatModel: string;
}

export function cloudflareConfigFromEnv(env = process.env): CloudflareConfig {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_AI_TOKEN;
  if (!accountId || !token) {
    throw new Error('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_TOKEN (see .env.example)');
  }
  return {
    accountId,
    token,
    embeddingModel: env.EMBEDDING_MODEL ?? '@cf/baai/bge-base-en-v1.5',
    chatModel: env.CHAT_MODEL ?? '@cf/meta/llama-3.1-8b-instruct',
  };
}

const runUrl = (cfg: CloudflareConfig, model: string) =>
  `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/ai/run/${model}`;

/** bge-base returns 768-dimensional vectors; batches stay small to respect the API limits. */
export class CloudflareEmbeddings extends Embeddings {
  private readonly batchSize = 50;

  constructor(private readonly cfg: CloudflareConfig, params: EmbeddingsParams = {}) {
    super(params);
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      // caller() applies LangChain's retry and concurrency policy to each request.
      out.push(...(await this.caller.call(() => this.embedBatch(batch))));
    }
    return out;
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.embedDocuments([text]);
    return vector;
  }

  private async embedBatch(text: string[]): Promise<number[][]> {
    const res = await fetch(runUrl(this.cfg, this.cfg.embeddingModel), {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.cfg.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || !body?.success) {
      const reason = body?.errors?.[0]?.message ?? `HTTP ${res.status}`;
      throw new Error(`Cloudflare embeddings failed: ${reason}`);
    }
    return body.result.data as number[][];
  }
}

function toRole(m: BaseMessage): 'system' | 'user' | 'assistant' {
  const t = m._getType();
  return t === 'system' ? 'system' : t === 'ai' ? 'assistant' : 'user';
}

function messageText(m: BaseMessage): string {
  return typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
}

/**
 * A LangChain chat model for Workers AI. Written here because the published
 * @langchain/cloudflare chat model breaks while streaming against current
 * @langchain/core ("secondContent is not iterable"). The REST stream is
 * OpenAI-shaped server-sent events: choices[0].delta.content per chunk.
 */
export class ChatCloudflare extends BaseChatModel {
  constructor(private readonly cfg: CloudflareConfig, params: BaseChatModelParams = {}) {
    super(params);
  }

  _llmType() {
    return 'cloudflare-workers-ai';
  }

  async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const res = await this.caller.call(() =>
      fetch(runUrl(this.cfg, this.cfg.chatModel), {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.cfg.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stream: true,
          max_tokens: 700,
          messages: messages.map((m) => ({ role: toRole(m), content: messageText(m) })),
        }),
        signal: options.signal,
      }),
    );
    if (!res.ok || !res.body) {
      throw new Error(`Cloudflare chat failed: HTTP ${res.status} ${await res.text().catch(() => '')}`.trim());
    }

    const decoder = new TextDecoder();
    let buffer = '';
    for await (const bytes of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(bytes, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        let text = '';
        try {
          const ev = JSON.parse(data);
          text = ev?.choices?.[0]?.delta?.content ?? (typeof ev?.response === 'string' ? ev.response : '');
        } catch {
          continue; // a malformed keep-alive line is not worth failing the answer over
        }
        if (!text) continue;
        yield new ChatGenerationChunk({ text, message: new AIMessageChunk({ content: text }) });
        await runManager?.handleLLMNewToken(text);
      }
    }
  }

  async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    let text = '';
    for await (const chunk of this._streamResponseChunks(messages, options, runManager)) text += chunk.text;
    return { generations: [{ text, message: new AIMessageChunk({ content: text }) }] };
  }
}

export function createChatModel(cfg: CloudflareConfig) {
  return new ChatCloudflare(cfg, { maxRetries: 2 });
}
