import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { openLabDatabase, type LabDatabase } from '../../server/storage/sqlite';

const directories: string[] = [];
const databases: LabDatabase[] = [];
function open() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'lab-w1-sqlite-'));
  directories.push(dataDir);
  const database = openLabDatabase({ dataDir });
  databases.push(database);
  return { database, dataDir };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const migration = 'CREATE TABLE counters (id TEXT PRIMARY KEY, value INTEGER NOT NULL);';

describe('shared SQLite transactions', () => {
  it('persists committed data across close/reopen and verifies migration checksums', () => {
    const { database, dataDir } = open();
    database.migrate('test/counters-v1', migration);
    database.migrate('test/counters-v1', migration);
    database.transaction((db) => {
      db.prepare('INSERT INTO counters VALUES (?, ?)').run('tools', 1);
    });
    expect(() => database.migrate('test/counters-v1', `${migration}\n`)).toThrow(/changed/u);
    database.close();
    const restored = openLabDatabase({ dataDir });
    databases.push(restored);
    expect(restored.db.prepare('SELECT value FROM counters WHERE id = ?').get('tools')?.value).toBe(
      1,
    );
  });

  it('rolls back a partially applied migration and retries it cleanly', () => {
    const { database } = open();
    expect(() =>
      database.migrate('test/atomic', `${migration} INSERT INTO missing VALUES (1);`),
    ).toThrow();
    expect(
      database.db.prepare("SELECT name FROM sqlite_master WHERE name = 'counters'").get(),
    ).toBeUndefined();
    database.migrate('test/atomic', migration);
    expect(
      database.db.prepare("SELECT name FROM sqlite_master WHERE name = 'counters'").get(),
    ).toBeDefined();
  });

  it('rolls back nested work without losing the outer transaction', () => {
    const { database } = open();
    database.migrate('test/counters-v1', migration);
    database.transaction((db) => {
      db.prepare('INSERT INTO counters VALUES (?, ?)').run('outer', 1);
      expect(() =>
        database.transaction((nested) => {
          nested.prepare('INSERT INTO counters VALUES (?, ?)').run('inner', 2);
          throw new Error('stop inner');
        }),
      ).toThrow('stop inner');
      db.prepare('UPDATE counters SET value = 3 WHERE id = ?').run('outer');
    });
    expect(database.db.prepare('SELECT * FROM counters').all()).toEqual([
      { id: 'outer', value: 3 },
    ]);
    expect(() =>
      database.transaction((db) => {
        database.transaction((inner) =>
          inner.prepare('INSERT INTO counters VALUES (?, ?)').run('inner', 5),
        );
        db.prepare('UPDATE counters SET value = 9').run();
        throw new Error('stop outer');
      }),
    ).toThrow('stop outer');
    expect(database.db.prepare('SELECT * FROM counters').all()).toEqual([
      { id: 'outer', value: 3 },
    ]);
  });

  it('rejects asynchronous callbacks before any continuation can commit writes', async () => {
    const { database, dataDir } = open();
    database.migrate('test/counters-v1', migration);
    let invoked = false;
    expect(() =>
      // @ts-expect-error Runtime guard also rejects callers that bypass the synchronous type.
      database.transaction(async (db) => {
        invoked = true;
        db.prepare('INSERT INTO counters VALUES (?, ?)').run('before_await', 1);
        await Promise.resolve();
        db.prepare('INSERT INTO counters VALUES (?, ?)').run('after_await', 2);
      }),
    ).toThrow(/synchronous/u);
    await nextTurn();
    expect(invoked).toBe(false);
    expect(database.db.prepare('SELECT * FROM counters').all()).toEqual([]);
    database.close();
    const restored = openLabDatabase({ dataDir });
    databases.push(restored);
    expect(restored.db.prepare('SELECT * FROM counters').all()).toEqual([]);
  });

  it('rolls back synchronous writes when a non-async callback returns a thenable', () => {
    const { database } = open();
    database.migrate('test/counters-v1', migration);
    expect(() =>
      // @ts-expect-error Keep the runtime thenable guard for untyped callers.
      database.transaction((db) => {
        db.prepare('INSERT INTO counters VALUES (?, ?)').run('thenable', 1);
        return Promise.resolve();
      }),
    ).toThrow(/synchronous/u);
    expect(database.db.prepare('SELECT * FROM counters').all()).toEqual([]);
  });

  it('uses immediate transactions across two connections and enables foreign keys', () => {
    const { database, dataDir } = open();
    database.migrate('test/counters-v1', migration);
    const other = openLabDatabase({ dataDir });
    databases.push(other);
    other.db.exec('PRAGMA busy_timeout = 1');
    expect(database.db.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
    database.transaction(() => {
      expect(() => other.transaction(() => {})).toThrow(/locked/u);
    });
    expect(() => other.transaction(() => {})).not.toThrow();
  });

  it('does not accept a filename that escapes the data directory', () => {
    const { dataDir } = open();
    expect(() => openLabDatabase({ dataDir, filename: '../escape.sqlite' })).toThrow(
      /plain filename/u,
    );
  });
});
