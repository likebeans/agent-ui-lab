import type { ErrorRequestHandler, Express } from 'express';
import { createApprovalService } from '../../../shared/labs/human-approval/engine';
import type { ApprovalStore } from '../../../shared/labs/human-approval/ports';
import {
  APPROVAL_API,
  DROP_RESPONSE_HEADER,
  TEACHING_SESSION_HEADER,
  type ApprovalFactsResult,
  type ApprovalResult,
} from '../../../shared/labs/human-approval/types';
import { openLabDatabase, type LabDatabase } from '../../storage/sqlite';
import { createSqliteApprovalStore } from './store';

function httpStatus(result: ApprovalResult | ApprovalFactsResult): number {
  if (result.status === 'accepted' || result.status === 'found') return 200;
  if (result.status === 'conflict') return 409;
  switch (result.code) {
    case 'SESSION_MISMATCH':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'KEY_REUSED':
      return 409;
    case 'EXPIRED':
      return 410;
    default:
      return 400;
  }
}

export function installHumanApprovalRoutes(
  app: Express,
  options: { dataDir: string; store?: ApprovalStore; database?: LabDatabase },
): { close(): void } {
  let ownedDatabase: LabDatabase | undefined;
  let service: ReturnType<typeof createApprovalService> | undefined;
  let closed = false;

  app.use(APPROVAL_API, (_request, response, next) => {
    response.set('Cache-Control', 'no-store');
    next();
  });

  function getService() {
    if (closed) throw new Error('Human approval routes are closed.');
    if (service) return service;
    let store = options.store;
    if (!store) {
      const database =
        options.database ?? (ownedDatabase = openLabDatabase({ dataDir: options.dataDir }));
      try {
        store = createSqliteApprovalStore(database);
      } catch (error) {
        ownedDatabase?.close();
        ownedDatabase = undefined;
        throw error;
      }
    }
    service = createApprovalService(store);
    return service;
  }

  app.post(`${APPROVAL_API}/commands`, (request, response, next) => {
    try {
      const result = getService().command(
        { teachingSessionId: request.get(TEACHING_SESSION_HEADER) ?? '' },
        request.body,
      );
      // Teaching fault injection happens after the synchronous service transaction has committed.
      if (request.get(DROP_RESPONSE_HEADER) === '1') {
        response.destroy();
        return;
      }
      response.status(httpStatus(result)).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.get(`${APPROVAL_API}/facts`, (request, response, next) => {
    try {
      const result = getService().facts(
        { teachingSessionId: request.get(TEACHING_SESSION_HEADER) ?? '' },
        request.query,
      );
      response.status(httpStatus(result)).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.all([`${APPROVAL_API}/commands`, `${APPROVAL_API}/facts`], (_request, response) => {
    response.status(405).json({
      status: 'rejected',
      code: 'INVALID_INPUT',
      reason: '此接口不支持该请求方法。',
    } satisfies ApprovalResult);
  });

  const malformedJson: ErrorRequestHandler = (error, _request, response, next) => {
    if (error?.type !== 'entity.parse.failed') {
      next(error);
      return;
    }
    response.status(400).json({
      status: 'rejected',
      code: 'INVALID_INPUT',
      reason: '请求正文必须是有效 JSON。',
    } satisfies ApprovalResult);
  };
  app.use(`${APPROVAL_API}/commands`, malformedJson);

  return {
    close() {
      if (closed) return;
      ownedDatabase?.close();
      closed = true;
    },
  };
}
