import { describe, expect, it } from 'vitest';
import { aguiReducer, createInitialAguiState, parseAguiEvent } from '../shared/agui';
import {
  changedStatePaths,
  explainAguiFrame,
  experimentWithAguiEvent,
  type AguiFrame,
} from '../shared/agui-learning';

function recordedText(): AguiFrame {
  let state = aguiReducer(createInitialAguiState(), {
    kind: 'event',
    event: { type: 'RUN_STARTED', threadId: 'thread', runId: 'run' },
  });
  state = aguiReducer(state, {
    kind: 'event',
    event: { type: 'TEXT_MESSAGE_START', messageId: 'message', role: 'assistant' },
  });
  state = aguiReducer(state, {
    kind: 'event',
    event: { type: 'TEXT_MESSAGE_CONTENT', messageId: 'message', delta: '杭州' },
  });
  const event = parseAguiEvent({
    type: 'TEXT_MESSAGE_CONTENT',
    messageId: 'message',
    delta: '三日游',
  });
  return { event, before: state, after: aguiReducer(state, { kind: 'event', event }) };
}

describe('AG-UI learning replay uses actual reducer semantics', () => {
  it('compares the affected message and isolates edited events from the recording', () => {
    const frame = recordedText();
    const evidence = explainAguiFrame(frame);
    expect(evidence.before).toMatchObject({ text: '杭州' });
    expect(evidence.after).toMatchObject({ text: '杭州三日游' });
    const edited = experimentWithAguiEvent(frame, { ...frame.event, delta: '慢行路线' });
    expect(edited.messages[0].text).toBe('杭州慢行路线');
    expect(frame.after.messages[0].text).toBe('杭州三日游');
    expect(frame.before.messages[0].text).toBe('杭州');
    expect(() => experimentWithAguiEvent(frame, { ...frame.event, messageId: 'missing' })).toThrow(
      '找不到可追加',
    );
    expect(frame.after.messages[0].text).toBe('杭州三日游');
  });
  it('shows snapshot replacement versus a delta retaining unrelated fields', () => {
    const before = aguiReducer(createInitialAguiState(), {
      kind: 'event',
      event: { type: 'RUN_STARTED', threadId: 'thread', runId: 'run' },
    });
    const snapshot = parseAguiEvent({
      type: 'STATE_SNAPSHOT',
      snapshot: {
        city: '杭州',
        days: 3,
        status: 'planning',
        tasks: [{ id: 'plan', label: '规划', status: 'pending' }],
        itinerary: [],
      },
    });
    const state = aguiReducer(before, { kind: 'event', event: snapshot });
    const delta = parseAguiEvent({
      type: 'STATE_DELTA',
      delta: [{ op: 'replace', path: '/tasks/0/status', value: 'done' }],
    });
    const after = experimentWithAguiEvent({ event: delta, before: state, after: state }, delta);
    expect(after.agentState?.city).toBe('杭州');
    expect(after.agentState?.tasks[0].status).toBe('done');
    expect(state.agentState?.tasks[0].status).toBe('pending');
    expect(changedStatePaths(state.agentState, after.agentState)).toEqual([
      { path: '/tasks/0/status', before: 'pending', after: 'done' },
    ]);
    expect(() =>
      experimentWithAguiEvent(
        { event: delta, before: state, after },
        { type: 'STATE_DELTA', delta: [{ op: 'remove', path: '/tasks' }] },
      ),
    ).toThrow('仅支持');
  });
});
