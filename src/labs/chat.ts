import type { LabContext } from '../../shared/lab-contract';
import type { ChatRoute } from '../../shared/chat';
import { fetchJson } from '../../shared/http';
import { chatLabs, getLab, labForProtocol } from './registry';
import type { ChatResolution } from './types';
import { tripContext } from './legacy';

export async function resolveChatLab(
  prompt: string,
  mode: string,
  context: LabContext,
  signal: AbortSignal,
): Promise<ChatResolution> {
  const selected =
    mode === 'auto' ? chatLabs.find((lab) => lab.chat?.match?.(prompt)) : getLab(mode);
  if (mode !== 'auto' && !selected?.chat) throw new Error('此实验尚未提供聊天适配。');
  if (selected?.chat?.resolve) {
    const resolved = await selected.chat.resolve(prompt, context, signal);
    if (resolved.labId !== selected.id) throw new Error('聊天适配返回了不匹配的实验。');
    return resolved;
  }
  if (selected && !selected.chat?.protocol) throw new Error('此实验尚未提供聊天路由。');
  const route = await fetchJson<ChatRoute>('/api/chat', {
    method: 'POST',
    body: JSON.stringify({
      prompt,
      mode: selected?.chat?.protocol ?? 'auto',
      context: tripContext(context),
    }),
    signal,
  });
  const lab = labForProtocol(route.protocol);
  if (!lab) throw new Error('服务端返回了未知的实验。');
  return {
    labId: lab.id,
    explanation: route.explanation,
    context: { ...context, trip: route.context },
  };
}
