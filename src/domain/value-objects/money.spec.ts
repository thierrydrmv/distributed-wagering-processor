import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError, Money } from './money';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  test('serializes with two decimal places', () => {
    expect(brl('25.00').toJSON()).toEqual({
      amount: '25.00',
      currency: 'BRL',
    });
  });

  test('adds decimal amounts exactly without changing the operands', () => {
    const first = brl('0.10');
    const second = brl('0.20');
    const result = first.add(second);

    expect(result.toJSON().amount).toBe('0.30');
    expect(first.toJSON().amount).toBe('0.10');
    expect(second.toJSON().amount).toBe('0.20');
    expect(result).not.toBe(first);
    expect(result).not.toBe(second);
  });

  test('subtracts and permits negative internal results', () => {
    const original = brl('10.00');
    const result = original.subtract(brl('15.25'));

    expect(result.toJSON().amount).toBe('-5.25');
    expect(result.isNegative()).toBe(true);
    expect(original.toJSON().amount).toBe('10.00');
  });

  test('negates without changing the original', () => {
    const original = brl('25.00');

    expect(original.negate().toJSON().amount).toBe('-25.00');
    expect(original.toJSON().amount).toBe('25.00');
    expect(original.negate().negate().equals(original)).toBe(true);
  });

  test('zero is neither positive nor negative', () => {
    const zero = Money.zero('BRL');

    expect(zero.isZero()).toBe(true);
    expect(zero.isPositive()).toBe(false);
    expect(zero.isNegative()).toBe(false);
    expect(zero.negate().toJSON().amount).toBe('0.00');
  });

  test('compares monetary values', () => {
    expect(brl('1.00').isLessThan(brl('2.00'))).toBe(true);
    expect(brl('2.00').isLessThan(brl('1.00'))).toBe(false);
    expect(brl('2.00').equals(brl('2.00'))).toBe(true);
    expect(brl('2.00').equals(brl('2.01'))).toBe(false);
    expect(brl('1.00').isPositive()).toBe(true);
  });

  test.each([
    '',
    ' ',
    'NaN',
    'Infinity',
    '1e2',
    '-1.00',
    '-0.00',
    '+1.00',
    '1',
    '1.0',
    '1.001',
    '1.000',
    '01.00',
    '1,00',
    ' 1.00',
    '1.00 ',
    '1000000000000000000.00',
  ])('rejects invalid input: "%s"', (amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test('rejects unsupported currencies', () => {
    expect(() => Money.from({ amount: '1.00', currency: 'INVALID' })).toThrow(
      InvalidMoneyError,
    );

    expect(() => Money.zero('brl')).toThrow(InvalidMoneyError);
  });

  test('rejects operations between different currencies', () => {
    const real = brl('10.00');
    const dollar = Money.from({
      amount: '10.00',
      currency: 'USD',
    });

    expect(() => real.add(dollar)).toThrow(CurrencyMismatchError);
    expect(() => real.subtract(dollar)).toThrow(CurrencyMismatchError);
    expect(() => real.isLessThan(dollar)).toThrow(CurrencyMismatchError);
    expect(() => real.equals(dollar)).toThrow(CurrencyMismatchError);
  });

  test('preserves cents for large amounts', () => {
    const result = brl('999999999999999999.98').add(brl('0.01'));

    expect(result.toJSON().amount).toBe('999999999999999999.99');
  });

  test('rejects arithmetic overflow', () => {
    expect(() => brl('999999999999999999.99').add(brl('0.01'))).toThrow(
      InvalidMoneyError,
    );
  });

  test('serializes as a JSON object with a string amount', () => {
    expect(JSON.stringify(brl('25.00'))).toBe(
      '{"amount":"25.00","currency":"BRL"}',
    );
  });

  test('supports British pounds', () => {
    const pounds = Money.from({
      amount: '25.00',
      currency: 'GBP',
    });

    expect(pounds.toJSON()).toEqual({
      amount: '25.00',
      currency: 'GBP',
    });

    expect(
      pounds.add(Money.from({ amount: '0.50', currency: 'GBP' })).toJSON()
        .amount,
    ).toBe('25.50');

    expect(Money.zero('GBP').toJSON()).toEqual({
      amount: '0.00',
      currency: 'GBP',
    });
  });

  test('rejects operations between pounds and reais', () => {
    const pounds = Money.from({
      amount: '10.00',
      currency: 'GBP',
    });
    const reais = brl('10.00');

    expect(() => pounds.add(reais)).toThrow(CurrencyMismatchError);
    expect(() => pounds.subtract(reais)).toThrow(CurrencyMismatchError);
    expect(() => pounds.isLessThan(reais)).toThrow(CurrencyMismatchError);
    expect(() => pounds.equals(reais)).toThrow(CurrencyMismatchError);
  });
});
