import { Router, type ErrorRequestHandler } from 'express';
import { createWorkflowService } from '../../../shared/labs/enrollment-workflow/engine';
import {
  WORKFLOW_DROP_HEADER,
  workflowEnvelopeSchema,
} from '../../../shared/labs/enrollment-workflow/contract';
import { workflowHttpStatus } from '../../../shared/labs/enrollment-workflow/transport';
import { TEACHING_SESSION_HEADER } from '../../../shared/labs/human-approval/types';
import type { LabDatabase } from '../../storage/sqlite';
import { createSqliteWorkflowStore } from './store';

export function createWorkflowRouter(database: LabDatabase) {
  const router = Router();
  const service = createWorkflowService(createSqliteWorkflowStore(database));
  router.use((_request, response, next) => {
    response.set('Cache-Control', 'no-store');
    next();
  });
  router.post('/commands', (request, response, next) => {
    try {
      const envelope = workflowEnvelopeSchema.safeParse(request.body);
      if (!envelope.success) {
        response
          .status(400)
          .json({ status: 'rejected', code: 'INVALID_INPUT', reason: '请提供有效的组合命令。' });
        return;
      }
      const result = service.command(
        { teachingSessionId: request.get(TEACHING_SESSION_HEADER) ?? '' },
        envelope.data.command,
        envelope.data.action,
      );
      if (request.get(WORKFLOW_DROP_HEADER) === '1') {
        response.destroy();
        return;
      }
      response.status(workflowHttpStatus(result)).json(result);
    } catch (error) {
      next(error);
    }
  });
  router.get('/facts', (request, response, next) => {
    try {
      const result = service.facts(
        { teachingSessionId: request.get(TEACHING_SESSION_HEADER) ?? '' },
        request.query,
      );
      response.status(workflowHttpStatus(result)).json(result);
    } catch (error) {
      next(error);
    }
  });
  router.all(['/commands', '/facts'], (_request, response) => {
    response
      .status(405)
      .json({ status: 'rejected', code: 'INVALID_INPUT', reason: '此接口不支持该请求方法。' });
  });
  return router;
}

export const workflowMalformedJson: ErrorRequestHandler = (error, _request, response, next) => {
  if (error?.type !== 'entity.parse.failed') {
    next(error);
    return;
  }
  response
    .set('Cache-Control', 'no-store')
    .status(400)
    .json({ status: 'rejected', code: 'INVALID_INPUT', reason: '请求正文必须是有效 JSON。' });
};
