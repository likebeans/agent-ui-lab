import { z } from 'zod';
import type { CompatibilityReply } from './contract';

const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const fieldIssue = z.object({
  componentId: z.string(),
  path: z.string(),
  message: z.string(),
  layer: z.enum(['client', 'server']),
});
const snapshot = z.object({
  documentId: z.string().min(1),
  revision: integer.min(1),
  surfaceId: z.string().min(1),
  scenario: z.enum(['standard', 'unknown-catalog', 'unknown-component']),
  // Message compatibility is checked separately so unsupported catalogs/components
  // still reach the lab's text fallback.
  messages: z.array(z.unknown()),
  rules: z.array(
    z.object({
      componentId: z.string(),
      path: z.string(),
      label: z.string(),
      required: z.boolean().optional(),
      maxLength: integer.optional(),
      integer: z.object({ min: integer, max: integer }).optional(),
    }),
  ),
  fallbackText: z.string(),
  acceptedActions: integer,
});
const replySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('snapshot'), snapshot }),
  z.object({ kind: z.literal('accepted'), snapshot }),
  z.object({
    kind: z.literal('conflict'),
    code: z.enum(['revision-mismatch', 'surface-mismatch', 'document-exists']),
    message: z.string(),
    snapshot,
  }),
  z.object({ kind: z.literal('invalid'), message: z.string(), issues: z.array(fieldIssue) }),
  z.object({ kind: z.literal('not-found'), message: z.string() }),
]);
const statuses: Record<CompatibilityReply['kind'], number> = {
  snapshot: 200,
  accepted: 200,
  conflict: 409,
  invalid: 400,
  'not-found': 404,
};

export async function readCompatibilityReply(response: Response): Promise<CompatibilityReply> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    // Preserve aborts and timeouts so the lab can explain an uncertain outcome.
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error(`HTTP ${response.status}：响应不是有效的 JSON。`);
  }
  const parsed = replySchema.safeParse(body);
  if (parsed.success && response.status === statuses[parsed.data.kind]) return parsed.data;

  const generic = z.object({ error: z.string().min(1) }).safeParse(body);
  const detail = generic.success
    ? generic.data.error
    : parsed.success
      ? '响应状态与应用结果不一致。'
      : '响应格式无效，无法确认应用结果。';
  throw new Error(`HTTP ${response.status}：${detail}`);
}
