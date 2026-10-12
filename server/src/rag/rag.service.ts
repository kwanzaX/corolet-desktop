import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Chroma } from '@langchain/community/vectorstores/chroma';
import { CloudflareEmbeddings, cloudflareConfigFromEnv, createChatModel } from '../ai/cloudflare.js';
import { RagEngine } from './rag-engine.js';

/** Wires the RagEngine to ChromaDB and Cloudflare Workers AI for the NestJS app and the MCP server. */
@Injectable()
export class RagService implements OnModuleInit {
  private readonly logger = new Logger(RagService.name);
  engine!: RagEngine;

  async onModuleInit() {
    const cf = cloudflareConfigFromEnv();
    const store = new Chroma(new CloudflareEmbeddings(cf), {
      url: process.env.CHROMA_URL ?? 'http://127.0.0.1:8100',
      collectionName: process.env.CHROMA_COLLECTION ?? 'corolet_memory',
      // Cosine space, so 1 - distance is a similarity between 0 and 1.
      collectionMetadata: { 'hnsw:space': 'cosine' },
    });
    this.engine = new RagEngine(store, createChatModel(cf), {
      k: Number(process.env.RAG_K ?? 4),
      minRelevance: Number(process.env.RAG_MIN_RELEVANCE ?? 0.5),
      scoreIsDistance: true,
    });
    this.logger.log(`RAG ready (Chroma ${process.env.CHROMA_URL ?? 'http://127.0.0.1:8100'})`);
  }
}
