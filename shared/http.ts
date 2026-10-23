import { STATIC_MODE } from './runtime';

export async function labFetch(url: string, options: RequestInit = {}): Promise<Response> {
  if (STATIC_MODE) {
    const { staticFetch } = await import('./static-api');
    options.signal?.throwIfAborted();
    return staticFetch(url, options);
  }
  return fetch(url, options);
}

export async function fetchJson<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await labFetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const contentType = response.headers.get('content-type');
  if (!contentType?.includes('application/json'))
    throw new Error(`接口未返回 JSON (${response.status})，请检查本地 API 服务。`);
  const value = await response.json();
  if (!response.ok)
    throw new Error(
      typeof value?.error === 'string' ? value.error : `请求失败 (${response.status})`,
    );
  return value as T;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '发生未知错误，请重试。';
}
