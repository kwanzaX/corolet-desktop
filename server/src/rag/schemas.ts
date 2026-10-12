import { z } from 'zod';

const workspace = z.string().trim().min(1).max(64).regex(/^[\w.-]+$/, 'letters, digits, dot, dash or underscore');

export const IngestSchema = z.object({
  workspace,
  source: z.string().trim().min(1).max(200),
  text: z.string().min(1).max(500_000),
});

export const AskSchema = z.object({
  workspace,
  question: z.string().trim().min(1).max(2_000),
});

export type IngestInput = z.infer<typeof IngestSchema>;
export type AskInput = z.infer<typeof AskSchema>;
