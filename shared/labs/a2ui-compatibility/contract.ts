import type { A2uiClientAction, A2uiComponent, A2uiSurface } from '../../a2ui';
import type { JsonValue } from '../../json-pointer';

export type CompatibilityScenario = 'standard' | 'unknown-catalog' | 'unknown-component';
export type RemoteChange = 'extend-days' | 'add-budget' | 'replace-surface';

export interface ClientCapabilities {
  catalogIds: readonly string[];
  components: readonly A2uiComponent['component'][];
}

// These application fields are outside the A2UI 0.9.1 messages.
export interface FieldRule {
  componentId: string;
  path: string;
  label: string;
  required?: boolean;
  maxLength?: number;
  integer?: { min: number; max: number };
}

export interface FieldIssue {
  componentId: string;
  path: string;
  message: string;
  layer: 'client' | 'server';
}

export interface CompatibilitySnapshot {
  documentId: string;
  revision: number;
  surfaceId: string;
  scenario: CompatibilityScenario;
  messages: unknown[];
  rules: FieldRule[];
  fallbackText: string;
  acceptedActions: number;
}

export interface ActionEnvelope {
  expectedRevision: number;
  action: A2uiClientAction;
}

export type CompatibilityReply =
  | { kind: 'snapshot'; snapshot: CompatibilitySnapshot }
  | { kind: 'accepted'; snapshot: CompatibilitySnapshot }
  | {
      kind: 'conflict';
      code: 'revision-mismatch' | 'surface-mismatch' | 'document-exists';
      message: string;
      snapshot: CompatibilitySnapshot;
    }
  | { kind: 'invalid'; message: string; issues: FieldIssue[] }
  | { kind: 'not-found'; message: string };

export type CompatibilityResult =
  | { status: 'ready'; surface: A2uiSurface }
  | { status: 'fallback'; reasons: string[]; text: string };

export interface DraftConflict {
  componentId: string;
  path: string;
  label: string;
  base: JsonValue | undefined;
  local: JsonValue | undefined;
  remote: JsonValue | undefined;
}

export interface DraftState {
  snapshot: CompatibilitySnapshot;
  base: A2uiSurface;
  surface: A2uiSurface;
  conflicts: DraftConflict[];
  // Component identities edited since an action whose outcome is still unknown.
  unconfirmedEdits?: string[];
  retainedValues?: { componentId: string; path: string; value: JsonValue | undefined }[];
}

export interface CompatibilityEngine {
  create(input: unknown): CompatibilityReply;
  read(documentId: string): CompatibilityReply;
  change(documentId: string, input: unknown): CompatibilityReply;
  act(documentId: string, input: unknown): CompatibilityReply;
}
