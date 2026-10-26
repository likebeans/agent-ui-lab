import { createMemoryApprovalStore } from '../human-approval/memory';
import type { WorkflowEvent, WorkflowStore } from './contract';

export function createMemoryWorkflowStore(): WorkflowStore {
  const approval = createMemoryApprovalStore();
  let events = new Map<string, WorkflowEvent[]>();
  let active: { events: Map<string, WorkflowEvent[]> } | undefined;
  return {
    durability: 'memory',
    transaction(operation) {
      if (Object.prototype.toString.call(operation) === '[object AsyncFunction]')
        throw new Error('Workflow transaction callbacks must be synchronous.');
      const parent = active;
      const frame = { events: structuredClone(parent?.events ?? events) };
      active = frame;
      try {
        const result = approval.transaction((transaction) =>
          operation({
            ...transaction,
            getEvents(taskId) {
              return structuredClone(frame.events.get(taskId) ?? []);
            },
            appendEvent(event) {
              if (!transaction.getTask(event.taskId)) throw new Error('事件对应的任务不存在。');
              const list = frame.events.get(event.taskId) ?? [];
              if (event.seq !== list.length + 1) throw new Error('事件序号必须连续。');
              list.push(structuredClone(event));
              frame.events.set(event.taskId, list);
            },
          }),
        );
        if (parent) parent.events = frame.events;
        else events = frame.events;
        return result;
      } finally {
        active = parent;
      }
    },
  };
}
