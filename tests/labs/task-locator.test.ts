import { describe, expect, it } from 'vitest';
import {
  formatTaskLocator,
  parseTaskLocator,
  validateTaskLocator,
  type TaskLocator,
} from '../../shared/labs/task-locator';

const locator: TaskLocator = {
  version: 1,
  labId: 'human-approval',
  mode: 'local',
  teachingSessionId: 'session-1',
  taskId: 'task-1',
};
const scope = { labId: locator.labId, mode: locator.mode };

describe('portable query locator contract', () => {
  it.each(['human-approval', 'enrollment-workflow'] as const)(
    'round trips only the five query identity fields for %s in either mode',
    (labId) => {
      for (const mode of ['local', 'pages'] as const) {
        const value = { ...locator, labId, mode };
        expect(parseTaskLocator(formatTaskLocator(value), { labId, mode })).toEqual(value);
        expect(Object.keys(JSON.parse(formatTaskLocator(value)))).toEqual([
          'version',
          'labId',
          'mode',
          'teachingSessionId',
          'taskId',
        ]);
      }
    },
  );

  it.each([
    null,
    [],
    'task-1',
    {},
    { ...locator, version: 2 },
    { ...locator, mode: 'preview' },
    { ...locator, labId: 'task-recovery' },
    { ...locator, teachingSessionId: '' },
    { ...locator, taskId: ' task-1' },
    { ...locator, taskId: 'a'.repeat(129) },
    { ...locator, taskId: null },
    { ...locator, task: {} },
    { ...locator, pending: null },
    { ...locator, command: { type: 'propose' } },
    { ...locator, draft: { attendeeName: 'should-not-travel' } },
  ])('rejects a malformed or extended identity without mutating it', (value) => {
    const before = structuredClone(value);
    expect(() => validateTaskLocator(value, scope)).toThrow('契约');
    expect(value).toEqual(before);
  });

  it('reports malformed JSON separately from the identity contract', () => {
    expect(() => parseTaskLocator('{', scope)).toThrow('有效 JSON');
    expect(() => parseTaskLocator('', scope)).toThrow('有效 JSON');
  });

  it('rejects cross-lab and cross-mode identities without changing the original', () => {
    const before = structuredClone(locator);
    expect(() => parseTaskLocator(JSON.stringify(locator), { ...scope, mode: 'pages' })).toThrow(
      '运行模式不匹配',
    );
    expect(() => validateTaskLocator(locator, { ...scope, labId: 'enrollment-workflow' })).toThrow(
      '另一个实验',
    );
    expect(locator).toEqual(before);
  });
});
