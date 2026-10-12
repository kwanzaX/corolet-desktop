import { Logger } from '@nestjs/common';
import { ConnectedSocket, MessageBody, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import { RagService } from '../rag/rag.service.js';
import { AskSchema } from '../rag/schemas.js';

/**
 * Real-time answers over Socket.IO. The client emits `ask` with an id; the server
 * streams `sources`, then `token` events, then `done`, all tagged with that id so
 * several questions can be in flight on one connection. `cancel` stops one early.
 */
@WebSocketGateway({ cors: { origin: (process.env.CORS_ORIGINS ?? '*').split(',') } })
export class ChatGateway {
  private readonly logger = new Logger(ChatGateway.name);
  private readonly running = new Map<string, { cancelled: boolean }>();

  constructor(private readonly rag: RagService) {}

  @SubscribeMessage('ask')
  async ask(@ConnectedSocket() socket: Socket, @MessageBody() body: { id?: string; workspace?: string; question?: string }) {
    const id = String(body?.id ?? '');
    const parsed = AskSchema.safeParse(body);
    if (!id || !parsed.success) {
      socket.emit('error', { id, message: 'Send { id, workspace, question }.' });
      return;
    }
    const key = `${socket.id}:${id}`;
    const state = { cancelled: false };
    this.running.set(key, state);
    try {
      for await (const ev of this.rag.engine.answer(parsed.data.workspace, parsed.data.question)) {
        if (state.cancelled) break;
        socket.emit(ev.type, { id, ...ev });
      }
      if (state.cancelled) socket.emit('done', { id, type: 'done', grounded: false, cancelled: true });
    } catch (err: any) {
      this.logger.warn(`ask ${id} failed: ${err?.message}`);
      socket.emit('error', { id, message: 'The answer could not be generated. Try again.' });
    } finally {
      this.running.delete(key);
    }
  }

  @SubscribeMessage('cancel')
  cancel(@ConnectedSocket() socket: Socket, @MessageBody() body: { id?: string }) {
    const state = this.running.get(`${socket.id}:${body?.id}`);
    if (state) state.cancelled = true;
  }
}
