import express from 'express';
import type { AddressInfo } from 'node:net';
import { createTaskRecoveryRouter } from '../../server/labs/task-recovery';
import { openLabDatabase } from '../../server/storage/sqlite';
import { RECOVERY_API } from '../../shared/labs/task-recovery/contract';

const dataDir = process.argv[2];
if (!dataDir) throw new Error('A data directory is required.');
const database = openLabDatabase({ dataDir });
const adapter = createTaskRecoveryRouter({ database, stepDelayMs: Number(process.argv[3] ?? 80) });
const app = express();
app.use(express.json({ limit: '128kb' }));
app.use(RECOVERY_API, adapter.router);
const server = app.listen(0, '127.0.0.1', () => {
  process.send?.({
    type: 'ready',
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}${RECOVERY_API}`,
    pid: process.pid,
  });
});

function close() {
  adapter.close();
  server.closeAllConnections();
  server.close(() => {
    database.close();
    process.disconnect?.();
  });
}
process.once('SIGTERM', close);
process.once('SIGINT', close);
