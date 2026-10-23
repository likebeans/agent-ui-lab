import { createServer, type Server } from 'node:net';
import type { RuntimeConfig } from '../config/runtime.ts';

export type RuntimeService = 'web' | 'api' | 'preview';

// Hold every requested port until all checks succeed, then hand them to the strict listeners.
export async function assertPortsAvailable(
  config: RuntimeConfig,
  services: RuntimeService[],
): Promise<void> {
  const reservations: Server[] = [];
  try {
    for (const service of services) {
      const port = config[`${service}Port`];
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once('error', (error: NodeJS.ErrnoException) => {
          reject(
            new Error(
              `${service} port ${port} is unavailable (${error.code ?? error.message}). Set LAB_${service.toUpperCase()}_PORT to a free port.`,
            ),
          );
        });
        server.listen(port, '127.0.0.1', () => {
          reservations.push(server);
          resolve();
        });
      });
    }
  } finally {
    await Promise.all(
      reservations.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  }
}
