import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LabRuntime } from '../../../shared/lab-contract';
import {
  APPROVAL_REQUEST_TIMEOUT_MS,
  sendCommand,
  type SavedCommand,
} from '../../../src/labs/human-approval/client';

const saved: SavedCommand = {
  teachingSessionId: 'deadline-session',
  purpose: 'operation',
  command: {
    taskId: 'deadline-task',
    commandId: 'deadline-command',
    expectedVersion: 1,
    payload: { type: 'approve', proposalId: 'deadline-proposal', proposalVersion: 1 },
  },
};

function runtime(request: LabRuntime['request']): LabRuntime {
  return {
    mode: 'local',
    identity: { labId: 'human-approval' },
    signal: new AbortController().signal,
    request,
    trace: vi.fn(),
    focusTrace: vi.fn(),
  };
}

afterEach(() => vi.useRealTimers());

describe('approval client response deadline', () => {
  it.each(['request', 'body'] as const)(
    'bounds a never-ending %s and ignores its eventual result',
    async (stage) => {
      vi.useFakeTimers();
      let finish: (value: any) => void = () => {};
      const waiting = new Promise<any>((resolve) => {
        finish = resolve;
      });
      const response = { status: 200, text: () => waiting } as Response;
      const request = vi.fn<LabRuntime['request']>(async () =>
        stage === 'request' ? waiting : response,
      );
      const client = runtime(request);
      const before = structuredClone(saved);
      const pending = sendCommand(client, saved);
      await vi.advanceTimersByTimeAsync(APPROVAL_REQUEST_TIMEOUT_MS);
      expect(await pending).toMatchObject({
        kind: 'unknown',
        reason: expect.stringContaining('超时'),
      });
      expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);
      expect(saved).toEqual(before);
      expect(client.trace).toHaveBeenCalledTimes(1);
      finish(stage === 'request' ? new Response('{}') : '{}');
      await Promise.resolve();
      await Promise.resolve();
      expect(client.trace).toHaveBeenCalledTimes(1);
    },
  );

  it('releases promptly when the runtime is aborted even if its transport ignores the signal', async () => {
    const controller = new AbortController();
    const client = { ...runtime(() => new Promise(() => {})), signal: controller.signal };
    const pending = sendCommand(client, saved);
    controller.abort();
    expect(await pending).toMatchObject({ kind: 'unknown' });
  });
});
