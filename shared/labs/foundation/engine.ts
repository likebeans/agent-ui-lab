import { z } from 'zod';

export const foundationInput = z
  .object({
    text: z.string().trim().min(1, '请输入要观察的内容。').max(120),
  })
  .strict();

export function runFoundation(input: unknown) {
  const { text } = foundationInput.parse(input);
  return { text, characters: [...text].length, engine: 'deterministic-fixture' as const };
}
