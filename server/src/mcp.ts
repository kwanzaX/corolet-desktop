import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { RagModule } from './rag/rag.module.js';
import { RagService } from './rag/rag.service.js';

/**
 * MCP server over stdio: lets any MCP client (Claude Desktop, Cursor, an agent)
 * search and add to the same workspace memory the desktop app uses.
 * stdout carries the protocol, so the Nest logger is turned off.
 */
async function main() {
  const ctx = await NestFactory.createApplicationContext(RagModule, { logger: false });
  const rag = ctx.get(RagService).engine;

  const server = new McpServer({ name: 'corolet-memory', version: '0.1.0' });

  server.registerTool(
    'search_memory',
    {
      title: 'Search workspace memory',
      description:
        "Answer a question from a workspace's documents. Returns the answer, whether it is grounded in the documents, and the cited passages.",
      inputSchema: { workspace: z.string().min(1), question: z.string().min(1) },
    },
    async ({ workspace, question }) => {
      const r = await rag.ask(workspace, question);
      const cited = r.sources.map((s) => `[${s.n}] ${s.source} #${s.chunk} (relevance ${s.relevance.toFixed(2)})`).join('\n');
      return {
        content: [{ type: 'text', text: `${r.answer}\n\ngrounded: ${r.grounded}\n${cited}` }],
        structuredContent: r,
      };
    },
  );

  server.registerTool(
    'ingest_document',
    {
      title: 'Add a document to workspace memory',
      description: 'Split, embed and store a text document in a workspace. Re-ingesting the same source replaces it.',
      inputSchema: { workspace: z.string().min(1), source: z.string().min(1), text: z.string().min(1) },
    },
    async (input) => {
      const r = await rag.ingest(input);
      return { content: [{ type: 'text', text: `Stored ${r.chunks} chunks from "${input.source}" in ${input.workspace}.` }] };
    },
  );

  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  process.stderr.write(`corolet-memory MCP failed: ${err?.stack ?? err}\n`);
  process.exit(1);
});
