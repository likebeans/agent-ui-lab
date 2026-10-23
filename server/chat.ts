import type { Express } from 'express';
import { z } from 'zod';
import { routeChat } from '../shared/chat-agent';
export { chatInputSchema, routeChat } from '../shared/chat-agent';

export function installChatRoutes(app: Express) {
  app.post('/api/chat', (request, response) => {
    try {
      response.json(routeChat(request.body));
    } catch (error) {
      response.status(400).json({
        error: error instanceof z.ZodError ? error.issues[0]?.message : '无法识别这条实验请求。',
      });
    }
  });
}
