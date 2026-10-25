import path from 'node:path';
import { build, createServer as createViteServer, preview } from 'vite';
import { loadRuntimeConfig } from '../../../config/runtime';
import { createServer } from '../../../server';

// The standalone suite uses the same route registrations as the normal application.
const config = loadRuntimeConfig();
const pages = process.env.LAB_RECOVERY_TEST_MODE === 'pages';
const configFile = path.join(config.rootDir, 'vite.config.ts');
let stopping = false;
const cleanups: Array<() => void | Promise<void>> = [];

async function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const cleanup of cleanups.reverse()) await cleanup();
  process.exit(0);
}
process.once('SIGTERM', () => {
  void shutdown();
});
process.once('SIGINT', () => {
  void shutdown();
});

try {
  if (pages) {
    const outDir = path.join(config.dataDir, 'pages-browser-build');
    await build({ configFile, mode: 'pages', build: { outDir } });
    const site = await preview({ configFile, mode: 'pages', build: { outDir } });
    cleanups.push(
      () =>
        new Promise<void>((resolve, reject) => {
          site.httpServer.close((error) => (error ? reject(error) : resolve()));
          if ('closeAllConnections' in site.httpServer) site.httpServer.closeAllConnections();
        }),
    );
    console.log(
      `W1 Pages fixture: ${config.previewOrigin}${config.environment.PAGES_BASE_PATH ?? '/'}`,
    );
  } else {
    const app = createServer(config);
    cleanups.push(() => app.locals.closeLabs());
    const server = app.listen(config.apiPort, '127.0.0.1');
    cleanups.push(() => {
      app.locals.closeLabs();
      server.closeAllConnections();
      return new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const site = await createViteServer({ configFile });
    cleanups.push(() => site.close());
    await site.listen();
    console.log(`W1 task-recovery: ${config.webOrigin}/#labs/task-recovery (${config.instanceId})`);
  }
} catch (error) {
  console.error(error);
  for (const cleanup of cleanups.reverse()) await cleanup();
  process.exit(1);
}
