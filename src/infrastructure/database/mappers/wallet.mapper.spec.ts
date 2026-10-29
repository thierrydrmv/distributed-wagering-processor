import { describe, expect, test } from 'bun:test';
import { Wallet } from '../../../domain/entities/wallet';
import { Money } from '../../../domain/value-objects/money';
import { WalletMapper } from './wallet.mapper';
import { WalletLedgerEntryMapper } from './wallet-ledger-entry.mapper';

describe('Wallet persistence mapping', () => {
  test('preserves a large GBP balance, dates and version', () => {
    const createdAt = new Date('2026-10-28T12:00:00.000Z');
    const updatedAt = new Date('2026-10-28T12:01:00.000Z');

    const wallet = Wallet.rehydrate({
      id: 'wallet-1',
      playerId: 'player-1',
      currency: 'GBP',
      balance: Money.from({
        amount: '999999999999999999.99',
        currency: 'GBP',
      }),
      version: 42,
      createdAt,
      updatedAt,
    });

    const record = WalletMapper.toRecord(wallet);

    expect(record.balance).toBe('999999999999999999.99');
    expect(typeof record.balance).toBe('string');

    const restored = WalletMapper.toDomain(record);

    expect(restored.id).toBe(wallet.id);
    expect(restored.playerId).toBe(wallet.playerId);
    expect(restored.currency).toBe('GBP');
    expect(restored.balance.equals(wallet.balance)).toBe(true);
    expect(restored.version).toBe(42);
    expect(restored.createdAt).toEqual(createdAt);
    expect(restored.updatedAt).toEqual(updatedAt);
  });

  test('preserves a debit ledger entry and its arithmetic', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.from({
        amount: '100.00',
        currency: 'BRL',
      }),
      at: new Date('2026-10-28T12:00:00.000Z'),
    });

    const entry = wallet.debit({
      entryId: 'entry-1',
      transactionId: 'transaction-1',
      money: Money.from({
        amount: '0.01',
        currency: 'BRL',
      }),
      at: new Date('2026-10-28T12:01:00.000Z'),
    });

    const record = WalletLedgerEntryMapper.toRecord(entry);

    expect(record.amount).toBe('0.01');
    expect(record.balanceBefore).toBe('100.00');
    expect(record.balanceAfter).toBe('99.99');

    const restored = WalletLedgerEntryMapper.toDomain(record);

    expect(restored.id).toBe(entry.id);
    expect(restored.walletId).toBe(entry.walletId);
    expect(restored.transactionId).toBe(entry.transactionId);
    expect(restored.direction).toBe(entry.direction);
    expect(restored.money.equals(entry.money)).toBe(true);
    expect(restored.createdAt).toEqual(entry.createdAt);
    expect(restored.isBalanced()).toBe(true);
  });
});
