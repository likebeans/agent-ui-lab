import { useMemo, type ComponentType } from 'react';
import type { ChatContext, ChatRequest, ChatTurnProps } from '../../shared/chat';
import type { LabProps, ProtocolId } from '../../shared/trace';
import type { LabChatTurnProps, LabComponentProps, LabContext } from '../../shared/lab-contract';

export function tripContext(context: LabContext): ChatContext {
  const trip = context.trip;
  if (!trip || typeof trip !== 'object') return { city: '杭州', days: 3 };
  const value = trip as Record<string, unknown>;
  return {
    city: value.city === '成都' || value.city === '上海' ? value.city : '杭州',
    days:
      typeof value.days === 'number' &&
      Number.isInteger(value.days) &&
      value.days >= 1 &&
      value.days <= 7
        ? value.days
        : 3,
  };
}

export function adaptLegacyLab(
  Component: ComponentType<LabProps>,
): ComponentType<LabComponentProps> {
  return function LegacyLab({ runtime, onResetTrace }) {
    return <Component onTrace={runtime.trace} onResetTrace={onResetTrace} />;
  };
}

export function adaptLegacyChat(
  Component: ComponentType<ChatTurnProps>,
  protocol: ProtocolId,
): ComponentType<LabChatTurnProps> {
  return function LegacyChat({
    active,
    runtime,
    request,
    onComplete,
    onInteraction,
    onInspectTrace,
  }) {
    const legacyRequest = useMemo<ChatRequest>(
      () => ({
        id: request.id,
        threadId: request.threadId,
        prompt: request.prompt,
        history: request.history,
        protocol,
        context: tripContext(request.context),
      }),
      [request],
    );
    return (
      <Component
        active={active}
        request={legacyRequest}
        onTrace={runtime.trace}
        onComplete={onComplete}
        onInteraction={(exchange) =>
          onInteraction({
            ...exchange,
            context: exchange.context ? { trip: exchange.context } : undefined,
          })
        }
        onInspectTrace={(label, occurrence) => onInspectTrace({ label, occurrence })}
      />
    );
  };
}
