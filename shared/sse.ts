// SSE frames and HTTP chunks have different boundaries. Keep the unfinished frame.
export function createSseDecoder(onData: (value: unknown) => void) {
  let buffer = '';
  return {
    push(chunk: string) {
      buffer += chunk;
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        if (boundary.index > 1_048_576) throw new Error('SSE 消息超过实验允许的大小。');
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n');
        if (data) onData(JSON.parse(data));
      }
      if (buffer.length > 1_048_576) throw new Error('SSE 消息超过实验允许的大小。');
    },
    finish() {
      if (buffer.trim()) throw new Error('事件流在一个完整 SSE 消息到达前断开。');
    },
  };
}

export async function consumeSse(
  response: Response,
  onData: (value: unknown) => void,
  signal?: AbortSignal,
) {
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`请求失败 (${response.status})：${body.slice(0, 300)}`);
  }
  if (!response.headers.get('content-type')?.includes('text/event-stream'))
    throw new Error('服务端没有返回 SSE 事件流。');
  if (!response.body) throw new Error('浏览器未提供可读取的响应流。');
  const reader = response.body.getReader();
  const text = new TextDecoder();
  const parser = createSseDecoder(onData);
  const abort = () => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      parser.push(text.decode(value, { stream: true }));
    }
    parser.push(text.decode());
    parser.finish();
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
