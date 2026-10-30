import { createHash } from 'node:crypto';

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error('Canonical JSON requires finite numbers');
    }

    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }

  const properties = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);

  return `{${properties.join(',')}}`;
}

export function payloadHash(value: JsonValue): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
