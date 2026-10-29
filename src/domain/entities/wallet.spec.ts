import { describe, expect, test } from 'bun:test';
import {
  CurrencyMismatchError,
  InvalidMoneyError,
  Money,
} from '../value-objects/money';
import {
  InsufficientBalanceError,
  InvalidWalletOperationError,
  Wallet,
} from './wallet';
import { LedgerDirection } from './wallet-ledger-entry';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

const openedAt = new Date('2026-10-28T12:00:00.000Z');
const movementAt = new Date('2026-10-28T12:01:00.000Z');

const openWallet = (amount = '100.00'): Wallet =>
  Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(amount),
    at: openedAt,
  });

const movement = (money: Money) => ({
  entryId: 'entry-1',
  transactionId: 'transaction-1',
  money,
  at: new Date(movementAt),
});

describe('Wallet', () => {
  test('opens with version one and the initial balance', () => {
    const wallet = openWallet();

    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.currency).toBe('BRL');
    expect(wallet.version).toBe(1);
    expect(wallet.createdAt).toEqual(openedAt);
    expect(wallet.updatedAt).toEqual(openedAt);
  });

  test('allows opening with zero balance', () => {
    expect(openWallet('0.00').balance.isZero()).toBe(true);
  });

  test('rejects a negative initial balance', () => {
    expect(() =>
      Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: brl('1.00').negate(),
        at: openedAt,
      }),
    ).toThrow(InvalidWalletOperationError);
  });

  test('debits and returns the corresponding ledger entry', () => {
    const wallet = openWallet();
    const entry = wallet.debit(movement(brl('25.00')));

    expect(wallet.balance.toJSON().amount).toBe('75.00');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(movementAt);
    expect(entry.walletId).toBe(wallet.id);
    expect(entry.transactionId).toBe('transaction-1');
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
    expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);
    expect(entry.isBalanced()).toBe(true);
  });

  test('credits and returns the corresponding ledger entry', () => {
    const wallet = openWallet();
    const entry = wallet.credit(movement(brl('25.00')));

    expect(wallet.balance.toJSON().amount).toBe('125.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);
    expect(entry.isBalanced()).toBe(true);
  });

  test('allows spending the exact available balance', () => {
    const wallet = openWallet();

    wallet.debit(movement(brl('100.00')));

    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(2);
  });

  test('insufficient balance leaves the wallet unchanged', () => {
    const wallet = openWallet();

    expect(() => wallet.debit(movement(brl('100.01')))).toThrow(
      InsufficientBalanceError,
    );

    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(openedAt);
  });

  test('rejects zero and negative movements without changing state', () => {
    const wallet = openWallet();

    for (const money of [brl('0.00'), brl('1.00').negate()]) {
      expect(() => wallet.debit(movement(money))).toThrow(
        InvalidWalletOperationError,
      );

      expect(() => wallet.credit(movement(money))).toThrow(
        InvalidWalletOperationError,
      );
    }

    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  test('rejects movements in another currency', () => {
    const wallet = openWallet();
    const pounds = Money.from({
      amount: '10.00',
      currency: 'GBP',
    });

    expect(() => wallet.credit(movement(pounds))).toThrow(
      CurrencyMismatchError,
    );
    expect(() => wallet.debit(movement(pounds))).toThrow(CurrencyMismatchError);

    expect(wallet.version).toBe(1);
    expect(wallet.balance.toJSON().amount).toBe('100.00');
  });

  test('overflow leaves the wallet unchanged', () => {
    const wallet = openWallet('999999999999999999.99');

    expect(() => wallet.credit(movement(brl('0.01')))).toThrow(
      InvalidMoneyError,
    );

    expect(wallet.version).toBe(1);
    expect(wallet.balance.toJSON().amount).toBe('999999999999999999.99');
  });

  test('rejects an invalid movement date without changing state', () => {
    const wallet = openWallet();

    expect(() =>
      wallet.credit({
        ...movement(brl('10.00')),
        at: new Date('invalid'),
      }),
    ).toThrow(InvalidWalletOperationError);

    expect(wallet.version).toBe(1);
    expect(wallet.balance.toJSON().amount).toBe('100.00');
  });

  test('protects dates against external mutation', () => {
    const at = new Date(openedAt);
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: brl('100.00'),
      at,
    });

    at.setTime(0);
    wallet.createdAt.setTime(0);
    wallet.updatedAt.setTime(0);

    expect(wallet.createdAt).toEqual(openedAt);
    expect(wallet.updatedAt).toEqual(openedAt);

    const props = movement(brl('10.00'));
    wallet.credit(props);
    props.at.setTime(0);

    expect(wallet.updatedAt).toEqual(movementAt);
  });

  test('rehydrates the persisted balance and version', () => {
    const wallet = Wallet.rehydrate({
      id: 'wallet-1',
      playerId: 'player-1',
      currency: 'BRL',
      balance: brl('75.00'),
      version: 8,
      createdAt: openedAt,
      updatedAt: movementAt,
    });

    expect(wallet.balance.toJSON().amount).toBe('75.00');
    expect(wallet.version).toBe(8);
  });
});
