import { mkdtempSync, existsSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer as createSocketServer, type AddressInfo, type Server } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { allowedOrigins, loadRuntimeConfig } from '../config/runtime.ts';
import { assertLocalInstance } from '../config/health.ts';
import { createServer } from '../server/index.ts';
import { LAB_INSTANCE_ID, isExpectedInstance, isLabHealth } from '../shared/instance.ts';
import { assertPortsAvailable } from '../scripts/preflight.ts';
import viteConfig from '../vite.config.ts';

const temporaryDirectories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true });
});

function directory(): string {
  const rootDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'lab-runtime-')));
  temporaryDirectories.push(rootDir);
  return rootDir;
}

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return (server.address() as AddressInfo).port;
}

describe('explicit runtime configuration', () => {
  it('loads only .env and .env.local with process environment taking precedence', () => {
    const rootDir = directory();
    writeFileSync(
      path.join(rootDir, '.env'),
      'LAB_WEB_PORT=25173\nLAB_API_PORT=25100\nLAB_PREVIEW_PORT=25174\nLAB_INSTANCE_ID=base\nLAB_DATA_DIR=base-data\n',
    );
    writeFileSync(
      path.join(rootDir, '.env.local'),
      'LAB_WEB_PORT=26173\nLAB_INSTANCE_ID=local\nLAB_DATA_DIR="local data"\n',
    );
    writeFileSync(path.join(rootDir, '.env.production'), 'LAB_API_PORT=27100\n');
    const config = loadRuntimeConfig({
      rootDir,
      env: { LAB_WEB_PORT: '28173', LAB_INSTANCE_ID: 'shell' },
    });
    expect(config).toMatchObject({
      webPort: 28173,
      apiPort: 25100,
      previewPort: 25174,
      instanceId: 'shell',
      dataDir: path.join(rootDir, 'local data'),
      webOrigin: 'http://127.0.0.1:28173',
      apiOrigin: 'http://127.0.0.1:25100',
      previewOrigin: 'http://127.0.0.1:25174',
    });
    expect(config.environment).toMatchObject({
      LAB_WEB_PORT: '28173',
      PORT: '25100',
      LAB_DATA_DIR: config.dataDir,
    });
    expect(existsSync(config.dataDir)).toBe(false);
  });

  it('supports PORT within each layer and gives LAB_API_PORT priority in the same layer', () => {
    const rootDir = directory();
    writeFileSync(path.join(rootDir, '.env'), 'LAB_API_PORT=25100\n');
    writeFileSync(path.join(rootDir, '.env.local'), 'PORT=26100\n');
    expect(loadRuntimeConfig({ rootDir, env: {} }).apiPort).toBe(26100);
    expect(loadRuntimeConfig({ rootDir, env: { PORT: '27100' } }).apiPort).toBe(27100);
    expect(
      loadRuntimeConfig({ rootDir, env: { PORT: '27100', LAB_API_PORT: '28100' } }).apiPort,
    ).toBe(28100);
  });

  it('derives a stable per-checkout instance and resolves data paths without creating a database', () => {
    const first = directory();
    const second = directory();
    const config = loadRuntimeConfig({ rootDir: first, env: {} });
    expect(config.instanceId).toMatch(/^lab-[a-f0-9]{12}$/u);
    expect(loadRuntimeConfig({ rootDir: first, env: {} }).instanceId).toBe(config.instanceId);
    expect(loadRuntimeConfig({ rootDir: second, env: {} }).instanceId).not.toBe(config.instanceId);
    expect(config.dataDir).toBe(path.join(first, '.lab-data'));
    expect(loadRuntimeConfig({ rootDir: first, env: { LAB_DATA_DIR: second } }).dataDir).toBe(
      second,
    );
    expect(config.sourceId).toBeUndefined();
    expect(existsSync(config.dataDir)).toBe(false);
  });

  it.each(['LAB_WEB_PORT', 'LAB_API_PORT', 'LAB_PREVIEW_PORT', 'PORT'])(
    'rejects invalid %s values',
    (name) => {
      const rootDir = directory();
      for (const value of ['', '0', '-1', '65536', '3100.5', '3e3', '3100junk', ' 3100', '03100']) {
        expect(() => loadRuntimeConfig({ rootDir, env: { [name]: value } })).toThrow(
          /must be an integer/u,
        );
      }
    },
  );

  it('rejects conflicting ports, invalid instance IDs and empty data directories', () => {
    const rootDir = directory();
    expect(() => loadRuntimeConfig({ rootDir, env: { LAB_API_PORT: '5173' } })).toThrow(
      /must be different/u,
    );
    for (const instanceId of ['', 'name with spaces', '../other', '-name', 'a'.repeat(65)]) {
      expect(() => loadRuntimeConfig({ rootDir, env: { LAB_INSTANCE_ID: instanceId } })).toThrow(
        /LAB_INSTANCE_ID/u,
      );
    }
    for (const dataDir of ['', ' ', 'data\0bad']) {
      expect(() => loadRuntimeConfig({ rootDir, env: { LAB_DATA_DIR: dataDir } })).toThrow(
        /LAB_DATA_DIR/u,
      );
    }
  });

  it('builds the local Origin allowlist from all configured ports', () => {
    const config = loadRuntimeConfig({
      rootDir: directory(),
      env: { LAB_WEB_PORT: '25173', LAB_API_PORT: '25100', LAB_PREVIEW_PORT: '25174' },
    });
    expect([...allowedOrigins(config)]).toEqual([
      'http://127.0.0.1:25173',
      'http://localhost:25173',
      'http://127.0.0.1:25100',
      'http://localhost:25100',
      'http://127.0.0.1:25174',
      'http://localhost:25174',
    ]);
  });

  it('uses the same ports, identity and proxy in Vite while leaving static previews backend-free', async () => {
    vi.stubEnv('LAB_WEB_PORT', '29173');
    vi.stubEnv('LAB_API_PORT', '29100');
    vi.stubEnv('LAB_PREVIEW_PORT', '29174');
    vi.stubEnv('LAB_INSTANCE_ID', 'vite-test');
    vi.stubEnv('PAGES_BASE_PATH', '/repo/');
    const config = await viteConfig({ command: 'build', mode: 'pages' });
    expect(config).toMatchObject({
      envDir: false,
      base: '/repo/',
      define: { __LAB_INSTANCE_ID__: '"vite-test"' },
      server: {
        host: '127.0.0.1',
        port: 29173,
        strictPort: true,
        proxy: { '/api': 'http://127.0.0.1:29100', '/mcp': 'http://127.0.0.1:29100' },
      },
      preview: { host: '127.0.0.1', port: 29174, strictPort: true, proxy: {} },
    });
  });
});

describe('instance health and port preflight', () => {
  it('validates the browser-safe health contract before accepting an instance', () => {
    const health = { status: 'ok', mode: 'local-deterministic', instanceId: LAB_INSTANCE_ID };
    expect(isLabHealth(health)).toBe(true);
    expect(isExpectedInstance(health)).toBe(true);
    expect(isExpectedInstance(health, 'another-checkout')).toBe(false);
    expect(isLabHealth({ ...health, mode: 'browser-static' })).toBe(true);
    for (const value of [
      null,
      [],
      {},
      { ...health, instanceId: '' },
      { ...health, status: 'error' },
      { ...health, mode: 'unknown' },
      { ...health, sourceId: 2 },
      { ...health, protocols: [1] },
    ]) {
      expect(isLabHealth(value)).toBe(false);
      expect(isExpectedInstance(value)).toBe(false);
    }
  });

  it('returns the real server instance and checks configured browser Origins', async () => {
    const config = loadRuntimeConfig({
      rootDir: directory(),
      env: {
        LAB_WEB_PORT: '25173',
        LAB_API_PORT: '25100',
        LAB_PREVIEW_PORT: '25174',
        LAB_INSTANCE_ID: 'health-test',
      },
    });
    // Use an ephemeral socket for this integration test, leaving every existing app untouched.
    const port = await listen(createHttpServer(createServer(config)));
    const origin = `http://127.0.0.1:${port}`;
    const response = await fetch(`${origin}/api/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      mode: 'local-deterministic',
      instanceId: 'health-test',
      protocols: ['AG-UI', 'A2UI', 'MCP Apps'],
    });
    await expect(assertLocalInstance(origin, 'health-test')).resolves.toMatchObject({
      instanceId: 'health-test',
    });
    await expect(assertLocalInstance(origin, 'other-worktree')).rejects.toThrow(/does not belong/u);
    for (const allowed of allowedOrigins(config)) {
      expect((await fetch(`${origin}/api/health`, { headers: { Origin: allowed } })).status).toBe(
        200,
      );
    }
    for (const denied of [
      'http://127.0.0.1:5173',
      'https://example.com',
      'null',
      'http://localhost:25173.evil.example',
    ]) {
      expect((await fetch(`${origin}/api/health`, { headers: { Origin: denied } })).status).toBe(
        403,
      );
    }
  });

  it('fails for an occupied port without stopping its owner and releases successful reservations', async () => {
    const occupied = await listen(createSocketServer());
    const config = loadRuntimeConfig({
      rootDir: directory(),
      env: { LAB_API_PORT: String(occupied) },
    });
    await expect(assertPortsAvailable(config, ['api'])).rejects.toThrow(
      `api port ${occupied} is unavailable`,
    );
    expect(servers[0]?.listening).toBe(true);
    await new Promise<void>((resolve) => servers[0]!.close(() => resolve()));
    servers.shift();
    await expect(assertPortsAvailable(config, ['api'])).resolves.toBeUndefined();
    await expect(assertPortsAvailable(config, ['api'])).resolves.toBeUndefined();
  });
});
