import type { LabDatabase } from '../../storage/sqlite';

export function migrateApprovalStore(database: LabDatabase): void {
  database.migrate(
    'human-approval/001-initial',
    `
      CREATE TABLE human_approval_tasks (
        task_id TEXT PRIMARY KEY,
        teaching_session_id TEXT NOT NULL,
        snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
        UNIQUE (task_id, teaching_session_id)
      ) STRICT;

      CREATE TABLE human_approval_commands (
        teaching_session_id TEXT NOT NULL,
        command_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        command_json TEXT NOT NULL CHECK (json_valid(command_json)),
        PRIMARY KEY (teaching_session_id, command_id)
      ) STRICT;

      CREATE TABLE human_approval_enrollments (
        enrollment_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL UNIQUE,
        proposal_id TEXT NOT NULL UNIQUE,
        teaching_session_id TEXT NOT NULL,
        enrollment_json TEXT NOT NULL CHECK (json_valid(enrollment_json)),
        FOREIGN KEY (task_id, teaching_session_id)
          REFERENCES human_approval_tasks (task_id, teaching_session_id)
      ) STRICT;
    `,
  );
}
