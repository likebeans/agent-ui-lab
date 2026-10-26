import express, { type ErrorRequestHandler, type Express, type Response } from 'express';
import {
  COMPATIBILITY_DROP_RESPONSE_HEADER,
  type CompatibilityReply,
} from '../../../shared/labs/a2ui-compatibility/contract';
import { createCompatibilityEngine } from '../../../shared/labs/a2ui-compatibility/engine';

const installed = new WeakSet<Express>();
const root = '/api/labs/a2ui-compatibility/documents';
const statusCodes = { snapshot: 200, accepted: 200, conflict: 409, invalid: 400, 'not-found': 404 };

function send(response: Response, reply: CompatibilityReply): void {
  response.status(statusCodes[reply.kind]).json(reply);
}

export function installA2uiCompatibilityRoutes(app: Express): void {
  if (installed.has(app)) return;
  installed.add(app);
  const engine = createCompatibilityEngine();
  // Also makes the installer usable on its own. Express skips already parsed bodies.
  app.use(root, express.json({ limit: '128kb' }));
  app.post(root, (request, response) => send(response, engine.create(request.body)));
  app.get(`${root}/:documentId`, (request, response) =>
    send(response, engine.read(request.params.documentId)),
  );
  app.post(`${root}/:documentId/remote`, (request, response) =>
    send(response, engine.change(request.params.documentId, request.body)),
  );
  app.post(`${root}/:documentId/actions`, (request, response) => {
    const reply = engine.act(request.params.documentId, request.body);
    if (reply.kind === 'accepted' && request.get(COMPATIBILITY_DROP_RESPONSE_HEADER) === '1') {
      // The authoritative mutation has already committed; do not send a success receipt.
      response.destroy();
      return;
    }
    send(response, reply);
  });
  const invalidBody: ErrorRequestHandler = (error: unknown, _request, response, next) => {
    if (error instanceof SyntaxError && 'type' in error && error.type === 'entity.parse.failed') {
      send(response, { kind: 'invalid', message: '请求 JSON 无效。', issues: [] });
    } else if (error instanceof URIError) {
      send(response, { kind: 'invalid', message: 'documentId 编码无效。', issues: [] });
    } else next(error);
  };
  app.use(root, invalidBody);
}
