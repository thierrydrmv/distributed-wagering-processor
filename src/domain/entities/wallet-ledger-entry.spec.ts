import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, Money } from '../value-objects/money';
import {
  InvalidLedgerEntryError,
  LedgerDirection,
  WalletLedgerEntry,
} from './wallet-ledger-entry';
import type { LedgerEntryState } from './wallet-ledger-entry';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

const validDebit = (): LedgerEntryState => ({
  id: 'entry-1',
  walletId: 'wallet-1',
  transactionId: 'transaction-1',
  direction: LedgerDirection.Debit,
  money: brl('25.00'),
  balanceBefore: brl('100.00'),
  balanceAfter: brl('75.00'),
  createdAt: new Date('2026-10-28T12:00:00.000Z'),
});

describe('WalletLedgerEntry', () => {
  test('creates a balanced debit', () => {
    const entry = WalletLedgerEntry.create(validDebit());

    expect(entry.isBalanced()).toBe(true);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceAfter.toJSON().amount).toBe('75.00');
  });

  test('creates a balanced credit', () => {
    const entry = WalletLedgerEntry.create({
      ...validDebit(),
      direction: LedgerDirection.Credit,
      balanceAfter: brl('125.00'),
    });

    expect(entry.isBalanced()).toBe(true);
  });

  test('allows a debit that leaves a zero balance', () => {
    const entry = WalletLedgerEntry.create({
      ...validDebit(),
      money: brl('100.00'),
      balanceAfter: brl('0.00'),
    });

    expect(entry.isBalanced()).toBe(true);
    expect(entry.balanceAfter.isZero()).toBe(true);
  });

  test('rejects inconsistent arithmetic', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...validDebit(),
        balanceAfter: brl('80.00'),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('rejects zero and negative amounts', () => {
    for (const money of [brl('0.00'), brl('1.00').negate()]) {
      expect(() =>
        WalletLedgerEntry.create({
          ...validDebit(),
          money,
        }),
      ).toThrow(InvalidLedgerEntryError);
    }
  });

  test('rejects negative balances', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...validDebit(),
        balanceBefore: brl('10.00'),
        balanceAfter: brl('15.00').negate(),
      }),
    ).toThrow(InvalidLedgerEntryError);

    expect(() =>
      WalletLedgerEntry.create({
        ...validDebit(),
        direction: LedgerDirection.Credit,
        money: brl('25.00'),
        balanceBefore: brl('10.00').negate(),
        balanceAfter: brl('15.00'),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('rejects a movement in a different currency', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...validDebit(),
        money: Money.from({ amount: '25.00', currency: 'GBP' }),
      }),
    ).toThrow(CurrencyMismatchError);
  });

  test('rejects a resulting balance in a different currency', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...validDebit(),
        balanceAfter: Money.from({
          amount: '75.00',
          currency: 'GBP',
        }),
      }),
    ).toThrow(CurrencyMismatchError);
  });

  test('rejects an invalid creation date', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...validDebit(),
        createdAt: new Date('invalid'),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('protects its creation date from external mutation', () => {
    const props = validDebit();
    const originalTimestamp = props.createdAt.getTime();
    const entry = WalletLedgerEntry.create(props);

    props.createdAt.setTime(0);
    entry.createdAt.setTime(0);

    expect(entry.createdAt.getTime()).toBe(originalTimestamp);
    expect(Object.isFrozen(entry)).toBe(true);
  });

  test('rehydrates persisted state without revalidating business rules', () => {
    const entry = WalletLedgerEntry.rehydrate({
      ...validDebit(),
      balanceAfter: brl('80.00'),
    });

    expect(entry.id).toBe('entry-1');
    expect(entry.isBalanced()).toBe(false);
  });
});
