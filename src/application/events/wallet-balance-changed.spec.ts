import { describe, expect, test } from 'bun:test';
import { Wallet } from '../../domain/entities/wallet';
import { Money } from '../../domain/value-objects/money';
import { WalletBalanceChanged } from './wallet-balance-changed';
import { LedgerDirection } from 'src/domain/entities/wallet-ledger-entry';

const createEvent = () => {
  const wallet = Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: Money.from({
      amount: '100.00',
      currency: 'GBP',
    }),
    at: new Date('2026-10-29T12:00:00.000Z'),
  });

  const entry = wallet.debit({
    entryId: 'entry-1',
    transactionId: 'transaction-1',
    money: Money.from({
      amount: '25.00',
      currency: 'GBP',
    }),
    at: new Date('2026-10-29T12:01:00.000Z'),
  });

  const at = new Date('2026-10-29T12:01:00.000Z');

  const event = WalletBalanceChanged.from(wallet, entry, {
    eventId: 'event-1',
    correlationId: 'correlation-1',
    causationId: 'request-1',
    occurredAt: at,
  });

  return { wallet, entry, event, at };
};

describe('WalletBalanceChanged', () => {
  test('serializes the financial snapshot in a versioned envelope', () => {
    const { event } = createEvent();

    expect(event.toJSON()).toEqual({
      eventId: 'event-1',
      eventType: 'WalletBalanceChanged',
      aggregateId: 'wallet-1',
      correlationId: 'correlation-1',
      causationId: 'request-1',
      occurredAt: '2026-10-29T12:01:00.000Z',
      version: 1,
      data: {
        walletId: 'wallet-1',
        transactionId: 'transaction-1',
        direction: LedgerDirection.Debit,
        money: { amount: '25.00', currency: 'GBP' },
        balanceBefore: { amount: '100.00', currency: 'GBP' },
        balanceAfter: { amount: '75.00', currency: 'GBP' },
        walletVersion: 2,
      },
    });
  });

  test('preserves its snapshot after another wallet movement', () => {
    const { wallet, event } = createEvent();

    wallet.credit({
      entryId: 'entry-2',
      transactionId: 'transaction-2',
      money: Money.from({
        amount: '10.00',
        currency: 'GBP',
      }),
      at: new Date('2026-10-29T12:02:00.000Z'),
    });

    expect(wallet.balance.toJSON().amount).toBe('85.00');
    expect(event.data.balanceAfter.amount).toBe('75.00');
    expect(event.data.walletVersion).toBe(2);
  });

  test('protects its date and payload from external mutation', () => {
    const { event, at } = createEvent();

    at.setTime(0);
    event.occurredAt.setTime(0);

    const envelope = event.toJSON();
    envelope.data.balanceAfter.amount = '999.00';

    expect(event.occurredAt.toISOString()).toBe('2026-10-29T12:01:00.000Z');
    expect(event.data.balanceAfter.amount).toBe('75.00');

    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.data.balanceAfter)).toBe(true);
  });

  test('rejects a wallet that has moved beyond the ledger snapshot', () => {
    const { wallet, entry } = createEvent();

    wallet.credit({
      entryId: 'entry-2',
      transactionId: 'transaction-2',
      money: Money.from({
        amount: '10.00',
        currency: 'GBP',
      }),
      at: new Date(),
    });

    expect(() =>
      WalletBalanceChanged.from(wallet, entry, {
        eventId: 'event-2',
        correlationId: 'correlation-1',
        occurredAt: new Date(),
      }),
    ).toThrow(
      'Wallet balance event requires a matching wallet and ledger entry',
    );
  });
});
