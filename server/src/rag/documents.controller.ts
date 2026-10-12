import { BadRequestException, Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import type { ZodTypeAny, z } from 'zod';
import { RagService } from './rag.service.js';
import { AskSchema, IngestSchema } from './schemas.js';

function parse<S extends ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const r = schema.safeParse(body);
  if (!r.success) throw new BadRequestException(r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  return r.data;
}

@Controller()
export class DocumentsController {
  constructor(private readonly rag: RagService) {}

  @Get('health')
  health() {
    return { ok: true };
  }

  @Post('documents')
  async ingest(@Body() body: unknown) {
    return this.rag.engine.ingest(parse(IngestSchema, body));
  }

  @Post('ask')
  @HttpCode(200)
  async ask(@Body() body: unknown) {
    const { workspace, question } = parse(AskSchema, body);
    return this.rag.engine.ask(workspace, question);
  }
}
