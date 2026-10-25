import type { SQLOutputValue } from 'node:sqlite';
import { isAsyncFunction } from 'node:util/types';
import type { ApprovalStore, ApprovalTransaction } from '../../../shared/labs/human-approval/ports';
import type {
  ApprovalTask,
  Enrollment,
  StoredApprovalCommand,
} from '../../../shared/labs/human-approval/types';
import type { LabDatabase } from '../../storage/sqlite';
import { migrateApprovalStore } from './migrations';

function readJson<Value>(row: Record<string, SQLOutputValue> | undefined): Value | null {
  return row ? (JSON.parse(row.value as string) as Value) : null;
}

export function createSqliteApprovalStore(database: LabDatabase): ApprovalStore {
  migrateApprovalStore(database);
  const getTask = database.db.prepare(
    'SELECT snapshot_json AS value FROM human_approval_tasks WHERE task_id = ?',
  );
  const putTask = database.db.prepare(`
    INSERT INTO human_approval_tasks (task_id, teaching_session_id, snapshot_json)
    VALUES (?, ?, ?)
    ON CONFLICT (task_id) DO UPDATE SET snapshot_json = excluded.snapshot_json
    WHERE human_approval_tasks.teaching_session_id = excluded.teaching_session_id
  `);
  const getCommand = database.db.prepare(`
    SELECT command_json AS value FROM human_approval_commands
    WHERE teaching_session_id = ? AND command_id = ?
  `);
  const putCommand = database.db.prepare(`
    INSERT INTO human_approval_commands
      (teaching_session_id, command_id, task_id, command_json)
    VALUES (?, ?, ?, ?)
  `);
  const getEnrollment = database.db.prepare(
    'SELECT enrollment_json AS value FROM human_approval_enrollments WHERE task_id = ?',
  );
  const putEnrollment = database.db.prepare(`
    INSERT INTO human_approval_enrollments
      (enrollment_id, task_id, proposal_id, teaching_session_id, enrollment_json)
    VALUES (?, ?, ?, ?, ?)
  `);

  const transaction: ApprovalTransaction = {
    getTask(taskId) {
      return readJson<ApprovalTask>(getTask.get(taskId));
    },
    putTask(task) {
      const result = putTask.run(
        task.taskId,
        task.state.proposal.teachingSessionId,
        JSON.stringify(task),
      );
      if (result.changes !== 1) throw new Error('Cannot change an approval task teaching session.');
    },
    getCommand(teachingSessionId, commandId) {
      return readJson<StoredApprovalCommand>(getCommand.get(teachingSessionId, commandId));
    },
    putCommand(command) {
      putCommand.run(
        command.teachingSessionId,
        command.commandId,
        command.taskId,
        JSON.stringify(command),
      );
    },
    getEnrollment(taskId) {
      return readJson<Enrollment>(getEnrollment.get(taskId));
    },
    putEnrollment(enrollment) {
      putEnrollment.run(
        enrollment.enrollmentId,
        enrollment.taskId,
        enrollment.proposalId,
        enrollment.teachingSessionId,
        JSON.stringify(enrollment),
      );
    },
  };

  return {
    durability: 'sqlite',
    transaction(operation) {
      // The wrapper below hides the original callback from the database's async guard.
      if (isAsyncFunction(operation))
        throw new Error('Approval transaction callbacks must be synchronous.');
      return database.transaction(() => operation(transaction));
    },
  };
}
