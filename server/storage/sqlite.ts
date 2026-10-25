import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isAsyncFunction } from 'node:util/types';

type SynchronousResult<T> = T extends PromiseLike<unknown> ? never : T;

export interface LabDatabase {
  readonly db: DatabaseSync;
  transaction<T>(operation: (db: DatabaseSync) => SynchronousResult<T>): T;
  migrate(id: string, sql: string): void;
  close(): void;
}

export function openLabDatabase(options: { dataDir: string; filename?: string }): LabDatabase {
  const filename = options.filename ?? 'lab.sqlite';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(filename))
    throw new Error('SQLite filename must be a plain filename within the data directory.');
  mkdirSync(options.dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(options.dataDir, filename));
  let depth = 0;
  let serial = 0;
  let closed = false;

  const database: LabDatabase = {
    db,
    transaction<T>(operation: (connection: DatabaseSync) => SynchronousResult<T>): T {
      if (closed) throw new Error('SQLite database is closed.');
      if (isAsyncFunction(operation))
        throw new Error('SQLite transaction callbacks must be synchronous.');
      const nested = depth > 0;
      const savepoint = `lab_transaction_${++serial}`;
      db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
      depth += 1;
      try {
        const result = operation(db);
        if (
          result !== null &&
          (typeof result === 'object' || typeof result === 'function') &&
          typeof (result as { then?: unknown }).then === 'function'
        ) {
          // A synchronous transaction must never commit before asynchronous work finishes.
          void Promise.resolve(result).catch(() => {});
          throw new Error('SQLite transaction callbacks must be synchronous.');
        }
        db.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT');
        return result;
      } catch (error) {
        try {
          db.exec(nested ? `ROLLBACK TO SAVEPOINT ${savepoint}` : 'ROLLBACK');
          if (nested) db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'SQLite transaction rollback failed.');
        }
        throw error;
      } finally {
        depth -= 1;
      }
    },
    migrate(id, sql) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/u.test(id))
        throw new Error('SQLite migration id is invalid.');
      if (!sql.trim()) throw new Error('SQLite migration SQL must not be empty.');
      const checksum = createHash('sha256').update(sql).digest('hex');
      database.transaction(() => {
        const existing = db.prepare('SELECT checksum FROM lab_migrations WHERE id = ?').get(id);
        if (existing) {
          if (existing.checksum !== checksum)
            throw new Error(`SQLite migration ${id} has changed since it was applied.`);
          return;
        }
        db.exec(sql);
        db.prepare('INSERT INTO lab_migrations (id, checksum) VALUES (?, ?)').run(id, checksum);
      });
    },
    close() {
      if (closed) return;
      if (depth > 0) throw new Error('Cannot close SQLite during a transaction.');
      db.close();
      closed = true;
    },
  };

  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS lab_migrations (
        id TEXT PRIMARY KEY,
        checksum TEXT NOT NULL
      );
    `);
    return database;
  } catch (error) {
    db.close();
    throw error;
  }
}
