import type { TraceInput, TraceSelector } from './trace';

export type ProtocolId = 'agui' | 'a2ui' | 'mcp';
export type LabId = string;
export type LabMode = 'local' | 'pages';
export type LabContext = Record<string, unknown>;

export interface LabIdentity {
  labId: LabId;
  threadId?: string;
  turnId?: string;
  taskId?: string;
  runId?: string;
}

export interface LabMetadata {
  id: LabId;
  title: string;
  description: string;
  topicIds: readonly string[];
  protocols: readonly ProtocolId[];
  protocolVersions: Readonly<Partial<Record<ProtocolId, string>>>;
  order: number;
  status: 'available' | 'preview';
  modes: readonly LabMode[];
  docs: string;
  sourceReferences: readonly string[];
  legacyHash?: `#${string}`;
}

export interface LabRuntime {
  mode: LabMode;
  identity: LabIdentity;
  signal: AbortSignal;
  request: (path: string, options?: RequestInit) => Promise<Response>;
  trace: (entry: TraceInput) => void;
  focusTrace: (selector: TraceSelector) => void;
}

export interface LabComponentProps {
  runtime: LabRuntime;
  active: boolean;
  onResetTrace: () => void;
}

export interface LabChatRequest {
  id: string;
  threadId: string;
  labId: LabId;
  prompt: string;
  context: LabContext;
  history: Array<{ id: string; role: 'user' | 'assistant'; content: string }>;
}

export interface LabChatTurnProps {
  active: boolean;
  runtime: LabRuntime;
  request: LabChatRequest;
  onComplete: (summary: string) => void;
  onInteraction: (exchange: { user: string; assistant: string; context?: LabContext }) => void;
  onInspectTrace: (selector: TraceSelector) => void;
}

// Application contracts, separate from every protocol's own payload schema.
// W1 supplies storage/replay; W2 owns proposal and approval semantics.
export type TaskStatus =
  'queued' | 'running' | 'waiting-input' | 'succeeded' | 'failed' | 'cancelled';

export interface TaskSnapshot<State = unknown> {
  taskId: string;
  threadId: string;
  version: number;
  status: TaskStatus;
  currentRunId: string | null;
  state: State;
}

export interface TaskCommand<Payload = unknown> {
  commandId: string;
  taskId: string;
  expectedVersion: number;
  payload: Payload;
}

export interface EventCursor {
  runId: string;
  afterSeq: number;
}

export interface TaskEvent<Payload = unknown> {
  taskId: string;
  runId: string;
  seq: number;
  payload: Payload;
}

export interface TaskCheckpoint<State = unknown> {
  task: TaskSnapshot<State>;
  cursor: EventCursor;
}

export type CommandResult<Result = unknown> =
  | { status: 'accepted'; version: number; result: Result }
  | { status: 'conflict'; version: number; reason: string }
  | { status: 'rejected'; reason: string };

export interface TaskStore<State = unknown> {
  get(taskId: string, signal?: AbortSignal): Promise<TaskSnapshot<State> | null>;
  checkpoint(taskId: string, signal?: AbortSignal): Promise<TaskCheckpoint<State> | null>;
  replay(cursor: EventCursor, signal?: AbortSignal): Promise<readonly TaskEvent[]>;
  command(command: TaskCommand, signal?: AbortSignal): Promise<CommandResult>;
}
