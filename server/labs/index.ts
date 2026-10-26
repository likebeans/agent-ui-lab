import type { Express } from 'express';
import { z } from 'zod';
import type { RuntimeConfig } from '../../config/runtime';
import { runFoundation } from '../../shared/labs/foundation/engine';
import { RECOVERY_API } from '../../shared/labs/task-recovery/contract';
import { openLabDatabase, type LabDatabase } from '../storage/sqlite';
import { installA2uiCompatibilityRoutes } from './a2ui-compatibility/index';
import { installHumanApprovalRoutes } from './human-approval/routes';
import { createSqliteApprovalStore } from './human-approval/store';
import { createTaskRecoveryRouter } from './task-recovery';
import { WORKFLOW_API } from '../../shared/labs/enrollment-workflow/contract';
import { createWorkflowRouter, workflowMalformedJson } from './enrollment-workflow';

// Add each lab's HTTP adapter here; never import this module from a browser manifest.
export function installLabRoutes(
  app: Express,
  config: RuntimeConfig,
  options: { database?: LabDatabase } = {},
) {
  const database = options.database ?? openLabDatabase({ dataDir: config.dataDir });
  const cleanups: Array<() => void> = options.database ? [] : [() => database.close()];
  function close() {
    const errors: unknown[] = [];
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Lab resource cleanup failed.');
  }

  try {
    const recovery = createTaskRecoveryRouter({ database });
    cleanups.push(() => recovery.close());
    app.use(RECOVERY_API, recovery.router);
    const approval = installHumanApprovalRoutes(app, {
      dataDir: config.dataDir,
      store: createSqliteApprovalStore(database),
    });
    cleanups.push(() => approval.close());
    installA2uiCompatibilityRoutes(app);
    app.use(WORKFLOW_API, createWorkflowRouter(database));
    app.use(`${WORKFLOW_API}/commands`, workflowMalformedJson);
    app.post('/api/labs/foundation/run', (request, response, next) => {
      try {
        response.json(runFoundation(request.body));
      } catch (error) {
        if (error instanceof z.ZodError) {
          response.status(400).json({ error: error.issues[0]?.message ?? '输入无效。' });
        } else next(error);
      }
    });
    return close;
  } catch (error) {
    try {
      close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Lab initialization and cleanup failed.');
    }
    throw error;
  }
}
