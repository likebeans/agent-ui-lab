import type { TraceInput } from './trace';

export const STATIC_MODE = import.meta.env.MODE === 'pages';

export function describeTrace(entry: TraceInput): TraceInput {
  if (!STATIC_MODE) {
    return {
      ...entry,
      transport:
        entry.direction === 'local'
          ? 'local'
          : entry.direction.includes('app')
            ? 'postMessage'
            : 'HTTP',
    };
  }
  const direction =
    entry.direction === 'client→server'
      ? 'client→browser-agent'
      : entry.direction === 'server→client'
        ? 'browser-agent→client'
        : entry.direction;
  const transport =
    entry.direction === 'local'
      ? 'local'
      : entry.direction.includes('app')
        ? 'postMessage'
        : 'browser-memory';
  return { ...entry, direction, transport };
}
