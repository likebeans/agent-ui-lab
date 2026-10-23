export type ProtocolId = 'agui' | 'a2ui' | 'mcp';

export interface TraceInput {
  protocol: ProtocolId;
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

export interface LabProps {
  onTrace: (entry: TraceInput) => void;
  onResetTrace: () => void;
}
