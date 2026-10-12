# Corolet Desktop

A desktop app for asking questions about your own documents. Answers stream in as they are written, cite the passages they came from, and refuse when the documents don't contain the answer. The same memory is exposed to other AI agents through an MCP server.

Part of [Corolet](https://corolet.com). Built to run on free infrastructure: ChromaDB in Docker and Cloudflare Workers AI for embeddings and generation.

```
┌──────────────── Tauri desktop shell ────────────────┐
│  Vite + TypeScript UI · native file dialog (fs)     │
└──────────────┬───────────────────────┬──────────────┘
         REST (ingest)          Socket.IO (ask, stream)
┌──────────────┴───────────────────────┴──────────────┐
│ NestJS server                                       │
│   DocumentsController · ChatGateway                 │
│   RagEngine (LangChain.js)                          │
│     split → embed → ChromaDB (cosine) → retrieve    │
│     → relevance guard → prompt with citations → LLM │
└──────────────┬───────────────────────┬──────────────┘
          ChromaDB                Cloudflare Workers AI
                                (bge-base 768-d, Llama 3.1 8B)
   MCP server (stdio, official SDK) wraps the same RagEngine:
   search_memory · ingest_document
```

## What it does

- **Workspace memory.** Documents are split into overlapping chunks, embedded as 768-dimensional vectors and stored in ChromaDB with their workspace, source and position. Re-adding a document replaces its chunks instead of duplicating them. A question never sees another workspace's documents.
- **Grounded, streamed answers.** The server retrieves the closest chunks, drops anything below a relevance threshold, and streams the answer over Socket.IO: sources first, then tokens, then a `done` event saying whether the answer is grounded. Several questions can run on one connection, and any of them can be cancelled.
- **A guard against invented answers.** If nothing relevant is retrieved, the model is never called and the user gets a plain refusal. If the model itself says the context doesn't cover the question, the answer is marked ungrounded.
- **MCP server.** `search_memory` and `ingest_document` let Claude Desktop, Cursor or any MCP client use the same memory.
- **Measured, not assumed.** Unit tests cover the engine with an in-memory store and a fake model. A live eval runs every case several times against the real stack with [llm-harness-kit](https://www.npmjs.com/package/llm-harness-kit) and reports pass rate and p50 latency.

## Stack

| Layer | Technology |
|---|---|
| Desktop shell | Tauri 2 (Rust), dialog + fs plugins with scoped permissions |
| UI | Vite, TypeScript, socket.io-client |
| Server | NestJS 12, Express, Socket.IO gateway, Zod validation |
| RAG | LangChain.js (`@langchain/core`, text splitters, Chroma vector store) |
| Vector database | ChromaDB (cosine space) |
| Models | Cloudflare Workers AI: `@cf/baai/bge-base-en-v1.5` embeddings, `@cf/meta/llama-3.1-8b-instruct` chat, both through small LangChain classes in `server/src/ai/cloudflare.ts` |
| Agents | MCP TypeScript SDK (`@modelcontextprotocol/sdk`), stdio transport |
| Evals | llm-harness-kit (`runEvals`: N trials per case, pass rate, p50) |

The chat model class is written in this repo because the published `@langchain/cloudflare` chat model fails while streaming against current `@langchain/core` (`secondContent is not iterable`). The replacement reads the REST server-sent events directly.

## Run it

Requirements: Node 20+, Docker, a Cloudflare account (the Workers AI free tier is enough). For the desktop build: Rust and the Tauri prerequisites for your OS.

```bash
# 1. Vector database
docker compose up -d chroma            # listens on 127.0.0.1:8100

# 2. Server
cd server
cp .env.example .env                   # add CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_TOKEN
npm install
npm run build
node --env-file=.env dist/main.js      # http://127.0.0.1:3071

# 3. Desktop app
cd ../desktop
npm install
npm run tauri dev                      # or: npm run tauri build  (Windows installer in src-tauri/target/release/bundle)
```

### Use the memory from an MCP client

```json
{
  "mcpServers": {
    "corolet-memory": {
      "command": "node",
      "args": ["--env-file=/path/to/server/.env", "/path/to/server/dist/mcp.js"]
    }
  }
}
```

## Tests and evals

```bash
cd server
npm test        # 9 unit tests, no network
npm run smoke   # against a running server: REST ingest, Socket.IO streaming, both MCP tools
npm run eval    # live: ChromaDB + Workers AI, 5 trials per case
```

Latest eval run (`server/eval/results.md`), on a small 7-case set over three short documents:

```
PASS  refund window     5/5 (100%)  p50 600 ms
PASS  refund processor  5/5 (100%)  p50 626 ms
PASS  pro plan price    5/5 (100%)  p50 583 ms
PASS  credit unit       5/5 (100%)  p50 457 ms
PASS  enterprise SLA    5/5 (100%)  p50 478 ms
PASS  refuses: founder  5/5 (100%)  p50 392 ms
PASS  refuses: office   5/5 (100%)  p50 422 ms
```

The set is small on purpose: it checks the behaviours that matter (answer from the right document, cite it, refuse when the answer isn't there). It is not a benchmark.

## Configuration

| Variable | Default | |
|---|---|---|
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AI_TOKEN` | required | Workers AI credentials |
| `CHROMA_URL` | `http://127.0.0.1:8100` | |
| `CHROMA_COLLECTION` | `corolet_memory` | |
| `PORT`, `HOST` | `3071`, `127.0.0.1` | |
| `RAG_K` | `4` | chunks retrieved per question |
| `RAG_MIN_RELEVANCE` | `0.5` | 0..1; below this a chunk is ignored |
| `EMBEDDING_MODEL`, `CHAT_MODEL` | see above | any Workers AI model with the same API |
| `CORS_ORIGINS` | `*` | comma-separated |

## Limits

- No authentication yet: run the server on localhost or behind your own gateway.
- Ingestion takes plain text (`.md`, `.txt`). PDF and DOCX parsing are not built in.

## License

MIT
