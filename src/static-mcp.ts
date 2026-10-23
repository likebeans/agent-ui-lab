import { InMemoryTransport, type Transport } from '@modelcontextprotocol/client';
import { createTripMcpServer } from '../shared/mcp-server';

export async function createStaticMcpTransport(): Promise<Transport> {
  const server = createTripMcpServer(async (layout) => {
    const response = await fetch(`${import.meta.env.BASE_URL}mcp-app/${layout}.html`);
    if (!response.ok) throw new Error(`静态 App 资源读取失败 (${response.status})。`);
    return response.text();
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  // Closing either linked transport closes the SDK server as well.
  const onclose = serverTransport.onclose;
  serverTransport.onclose = () => {
    onclose?.();
    void server.close().catch(() => undefined);
  };
  return clientTransport;
}
