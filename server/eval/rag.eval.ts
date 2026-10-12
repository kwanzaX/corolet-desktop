/**
 * Live evaluation of the RAG pipeline (ChromaDB + Workers AI) with llm-harness-kit.
 * LLM output varies between runs, so every case runs several times and the
 * report shows pass rate and p50 latency per case instead of one lucky run.
 *   npm run eval            (needs ChromaDB running and .env set)
 */
import { writeFileSync } from 'node:fs';
import { runEvals, formatReport } from 'llm-harness-kit';
import { Chroma } from '@langchain/community/vectorstores/chroma';
import { CloudflareEmbeddings, cloudflareConfigFromEnv, createChatModel } from '../src/ai/cloudflare.js';
import { RagEngine } from '../src/rag/rag-engine.js';

const WS = 'eval';
const TRIALS = Number(process.env.EVAL_TRIALS ?? 5);

const DOCS = [
  {
    source: 'refunds.md',
    text: 'Refund policy. Customers can request a full refund within 14 days of purchase if fewer than 3 videos were generated. After 14 days, unused credits become account balance and are not refunded. Refunds are processed through Polar and take 5 to 10 business days.',
  },
  {
    source: 'plans.md',
    text: 'Plans. The Starter plan costs 19 dollars a month and includes 60 credits. The Pro plan costs 49 dollars a month and includes 200 credits. One credit renders one minute of video. Unused credits roll over for one month.',
  },
  {
    source: 'support.md',
    text: 'Support. The support team answers within 24 hours on weekdays. Enterprise customers have a dedicated channel and a 99.9 percent uptime SLA.',
  },
];

type Case = { name: string; input: string; check: (r: { answer: string; grounded: boolean }) => true | string };

const has = (...words: string[]) => (r: { answer: string; grounded: boolean }) => {
  if (!r.grounded) return `refused: "${r.answer}"`;
  const missing = words.filter((w) => !r.answer.toLowerCase().includes(w.toLowerCase()));
  return missing.length ? `missing ${missing.join(', ')} in "${r.answer}"` : true;
};
const refuses = (r: { answer: string; grounded: boolean }) => (!r.grounded ? true : `answered instead of refusing: "${r.answer}"`);

const CASES: Case[] = [
  { name: 'refund window', input: 'How many days do I have to ask for a refund?', check: has('14') },
  { name: 'refund processor', input: 'Who processes refunds and how long do they take?', check: has('Polar', '10') },
  { name: 'pro plan price', input: 'How much does the Pro plan cost per month?', check: has('49') },
  { name: 'credit unit', input: 'How much video does one credit render?', check: has('minute') },
  { name: 'enterprise SLA', input: 'What uptime SLA do enterprise customers get?', check: has('99.9') },
  { name: 'refuses: founder', input: 'Who founded the company?', check: refuses },
  { name: 'refuses: office', input: 'Where is the office located?', check: refuses },
];

const cf = cloudflareConfigFromEnv();
const store = new Chroma(new CloudflareEmbeddings(cf), {
  url: process.env.CHROMA_URL ?? 'http://127.0.0.1:8100',
  collectionName: 'corolet_eval',
  collectionMetadata: { 'hnsw:space': 'cosine' },
});
const engine = new RagEngine(store, createChatModel(cf), { minRelevance: Number(process.env.RAG_MIN_RELEVANCE ?? 0.5) });

for (const d of DOCS) await engine.ingest({ workspace: WS, ...d });

const report = await runEvals(CASES, (question: string) => engine.ask(WS, question), { trials: TRIALS, concurrency: 2 });
const text = formatReport(report);
console.log(text);
writeFileSync(
  new URL('./results.md', import.meta.url),
  `# RAG eval results\n\n${new Date().toISOString()} · ${TRIALS} trials per case · model ${cf.chatModel} · embeddings ${cf.embeddingModel}\n\n\`\`\`\n${text}\n\`\`\`\n`,
);
process.exit(report.ok ? 0 : 1);
