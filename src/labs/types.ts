import type { ComponentType } from 'react';
import type { LucideIcon } from 'lucide-react';
import type {
  LabChatTurnProps,
  LabComponentProps,
  LabContext,
  LabMetadata,
  ProtocolId,
} from '../../shared/lab-contract';

export interface LabPresentation {
  name: string;
  subtitle: string;
  label: string;
  description: string;
  icon: LucideIcon;
  color: 'purple' | 'teal' | 'amber';
  transport: string;
  docs?: string;
  steps: readonly string[];
  question: string;
  explanation: string;
  concepts: readonly (readonly [string, string])[];
  exercise: string;
}

export interface ChatResolution {
  labId: string;
  context: LabContext;
  explanation: string;
}

export interface LabChatAdapter {
  short: string;
  prompt: string;
  starter: string;
  suggestion: string;
  source: string;
  // The legacy rule agent routes to protocols. New labs can supply their own resolver.
  protocol?: ProtocolId;
  resolve?: (prompt: string, context: LabContext, signal: AbortSignal) => Promise<ChatResolution>;
  match?: (prompt: string) => boolean;
  load: () => Promise<{ default: ComponentType<LabChatTurnProps> }>;
}

export interface LabDefinition extends LabMetadata {
  presentation: LabPresentation;
  load: () => Promise<{ default: ComponentType<LabComponentProps> }>;
  chat?: LabChatAdapter;
}
