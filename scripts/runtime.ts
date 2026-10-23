import { concurrently } from 'concurrently';
import { loadRuntimeConfig } from '../config/runtime.ts';
import { assertPortsAvailable, type RuntimeService } from './preflight.ts';

const commands = {
  'dev:server': { command: 'tsx watch server/index.ts', name: 'api', prefixColor: 'cyan' },
  'dev:web': { command: 'vite', name: 'web', prefixColor: 'magenta' },
  start: { command: 'tsx server/index.ts --production', name: 'api', prefixColor: 'cyan' },
  preview: { command: 'vite preview', name: 'preview', prefixColor: 'magenta' },
};

async function main() {
  const [requestedCommand, ...extra] = process.argv.slice(2);
  const command = requestedCommand === 'preview:pages' ? 'preview' : requestedCommand;
  if (extra.length || (command !== 'dev' && !Object.hasOwn(commands, command ?? ''))) {
    throw new Error(
      'Choose dev, dev:server, dev:web, start or preview; configure ports with LAB_*_PORT.',
    );
  }
  const config = loadRuntimeConfig();
  const services: RuntimeService[] =
    command === 'dev'
      ? ['api', 'web']
      : [command === 'dev:web' ? 'web' : command === 'preview' ? 'preview' : 'api'];
  await assertPortsAvailable(config, services);
  console.log(`Agent UI Lab instance: ${config.instanceId}`);
  const selected =
    command === 'dev'
      ? [commands['dev:server'], commands['dev:web']]
      : [commands[command as keyof typeof commands]];
  const { result } = concurrently(
    selected.map((entry) => ({ ...entry, env: config.environment })),
    {
      cwd: config.rootDir,
      prefix: selected.length > 1 ? 'name' : 'none',
      killOthersOn: ['failure', 'success'],
    },
  );
  await result;
}

void main().catch((error: unknown) => {
  if (error instanceof Error) console.error(error.message);
  process.exitCode = 1;
});
