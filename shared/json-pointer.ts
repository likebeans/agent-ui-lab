export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export function pointerSegments(path: string): string[] {
  if (path === '') return [];
  if (!path.startsWith('/')) throw new Error(`路径必须是绝对 JSON Pointer：${path}`);
  return path
    .slice(1)
    .split('/')
    .map((part) => {
      if (/~(?![01])/u.test(part)) throw new Error(`JSON Pointer 转义不合法：${path}`);
      const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
      if (['__proto__', 'constructor', 'prototype'].includes(key))
        throw new Error('不允许访问原型路径。');
      return key;
    });
}

export function readPointer(model: JsonValue, path: string): JsonValue | undefined {
  let value: JsonValue | undefined = model;
  for (const key of pointerSegments(path)) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    value = (value as JsonObject)[key];
  }
  return value;
}

// Returns a fresh object so React can observe a model update.
// This helper is for the lab's object data model, not an implementation of JSON Patch.
export function writePointer(model: JsonObject, path: string, value: JsonValue): JsonObject {
  const keys = pointerSegments(path);
  if (keys.length === 0) {
    if (value === null || Array.isArray(value) || typeof value !== 'object')
      throw new Error('根数据模型必须是对象。');
    return structuredClone(value);
  }
  const result = structuredClone(model);
  let target = result;
  for (const key of keys.slice(0, -1)) {
    if (!Object.hasOwn(target, key)) target[key] = {};
    const child = target[key];
    if (child === null || Array.isArray(child) || typeof child !== 'object')
      throw new Error(`路径 ${path} 的父节点不是对象。`);
    target = child;
  }
  target[keys.at(-1)!] = structuredClone(value);
  return result;
}
