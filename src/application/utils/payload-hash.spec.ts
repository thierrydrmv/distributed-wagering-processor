import { describe, expect, test } from 'bun:test';
import { canonicalJson, payloadHash } from './payload-hash';

describe('Payload hashing', () => {
  test('ignores object key ordering, including nested objects', () => {
    expect(
      payloadHash({
        walletId: 'wallet-1',
        money: { amount: '25.00', currency: 'BRL' },
      }),
    ).toBe(
      payloadHash({
        money: { currency: 'BRL', amount: '25.00' },
        walletId: 'wallet-1',
      }),
    );
  });

  test('detects a changed business value', () => {
    expect(payloadHash({ amount: '25.00' })).not.toBe(
      payloadHash({ amount: '25.01' }),
    );
  });

  test('preserves array ordering', () => {
    expect(payloadHash(['a', 'b'])).not.toBe(payloadHash(['b', 'a']));
  });

  test('rejects non-finite numbers', () => {
    expect(() => canonicalJson({ value: NaN })).toThrow();
    expect(() => canonicalJson({ value: Infinity })).toThrow();
  });
});
