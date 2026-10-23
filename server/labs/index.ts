import type { Express } from 'express';
import { z } from 'zod';
import { runFoundation } from '../../shared/labs/foundation/engine';

// Add each lab's HTTP adapter here; never import this module from a browser manifest.
export function installLabRoutes(app: Express) {
  app.post('/api/labs/foundation/run', (request, response, next) => {
    try {
      response.json(runFoundation(request.body));
    } catch (error) {
      if (error instanceof z.ZodError) {
        response.status(400).json({ error: error.issues[0]?.message ?? '输入无效。' });
      } else next(error);
    }
  });
}
