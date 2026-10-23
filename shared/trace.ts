import type { LabIdentity, ProtocolId } from './lab-contract';
export type { ProtocolId } from './lab-contract';

export interface TraceSelector extends Partial<LabIdentity> {
  id?: number;
  eventType?: string;
  seq?: number;
  label?: string;
  occurrence?: number;
}

export interface TraceFocusRequest extends TraceSelector {
  token: number;
}

export interface TraceInput extends Partial<LabIdentity> {
  protocol?: ProtocolId;
  eventType?: string;
  seq?: number;
  direction:
    | 'client→server'
    | 'server→client'
    | 'client→browser-agent'
    | 'browser-agent→client'
    | 'app→host'
    | 'host→app'
    | 'local';
  transport?: 'HTTP' | 'browser-memory' | 'postMessage' | 'local';
  label: string;
  payload: unknown;
  note?: string;
}

export interface TraceEntry extends TraceInput {
  id: number;
  time: number;
}

// Existing teaching components keep this small adapter contract.
export interface LabProps {
  onTrace: (entry: TraceInput) => void;
  onResetTrace: () => void;
}

export function matchesTrace(entry: TraceEntry, selector: TraceSelector): boolean {
  return (
    ['id', 'labId', 'threadId', 'turnId', 'taskId', 'runId', 'eventType', 'seq', 'label'] as const
  ).every((key) => selector[key] === undefined || entry[key] === selector[key]);
}

export function findTrace(
  entries: readonly TraceEntry[],
  selector: TraceSelector,
): TraceEntry | undefined {
  return entries.filter((entry) => matchesTrace(entry, selector)).at(selector.occurrence ?? -1);
}

/** Put application correlation beside the original payload, never inside it. */
export function correlateTrace(entry: TraceInput, identity: LabIdentity): TraceInput {
  const payload = entry.payload;
  const record =
    payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : undefined;
  const protocolIdentity: Partial<LabIdentity> = {};
  if (entry.protocol === 'agui' && record) {
    if (typeof record.runId === 'string') protocolIdentity.runId = record.runId;
    if (typeof record.threadId === 'string') protocolIdentity.threadId = record.threadId;
  }
  return {
    ...identity,
    ...protocolIdentity,
    ...entry,
    labId: identity.labId,
    eventType: entry.eventType ?? (typeof record?.type === 'string' ? record.type : undefined),
  };
}
