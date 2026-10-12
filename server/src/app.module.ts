import { Module } from '@nestjs/common';
import { ChatGateway } from './chat/chat.gateway.js';
import { DocumentsController } from './rag/documents.controller.js';
import { RagModule } from './rag/rag.module.js';

@Module({
  imports: [RagModule],
  controllers: [DocumentsController],
  providers: [ChatGateway],
})
export class AppModule {}
