import { describe, expect, test } from 'bun:test';
import { Wallet } from '../../domain/entities/wallet';
import { Money } from '../../domain/value-objects/money';
import { WalletBalanceChanged } from '../events/wallet-balance-changed';
import { OutboxMessage } from './outbox-message';

const createMessage = (): OutboxMessage => {
  const at = new Date('2026-10-29T12:00:00.000Z');

  const wallet = Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: Money.zero('BRL'),
    at,
  });

  const entry = wallet.credit({
    entryId: 'entry-1',
    transactionId: 'transaction-1',
    money: Money.from({ amount: '10.00', currency: 'BRL' }),
    at,
  });

  return OutboxMessage.enqueue(
    WalletBalanceChanged.from(wallet, entry, {
      eventId: 'event-1',
      correlationId: 'correlation-1',
      occurredAt: at,
    }),
  );
};

describe('OutboxMessage', () => {
  test('starts pending and preserves the event identity', () => {
    const message = createMessage();

    expect(message.id).toBe('event-1');
    expect(message.attempts).toBe(0);
    expect(message.isPending()).toBe(true);
    expect(message.isDue(new Date())).toBe(true);
    expect(message.toState().payload.eventId).toBe(message.id);
  });

  test('schedules exponential backoff capped at thirty seconds', () => {
    const message = createMessage();
    const now = new Date('2026-10-29T12:01:00.000Z');

    message.scheduleRetry(now);

    expect(message.attempts).toBe(1);
    expect(message.nextAttemptAt?.getTime()).toBe(now.getTime() + 1_000);
    expect(message.isDue(now)).toBe(false);

    message.scheduleRetry(now);

    expect(message.nextAttemptAt?.getTime()).toBe(now.getTime() + 2_000);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      message.scheduleRetry(now);
    }

    expect(message.nextAttemptAt?.getTime()).toBe(now.getTime() + 30_000);
  });

  test('published messages cannot be retried or published again', () => {
    const message = createMessage();
    const at = new Date();

    message.markPublished(at);

    expect(message.isPending()).toBe(false);
    expect(message.isDue(at)).toBe(false);
    expect(() => message.scheduleRetry(at)).toThrow();
    expect(() => message.markPublished(at)).toThrow();
  });

  test('does not expose mutable internal state', () => {
    const message = createMessage();
    const state = message.toState();

    state.payload.eventId = 'changed';
    state.occurredAt.setTime(0);

    expect(message.toState().payload.eventId).toBe('event-1');
    expect(message.toState().occurredAt.toISOString()).toBe(
      '2026-10-29T12:00:00.000Z',
    );
  });
});
