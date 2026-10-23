import type { Express, Request, Response } from 'express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { McpServer } from '@modelcontextprotocol/server';
import { createTripMcpServer } from '../shared/mcp-server';
import { buildAppHtml } from './mcp-resource';

export {
  MCP_APP_RESOURCE_URI,
  MCP_APP_LIST_RESOURCE_URI,
  MCP_TRIP_TOOL_NAME,
} from '../shared/mcp-server';

export function createMcpServer(): McpServer {
  return createTripMcpServer(buildAppHtml);
}

async function handleMcpPost(request: Request, response: Response): Promise<void> {
  const server = createMcpServer();
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  let closed = false;

  const close = async () => {
    if (closed) return;
    closed = true;
    await server.close().catch(() => undefined);
  };

  response.once('finish', () => {
    void close();
  });
  response.once('close', () => {
    void close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(request, response, request.body);
  } catch {
    await close();
    if (!response.headersSent) {
      response.status(500).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32603, message: 'MCP 请求处理失败。' },
      });
    } else if (!response.writableEnded) {
      response.end();
    }
  }
}

function rejectStatelessMethod(_request: Request, response: Response): void {
  response
    .set('Allow', 'POST')
    .status(405)
    .json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: '无状态 MCP 端点仅接受 POST。' },
    });
}

export function installMcpRoutes(app: Express): void {
  app.post('/mcp', (request, response) => {
    void handleMcpPost(request, response);
  });
  app.get('/mcp', rejectStatelessMethod);
  app.delete('/mcp', rejectStatelessMethod);
}
