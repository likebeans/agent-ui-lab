import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export const PROJECT_ROOT = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
export type LabEnvironment = Record<string, string | undefined>;

export interface RuntimeConfig {
  rootDir: string;
  webPort: number;
  apiPort: number;
  previewPort: number;
  webOrigin: string;
  apiOrigin: string;
  previewOrigin: string;
  instanceId: string;
  sourceId?: string;
  dataDir: string;
  environment: Record<string, string>;
}

function envLayer(environment: LabEnvironment): Record<string, string> {
  const layer = Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  // Resolve PORT inside each layer so a process PORT overrides file settings.
  if (layer.LAB_API_PORT === undefined && layer.PORT !== undefined) layer.LAB_API_PORT = layer.PORT;
  return layer;
}

function readEnvFile(filename: string): Record<string, string> {
  try {
    return envLayer(parseEnv(readFileSync(filename, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

export function loadLabEnvironment(
  rootDir = PROJECT_ROOT,
  environment: LabEnvironment = process.env,
): Record<string, string> {
  return {
    ...readEnvFile(path.join(rootDir, '.env')),
    ...readEnvFile(path.join(rootDir, '.env.local')),
    ...envLayer(environment),
  };
}

function port(environment: LabEnvironment, name: string, fallback: number): number {
  const value = environment[name] ?? String(fallback);
  if (!/^[1-9]\d{0,4}$/u.test(value) || Number(value) > 65535)
    throw new Error(
      `${name} must be an integer between 1 and 65535; received ${JSON.stringify(value)}.`,
    );
  return Number(value);
}

function sourceId(rootDir: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
  } catch {
    return undefined;
  }
}

export function resolveRuntimeConfig(
  environment: LabEnvironment,
  rootDir = PROJECT_ROOT,
): RuntimeConfig {
  const root = realpathSync(rootDir);
  const normalized = envLayer(environment);
  const webPort = port(normalized, 'LAB_WEB_PORT', 5173);
  const apiPort = port(normalized, 'LAB_API_PORT', 3100);
  const previewPort = port(normalized, 'LAB_PREVIEW_PORT', 4173);
  if (new Set([webPort, apiPort, previewPort]).size !== 3)
    throw new Error('LAB_WEB_PORT, LAB_API_PORT and LAB_PREVIEW_PORT must be different ports.');
  const instanceId =
    normalized.LAB_INSTANCE_ID ??
    `lab-${createHash('sha256').update(root).digest('hex').slice(0, 12)}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(instanceId))
    throw new Error(
      'LAB_INSTANCE_ID must contain 1–64 letters, digits, dots, underscores or hyphens, starting with a letter or digit.',
    );
  const dataDir = normalized.LAB_DATA_DIR ?? '.lab-data';
  if (!dataDir.trim() || dataDir.includes('\0'))
    throw new Error('LAB_DATA_DIR must be a non-empty path without null characters.');
  const config: RuntimeConfig = {
    rootDir: root,
    webPort,
    apiPort,
    previewPort,
    webOrigin: `http://127.0.0.1:${webPort}`,
    apiOrigin: `http://127.0.0.1:${apiPort}`,
    previewOrigin: `http://127.0.0.1:${previewPort}`,
    instanceId,
    sourceId: sourceId(root),
    dataDir: path.resolve(root, dataDir),
    environment: normalized,
  };
  config.environment = { ...normalized, ...runtimeEnvironment(config) };
  return config;
}

export function loadRuntimeConfig(
  options: { rootDir?: string; env?: LabEnvironment } = {},
): RuntimeConfig {
  const rootDir = options.rootDir ?? PROJECT_ROOT;
  return resolveRuntimeConfig(loadLabEnvironment(rootDir, options.env ?? process.env), rootDir);
}

export function runtimeEnvironment(config: RuntimeConfig): Record<string, string> {
  return {
    LAB_WEB_PORT: String(config.webPort),
    LAB_API_PORT: String(config.apiPort),
    LAB_PREVIEW_PORT: String(config.previewPort),
    LAB_INSTANCE_ID: config.instanceId,
    LAB_DATA_DIR: config.dataDir,
    PORT: String(config.apiPort),
  };
}

export function allowedOrigins(config: RuntimeConfig): Set<string> {
  return new Set(
    [config.webPort, config.apiPort, config.previewPort].flatMap((value) => [
      `http://127.0.0.1:${value}`,
      `http://localhost:${value}`,
    ]),
  );
}

export function reuseExistingServer(environment: LabEnvironment): boolean {
  const value = environment.LAB_REUSE_EXISTING_SERVER ?? '0';
  if (value !== '0' && value !== '1') throw new Error('LAB_REUSE_EXISTING_SERVER must be 0 or 1.');
  return value === '1';
}
