import { z } from 'zod';
import type { LabMode } from '../lab-contract';

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u);

/** Portable query identity only. Commands, drafts and business facts never belong here. */
export const taskLocatorSchema = z.strictObject({
  version: z.literal(1),
  labId: z.enum(['human-approval', 'enrollment-workflow']),
  mode: z.enum(['local', 'pages']),
  teachingSessionId: identifier,
  taskId: identifier,
});
export type TaskLocator = z.infer<typeof taskLocatorSchema>;
export type TaskLocatorScope = { labId: TaskLocator['labId']; mode: LabMode };

export function validateTaskLocator(value: unknown, scope: TaskLocatorScope): TaskLocator {
  const parsed = taskLocatorSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(
      '定位信息格式不符合版本 1 契约。只接受 version、labId、mode、teachingSessionId 和 taskId；请复制完整定位 JSON，不要加入草稿、快照或命令。',
    );
  if (parsed.data.labId !== scope.labId)
    throw new Error('定位信息属于另一个实验。请回到对应实验打开，当前任务与草稿保持不变。');
  if (parsed.data.mode !== scope.mode)
    throw new Error(
      '定位信息的运行模式不匹配。本地与 Pages 不能互相恢复，当前任务与草稿保持不变。',
    );
  return parsed.data;
}

export function parseTaskLocator(text: string, scope: TaskLocatorScope): TaskLocator {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('定位信息不是有效 JSON。请粘贴完整的任务定位信息。');
  }
  return validateTaskLocator(value, scope);
}

export function formatTaskLocator(locator: TaskLocator): string {
  return JSON.stringify(taskLocatorSchema.parse(locator), null, 2);
}
