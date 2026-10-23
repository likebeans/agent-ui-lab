import { lazy } from 'react';
import type { LabDefinition } from './types';
import type { LabMode, ProtocolId } from '../../shared/lab-contract';

const LAB_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export function createLabRegistry(definitions: readonly LabDefinition[]) {
  const ids = new Set<string>();
  const hashes = new Set<string>();
  for (const definition of definitions) {
    if (!LAB_ID.test(definition.id) || ids.has(definition.id))
      throw new Error(`实验 ID 无效或重复：${definition.id}`);
    if (!definition.modes.length || !definition.docs || !definition.topicIds.length)
      throw new Error(`实验元信息不完整：${definition.id}`);
    if (definition.legacyHash && hashes.has(definition.legacyHash))
      throw new Error(`实验兼容入口重复：${definition.legacyHash}`);
    ids.add(definition.id);
    if (definition.legacyHash) hashes.add(definition.legacyHash);
  }
  return [...definitions]
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((definition, index) => ({
      ...definition,
      number: String(index + 1).padStart(2, '0'),
      Component: lazy(definition.load),
      ChatComponent: definition.chat ? lazy(definition.chat.load) : undefined,
    }));
}

const manifests = import.meta.glob<{ default: LabDefinition }>('./*/manifest.ts', { eager: true });
export const labs = createLabRegistry(Object.values(manifests).map((module) => module.default));
export const chatLabs = labs.filter((lab) => lab.chat && lab.ChatComponent);
export type RegisteredLab = (typeof labs)[number];

export function getLab(id: string): RegisteredLab | undefined {
  return labs.find((lab) => lab.id === id);
}

export function labForProtocol(protocol: ProtocolId): RegisteredLab | undefined {
  return chatLabs.find((lab) => lab.chat?.protocol === protocol);
}

export function labHref(id: string): string {
  if (!LAB_ID.test(id)) throw new Error('实验 ID 无效。');
  return `#labs/${id}`;
}

export function labFromHash(hash: string): RegisteredLab | undefined {
  const legacy = labs.find((lab) => lab.legacyHash === hash);
  if (legacy) return legacy;
  const id = hash.startsWith('#labs/') ? hash.slice('#labs/'.length) : '';
  return LAB_ID.test(id) ? getLab(id) : undefined;
}

export function supportsLabMode(lab: RegisteredLab, mode: LabMode): boolean {
  return lab.modes.includes(mode);
}
