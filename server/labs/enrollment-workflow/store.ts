import { isAsyncFunction } from 'node:util/types';
import type {
  WorkflowEvent,
  WorkflowStore,
} from '../../../shared/labs/enrollment-workflow/contract';
import type { LabDatabase } from '../../storage/sqlite';
import { createSqliteApprovalStore } from '../human-approval/store';

export function createSqliteWorkflowStore(database: LabDatabase): WorkflowStore {
  const approval = createSqliteApprovalStore(database, 'enrollment_workflow');
  database.migrate(
    'enrollment-workflow/002-events',
    `
    CREATE TABLE enrollment_workflow_events (
      task_id TEXT NOT NULL REFERENCES enrollment_workflow_tasks(task_id),
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL CHECK (seq > 0),
      event_json TEXT NOT NULL CHECK (json_valid(event_json)),
      PRIMARY KEY (task_id, seq)
    ) STRICT;
  `,
  );
  const select = database.db.prepare(
    'SELECT event_json FROM enrollment_workflow_events WHERE task_id = ? ORDER BY seq',
  );
  const insert = database.db.prepare(
    'INSERT INTO enrollment_workflow_events (task_id, run_id, seq, event_json) VALUES (?, ?, ?, ?)',
  );
  return {
    durability: 'sqlite',
    transaction(operation) {
      if (isAsyncFunction(operation))
        throw new Error('Workflow transaction callbacks must be synchronous.');
      return approval.transaction((transaction) =>
        operation({
          ...transaction,
          getEvents(taskId) {
            return select
              .all(taskId)
              .map((row) => JSON.parse(String(row.event_json)) as WorkflowEvent);
          },
          appendEvent(event) {
            insert.run(event.taskId, event.runId, event.seq, JSON.stringify(event));
          },
        }),
      );
    },
  };
}
