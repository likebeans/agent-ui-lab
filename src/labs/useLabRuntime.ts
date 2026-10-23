import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LabIdentity, LabRuntime } from '../../shared/lab-contract';
import { correlateTrace, type TraceInput, type TraceSelector } from '../../shared/trace';
import { labFetch } from '../../shared/http';
import { STATIC_MODE } from '../../shared/runtime';

export function useLabRuntime(
  identity: LabIdentity,
  onTrace: (entry: TraceInput) => void,
  focusTrace: (selector: TraceSelector) => void,
): LabRuntime {
  const [controller] = useState(() => new AbortController());
  const callbacks = useRef({ onTrace, focusTrace });
  callbacks.current = { onTrace, focusTrace };
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const protocolIdentity = useRef<Partial<LabIdentity>>({});
  const trace = useCallback(
    (entry: TraceInput) => {
      if (controller.signal.aborted) return;
      const correlated = correlateTrace(entry, {
        ...currentIdentity.current,
        ...protocolIdentity.current,
      });
      if (entry.protocol === 'agui') {
        protocolIdentity.current = { runId: correlated.runId, threadId: correlated.threadId };
      }
      callbacks.current.onTrace(correlated);
    },
    [controller],
  );
  useEffect(() => () => controller.abort(), [controller]);
  return useMemo(
    () => ({
      mode: STATIC_MODE ? 'pages' : 'local',
      identity,
      signal: controller.signal,
      request: (path, options = {}) =>
        labFetch(path, {
          ...options,
          signal: options.signal
            ? AbortSignal.any([controller.signal, options.signal])
            : controller.signal,
        }),
      trace,
      focusTrace: (selector) => callbacks.current.focusTrace({ ...identity, ...selector }),
    }),
    [controller, identity, trace],
  );
}
