import { z } from 'zod';
import { WORKSHOPS } from './types';
import type { FieldErrors } from './types';

// Preserve values: whitespace changes are different commands, even for a valid name.
const identifier = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u, '标识必须是 1–128 位字母、数字或 . _ : -。');
const version = z.int().nonnegative();
const proposalVersion = z.int().positive();

export const enrollmentInputSchema = z.strictObject({
  attendeeName: z
    .string()
    .max(80, '报名姓名不能超过 80 个字符。')
    .refine((value) => value.trim().length > 0, '请填写报名姓名。'),
  workshopId: z.enum(
    WORKSHOPS.map((workshop) => workshop.id),
    '请选择有效的工作坊。',
  ),
  seats: z
    .int('报名人数必须是整数。')
    .min(1, '报名人数必须大于零。')
    .max(6, '报名人数不能超过 6 人。'),
});

export const approvalContextSchema = z.strictObject({ teachingSessionId: identifier });

export const approvalCommandSchema = z.strictObject({
  commandId: identifier,
  taskId: identifier,
  expectedVersion: version,
  payload: z.discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('propose'),
      input: enrollmentInputSchema,
      validity: z.enum(['standard', 'short']),
    }),
    z.strictObject({
      type: z.literal('edit'),
      proposalId: identifier,
      proposalVersion,
      input: enrollmentInputSchema,
    }),
    z.strictObject({ type: z.literal('approve'), proposalId: identifier, proposalVersion }),
    z.strictObject({ type: z.literal('reject'), proposalId: identifier, proposalVersion }),
  ]),
});

export const approvalFactsQuerySchema = z.strictObject({
  taskId: identifier,
  commandId: identifier.optional(),
});

export function enrollmentFieldErrors(error: z.ZodError): FieldErrors | undefined {
  const fields: FieldErrors = {};
  for (const issue of error.issues) {
    if (issue.path[0] !== 'payload' || issue.path[1] !== 'input') continue;
    const field = issue.path[2];
    if (field === 'attendeeName' || field === 'workshopId' || field === 'seats') {
      fields[field] ??= issue.message;
    }
  }
  return Object.keys(fields).length > 0 ? fields : undefined;
}

// JSON object property order has no semantic meaning. No value normalization is performed.
export function approvalCommandFingerprint(command: unknown): string {
  return JSON.stringify(command, (_key, value: unknown) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const object = value as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(object)
          .sort()
          .map((key) => [key, object[key]]),
      );
    }
    return value;
  });
}
