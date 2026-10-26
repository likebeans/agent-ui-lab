import type { ApprovalFactsResult, ApprovalResult } from '../human-approval/types';

export function workflowHttpStatus(result: ApprovalResult | ApprovalFactsResult): number {
  if (result.status === 'accepted' || result.status === 'found') return 200;
  if (result.status === 'conflict' || result.code === 'KEY_REUSED') return 409;
  if (result.code === 'SESSION_MISMATCH') return 403;
  if (result.code === 'NOT_FOUND') return 404;
  if (result.code === 'EXPIRED') return 410;
  return 400;
}

export function queryFromSearch(search: URLSearchParams): Record<string, string | string[]> {
  return Object.fromEntries(
    [...new Set(search.keys())].map((key) => {
      const values = search.getAll(key);
      return [key, values.length === 1 ? values[0] : values];
    }),
  );
}
