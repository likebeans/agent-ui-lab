import type { TripCity } from './agui';
import type { TraceInput, ProtocolId } from './trace';

export interface ChatContext {
  city: TripCity;
  days: number;
}

export interface ChatRequest {
  id: string;
  threadId: string;
  prompt: string;
  protocol: ProtocolId;
  context: ChatContext;
  history: Array<{ id: string; role: 'user' | 'assistant'; content: string }>;
}

export interface ChatTurnProps {
  active?: boolean;
  request: ChatRequest;
  onTrace: (entry: TraceInput) => void;
  onComplete: (summary: string) => void;
  onInspectTrace?: (label: string, occurrence?: number) => void;
  onInteraction: (exchange: {
    user: string;
    assistant: string;
    context?: Partial<ChatContext>;
  }) => void;
}

export interface ChatRoute {
  protocol: ProtocolId;
  context: ChatContext;
  explanation: string;
}
