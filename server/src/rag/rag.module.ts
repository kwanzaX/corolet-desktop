import { Module } from '@nestjs/common';
import { RagService } from './rag.service.js';

@Module({ providers: [RagService], exports: [RagService] })
export class RagModule {}
