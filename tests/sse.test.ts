import { describe, expect, it } from 'vitest';
import { consumeSse, createSseDecoder } from '../shared/sse';

describe('SSE transport boundaries', () => {
  it('handles fragmented CRLF frames, comments and multiple events in one chunk', () => {
    const values: unknown[] = [];
    const parser = createSseDecoder((value) => values.push(value));
    parser.push(': heartbeat\r\n\r\ndata: {"type":"ONE"}\r');
    parser.push('\n\r\ndata: {\n');
    parser.push('data: "type": "TWO"\ndata: }\n\n');
    parser.finish();
    expect(values).toEqual([{ type: 'ONE' }, { type: 'TWO' }]);
  });

  it('preserves Chinese text across arbitrary UTF-8 network chunk boundaries', async () => {
    const bytes = new TextEncoder().encode('data: {"text":"杭州的雨"}\n\n');
    const stream = new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    });
    const values: unknown[] = [];
    await consumeSse(
      new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }),
      (value) => values.push(value),
    );
    expect(values).toEqual([{ text: '杭州的雨' }]);
  });

  it('reports truncated frames and malformed payloads instead of successful completion', () => {
    const parser = createSseDecoder(() => {});
    parser.push('data: {"unfinished":');
    expect(() => parser.finish()).toThrow('断开');
    expect(() => createSseDecoder(() => {}).push('data: not-json\n\n')).toThrow();
  });

  it('limits individual frames rather than a network chunk containing many small frames', () => {
    let count = 0;
    const parser = createSseDecoder(() => count++);
    const frame = `data: ${JSON.stringify({ text: 'x'.repeat(1000) })}\n\n`;
    parser.push(frame.repeat(1100));
    parser.finish();
    expect(count).toBe(1100);
    expect(() => parser.push(`data: ${'x'.repeat(1_048_577)}`)).toThrow('超过');
  });

  it('cancels an idle reader when its AbortSignal fires', async () => {
    let cancelled = false;
    const controller = new AbortController();
    const stream = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    const pending = consumeSse(
      new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }),
      () => {},
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelled).toBe(true);
  });

  it('rejects HTTP errors and non-SSE responses', async () => {
    await expect(
      consumeSse(new Response('unavailable', { status: 503 }), () => {}),
    ).rejects.toThrow('503');
    await expect(consumeSse(new Response('{}'), () => {})).rejects.toThrow('SSE');
  });
});
