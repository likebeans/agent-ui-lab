import { describe, expect, it } from 'vitest';
import { applyA2uiMessages, resolveA2uiAction } from '../../shared/a2ui';
import type { LabRuntime } from '../../shared/lab-contract';
import type { WorkflowFacts } from '../../shared/labs/enrollment-workflow/contract';
import { createWorkflowService } from '../../shared/labs/enrollment-workflow/engine';
import { createMemoryWorkflowStore } from '../../shared/labs/enrollment-workflow/memory';
import { workflowForm } from '../../shared/labs/enrollment-workflow/surface';
import type { ApprovalCommand } from '../../shared/labs/human-approval/types';
import { readWorkflow, type WorkflowLocator } from '../../src/labs/enrollment-workflow/client';

function fixture() {
  const session = 'restore-form-session';
  const taskId = 'restore-form-task';
  const service = createWorkflowService(createMemoryWorkflowStore());
  const command: ApprovalCommand = {
    taskId,
    commandId: 'restore-form-propose',
    expectedVersion: 0,
    payload: {
      type: 'propose',
      validity: 'standard',
      input: { attendeeName: '示例学员', workshopId: 'agent-ui-basics', seats: 1 },
    },
  };
  const action = resolveA2uiAction(applyA2uiMessages(null, workflowForm(null, taskId))!, 'submit');
  service.command({ teachingSessionId: session }, command, action);
  const value = service.facts({ teachingSessionId: session }, { taskId });
  if (value.status !== 'found') throw new Error('Expected workflow facts');
  const locator: WorkflowLocator = {
    session,
    taskId,
    pending: { session, command, action },
    last: null,
  };
  function runtime(response: WorkflowFacts): LabRuntime {
    return {
      mode: 'local',
      identity: { labId: 'enrollment-workflow' },
      signal: new AbortController().signal,
      request: async () => new Response(JSON.stringify(response)),
      trace() {},
      focusTrace() {},
    };
  }
  return { value, locator, runtime };
}

function changeModel(value: WorkflowFacts, patch: Record<string, unknown>) {
  const message = value.messages.find((entry) => 'updateDataModel' in entry);
  if (!message || !('updateDataModel' in message)) throw new Error('Expected model update');
  Object.assign(message.updateDataModel.value as object, patch);
}

const invalidForms: Array<[string, (value: WorkflowFacts) => void]> = [
  [
    'empty declarations',
    (value) => {
      value.messages = [];
    },
  ],
  [
    'a deleted surface',
    (value) => {
      value.messages.push({
        version: 'v0.9.1',
        deleteSurface: { surfaceId: 'enrollment-workflow-form' },
      });
    },
  ],
  ['a foreign task', (value) => changeModel(value, { taskId: 'other-task' })],
  ['an obsolete version', (value) => changeModel(value, { version: 0 })],
  [
    'content from another proposal',
    (value) =>
      changeModel(value, {
        form: { attendeeName: '另一个提议', workshopId: ['agent-ui-basics'], seats: '3' },
      }),
  ],
  [
    'a missing root',
    (value) => {
      const update = value.messages.find((entry) => 'updateComponents' in entry);
      if (update && 'updateComponents' in update)
        update.updateComponents.components = update.updateComponents.components.filter(
          (entry) => entry.id !== 'root',
        );
    },
  ],
  [
    'an invalid binding',
    (value) => {
      const update = value.messages.find((entry) => 'updateComponents' in entry);
      if (update && 'updateComponents' in update) {
        const field = update.updateComponents.components.find((entry) => entry.id === 'seats');
        if (field?.component === 'TextField') field.value.path = '/form/missing';
      }
    },
  ],
  [
    'an unrelated field binding',
    (value) => {
      const update = value.messages.find((entry) => 'updateComponents' in entry);
      if (update && 'updateComponents' in update) {
        const field = update.updateComponents.components.find((entry) => entry.id === 'seats');
        if (field?.component === 'TextField') field.value.path = '/form/attendeeName';
      }
    },
  ],
];

describe('workflow recovery form validation', () => {
  it('accepts the complete form returned by the workflow engine', async () => {
    const { value, locator, runtime } = fixture();
    expect(await readWorkflow(runtime(value), locator)).toEqual({ kind: 'known', value });
  });

  it.each(invalidForms)(
    'rejects %s without changing the pending command or current facts',
    async (_label, mutate) => {
      const { value, locator, runtime } = fixture();
      const originalFacts = structuredClone(value);
      const originalLocator = structuredClone(locator);
      const malformed = structuredClone(value);
      mutate(malformed);
      expect(await readWorkflow(runtime(malformed), locator)).toMatchObject({ kind: 'unknown' });
      expect(locator).toEqual(originalLocator);
      expect(value).toEqual(originalFacts);
    },
  );
});
