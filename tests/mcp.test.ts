import express from 'express';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { getToolUiResourceUri } from '@modelcontextprotocol/ext-apps/app-bridge';
import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import {
  MCP_APP_LIST_RESOURCE_URI,
  MCP_APP_RESOURCE_URI,
  MCP_TRIP_TOOL_NAME,
  installMcpRoutes,
} from '../server/mcp';
import { buildAppHtml } from '../server/mcp-resource';
import { createTripMcpServer } from '../shared/mcp-server';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map((close) => close()));
});

function createTestClient() {
  return new Client(
    { name: 'mcp-apps-integration-test', version: '0.1.0' },
    {
      capabilities: {
        extensions: {
          'io.modelcontextprotocol/ui': {
            mimeTypes: [RESOURCE_MIME_TYPE],
          },
        },
      },
    },
  );
}

async function openHttpTestClient() {
  const app = express();
  app.use(express.json({ limit: '128kb' }));
  installMcpRoutes(app);
  const httpServer = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const port = (httpServer.address() as AddressInfo).port;
  const client = createTestClient();
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));

  cleanup.push(async () => {
    await client.close().catch(() => undefined);
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });
  await client.connect(transport);
  return client;
}

async function openInMemoryTestClient(loadHtml = buildAppHtml) {
  const server = createTripMcpServer(loadHtml);
  const client = createTestClient();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  cleanup.push(async () => {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe.each([
  { mode: 'Streamable HTTP', openTestClient: openHttpTestClient },
  { mode: 'InMemoryTransport', openTestClient: () => openInMemoryTestClient() },
])('MCP Apps $mode integration', ({ openTestClient }) => {
  it('discovers the allowlisted read-only tool and its UI resource', async () => {
    const client = await openTestClient();
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === MCP_TRIP_TOOL_NAME);

    expect(tool).toBeDefined();
    expect(getToolUiResourceUri(tool!)).toBe(MCP_APP_RESOURCE_URI);
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(tool?._meta).toMatchObject({
      ui: {
        resourceUri: MCP_APP_RESOURCE_URI,
        visibility: ['model', 'app'],
      },
    });
  });

  it('lists both bounded UI layouts while keeping the tool metadata on the default URI', async () => {
    const client = await openTestClient();
    const { resources } = await client.listResources();

    expect(resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ uri: MCP_APP_RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE }),
        expect.objectContaining({ uri: MCP_APP_LIST_RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE }),
      ]),
    );
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === MCP_TRIP_TOOL_NAME);
    expect(getToolUiResourceUri(tool!)).toBe(MCP_APP_RESOURCE_URI);
  });

  it.each([
    [MCP_APP_RESOURCE_URI, 'cards'],
    [MCP_APP_LIST_RESOURCE_URI, 'list'],
  ])('reads self-contained %s layout with no network capability', async (uri, layout) => {
    const client = await openTestClient();
    const result = await client.readResource({ uri });
    const resource = result.contents.find((content) => content.uri === uri);

    expect(resource).toBeDefined();
    expect(resource?.mimeType).toBe(RESOURCE_MIME_TYPE);
    expect(resource).toHaveProperty('text');
    if (!resource || !('text' in resource)) return;

    expect(resource.text).toContain('<!doctype html>');
    expect(resource.text).toContain('Content-Security-Policy');
    expect(resource.text).toContain("connect-src 'none'");
    expect(resource.text).toContain("frame-src 'none'");
    expect(resource.text).toContain("object-src 'none'");
    expect(resource.text).toContain(`data-layout="${layout}"`);
    expect(resource.text).not.toMatch(/<script\s+[^>]*src\s*=/i);
    expect(resource.text).not.toMatch(/<link\s+[^>]*href\s*=/i);
    expect(resource._meta).toMatchObject({
      ui: {
        prefersBorder: true,
        csp: {
          connectDomains: [],
          resourceDomains: [],
          frameDomains: [],
          baseUriDomains: [],
        },
      },
    });
  });

  it('defaults an omitted city to the deterministic Shanghai fixture', async () => {
    const client = await openTestClient();
    const result = await client.callTool({ name: MCP_TRIP_TOOL_NAME, arguments: {} });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      city: 'shanghai',
      cityLabel: '上海',
      source: 'local-fixture',
      deterministic: true,
      activities: [
        { title: '外滩建筑散步' },
        { title: '城市博物馆路线' },
        { title: '梧桐街区慢行' },
      ],
    });
  });

  it('calls the real tool and returns fallback text plus structured fixture data', async () => {
    const client = await openTestClient();
    await client.listTools();
    const result = await client.callTool({
      name: MCP_TRIP_TOOL_NAME,
      arguments: { city: 'hangzhou' },
    });

    expect(result.isError).not.toBe(true);
    expect(result.content).toContainEqual(
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining('杭州'),
      }),
    );
    expect(result.structuredContent).toMatchObject({
      city: 'hangzhou',
      cityLabel: '杭州',
      theme: '湖山步道与宋韵城市',
      source: 'local-fixture',
      deterministic: true,
      activities: [{ title: '西湖清晨步道' }, { title: '运河文化路线' }, { title: '茶园观察课' }],
    });
  });

  it('roundtrips the alternate resource and a new tool result in one real client session', async () => {
    const client = await openTestClient();
    const alternate = await client.readResource({ uri: MCP_APP_LIST_RESOURCE_URI });
    const result = await client.callTool({
      name: MCP_TRIP_TOOL_NAME,
      arguments: { city: 'chengdu' },
    });

    expect(alternate.contents).toHaveLength(1);
    expect(alternate.contents[0]).toMatchObject({
      uri: MCP_APP_LIST_RESOURCE_URI,
      mimeType: RESOURCE_MIME_TYPE,
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      city: 'chengdu',
      cityLabel: '成都',
      activities: expect.arrayContaining([expect.objectContaining({ title: '人民公园早茶' })]),
    });
  });

  it('returns a tool error for input outside the deterministic fixture allowlist', async () => {
    const client = await openTestClient();
    const result = await client.callTool({
      name: MCP_TRIP_TOOL_NAME,
      arguments: { city: 'external-network-city' },
    });

    expect(result.isError).toBe(true);
  });
});

describe('browser-safe MCP server', () => {
  it('preserves HTTP capabilities, instructions and discovery over InMemoryTransport', async () => {
    const http = await openHttpTestClient();
    const inMemory = await openInMemoryTestClient();

    expect(inMemory.getServerCapabilities()).toEqual(http.getServerCapabilities());
    expect(inMemory.getServerVersion()).toEqual(http.getServerVersion());
    expect(inMemory.getInstructions()).toEqual(http.getInstructions());
    expect(await inMemory.listTools()).toEqual(await http.listTools());
    expect(await inMemory.listResources()).toEqual(await http.listResources());
  });

  it('loads only the requested layout and preserves the supplied HTML', async () => {
    const loadHtml = vi.fn(async (layout: 'cards' | 'list') => `<html>${layout}</html>`);
    const client = await openInMemoryTestClient(loadHtml);
    await client.listTools();
    await client.listResources();
    await client.callTool({ name: MCP_TRIP_TOOL_NAME, arguments: {} });
    expect(loadHtml).not.toHaveBeenCalled();

    for (const [uri, layout] of [
      [MCP_APP_RESOURCE_URI, 'cards'],
      [MCP_APP_LIST_RESOURCE_URI, 'list'],
    ] as const) {
      const result = await client.readResource({ uri });
      expect(result.contents).toEqual([
        expect.objectContaining({
          uri,
          mimeType: RESOURCE_MIME_TYPE,
          text: `<html>${layout}</html>`,
        }),
      ]);
    }
    expect(loadHtml.mock.calls).toEqual([['cards'], ['list']]);
  });

  it('surfaces HTML loader failures without losing the client session', async () => {
    const loadHtml = vi
      .fn(async (layout: 'cards' | 'list') => `<html>${layout}</html>`)
      .mockRejectedValueOnce(new Error('App HTML unavailable'));
    const client = await openInMemoryTestClient(loadHtml);

    await expect(client.readResource({ uri: MCP_APP_RESOURCE_URI })).rejects.toThrow(
      'App HTML unavailable',
    );
    const result = await client.readResource({ uri: MCP_APP_LIST_RESOURCE_URI });
    expect(result.contents[0]).toMatchObject({ text: '<html>list</html>' });
  });

  it('bundles the shared server for browsers without Node imports or external modules', async () => {
    const result = await build({
      entryPoints: [fileURLToPath(new URL('../shared/mcp-server.ts', import.meta.url))],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      write: false,
      metafile: true,
    });

    expect(result.outputFiles[0]?.text).toContain('createTripMcpServer');
    expect(
      Object.keys(result.metafile.inputs).some((path) => path.endsWith('/server/mcp.ts')),
    ).toBe(false);
    expect(
      Object.keys(result.metafile.inputs).some((path) => path.endsWith('/server/mcp-resource.ts')),
    ).toBe(false);
    expect(Object.values(result.metafile.outputs).flatMap((output) => output.imports)).toEqual([]);
  });
});
