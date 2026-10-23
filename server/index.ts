import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { installAguiRoutes } from './agui';
import { installA2uiRoutes } from './a2ui';
import { installMcpRoutes } from './mcp';
import { installChatRoutes } from './chat';
import { installLabRoutes } from './labs/index';
import { allowedOrigins, loadRuntimeConfig, type RuntimeConfig } from '../config/runtime.ts';
import type { LabHealth } from '../shared/instance.ts';

export function createServer(
  config: RuntimeConfig = loadRuntimeConfig(),
  options: { production?: boolean } = {},
) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '128kb' }));

  // This learning server is intentionally local. Reject foreign browser origins.
  const origins = allowedOrigins(config);
  app.use((request, response, next) => {
    const origin = request.headers.origin;
    if (origin && !origins.has(origin)) {
      response.status(403).json({ error: '此学习服务仅接受本地实验台的请求。' });
      return;
    }
    next();
  });

  app.get('/api/health', (_request, response) =>
    response.json({
      status: 'ok',
      mode: 'local-deterministic',
      instanceId: config.instanceId,
      sourceId: config.sourceId,
      protocols: ['AG-UI', 'A2UI', 'MCP Apps'],
    } satisfies LabHealth),
  );
  installChatRoutes(app);
  installAguiRoutes(app);
  installA2uiRoutes(app);
  installMcpRoutes(app);
  installLabRoutes(app);

  if (options.production) {
    const dist = fileURLToPath(new URL('../dist', import.meta.url));
    app.use(express.static(dist));
    app.get('/', (_request, response) => response.sendFile(path.join(dist, 'index.html')));
  }

  app.use((_request, response) => response.status(404).json({ error: '未找到此接口。' }));
  app.use(
    (
      error: Error & { status?: number },
      _request: express.Request,
      response: express.Response,
      _next: express.NextFunction,
    ) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      const status = error.status && error.status >= 400 && error.status < 500 ? error.status : 500;
      console.error(error.message);
      response
        .status(status)
        .json({ error: status === 500 ? '服务端执行失败，请查看终端日志。' : error.message });
    },
  );
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = loadRuntimeConfig();
  const server = createServer(config, { production: process.argv.includes('--production') }).listen(
    config.apiPort,
    '127.0.0.1',
    () => {
      console.log(`Agent UI Lab API: ${config.apiOrigin} (${config.instanceId})`);
      console.log(
        process.argv.includes('--production')
          ? 'Serving production build.'
          : 'Start the frontend with npm run dev:web, or run both with npm run dev.',
      );
    },
  );
  server.on('error', (error) => {
    console.error(`API could not listen on ${config.apiOrigin}: ${error.message}`);
    process.exitCode = 1;
  });
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
