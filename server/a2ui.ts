import type { Express } from 'express';
import { z } from 'zod';
import {
  createInitialA2uiMessages,
  createA2uiActionMessages,
  createDeleteA2uiMessage,
} from '../shared/a2ui-agent';
export {
  A2UI_SURFACE_ID,
  createInitialA2uiMessages,
  createA2uiActionMessages,
  createDeleteA2uiMessage,
} from '../shared/a2ui-agent';

function badRequest(error: unknown): { error: string } {
  if (error instanceof z.ZodError)
    return { error: `A2UI 请求校验失败：${error.issues[0]?.message ?? '格式不正确。'}` };
  return { error: error instanceof Error ? error.message : 'A2UI 请求格式不正确。' };
}

export function installA2uiRoutes(app: Express): void {
  app.get('/api/a2ui/surface', (_request, response) => {
    response.json({ messages: createInitialA2uiMessages(), agent: 'deterministic-fixture' });
  });

  app.post('/api/a2ui/surface', (request, response) => {
    try {
      response.json({
        messages: createInitialA2uiMessages(request.body),
        agent: 'deterministic-fixture',
      });
    } catch (error) {
      response.status(400).json(badRequest(error));
    }
  });

  app.post('/api/a2ui/action', (request, response) => {
    try {
      response.json({
        messages: createA2uiActionMessages(request.body),
        agent: 'deterministic-fixture',
      });
    } catch (error) {
      response.status(400).json(badRequest(error));
    }
  });

  app.delete('/api/a2ui/surface/:surfaceId', (request, response) => {
    try {
      response.json({ messages: [createDeleteA2uiMessage(request.params.surfaceId)] });
    } catch (error) {
      response.status(404).json(badRequest(error));
    }
  });
}
