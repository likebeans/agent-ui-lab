import { describe, expect, it } from 'vitest';
import { readPointer, writePointer } from '../shared/json-pointer';

describe('data model JSON Pointer bindings', () => {
  it('decodes escaped keys and preserves the original model during editing', () => {
    const original = { trip: { destination: '杭州' }, 'a/b': { '~': 'escaped' } };
    expect(readPointer(original, '/a~1b/~0')).toBe('escaped');
    const edited = writePointer(original, '/trip/destination', '成都');
    expect(readPointer(edited, '/trip/destination')).toBe('成都');
    expect(original.trip.destination).toBe('杭州');
  });

  it('rejects unsafe and malformed pointer paths without touching the prototype', () => {
    expect(() => writePointer({}, '/__proto__/polluted', true)).toThrow();
    expect(() => writePointer({}, '/constructor/prototype/polluted', true)).toThrow();
    expect(() => readPointer({}, '/invalid~2path')).toThrow();
    expect(() => writePointer({}, 'relative', true)).toThrow();
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  });

  it('treats missing data as absent and does not traverse inherited properties', () => {
    expect(readPointer({ trip: {} }, '/trip/destination')).toBeUndefined();
    expect(readPointer({}, '/toString')).toBeUndefined();
    expect(readPointer({ values: ['a', 'b'] }, '/values/1')).toBe('b');
    expect(() => writePointer({ trip: 'text' }, '/trip/destination', '成都')).toThrow('父节点');
  });
});
