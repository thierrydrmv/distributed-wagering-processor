import { describe, expect, test } from 'bun:test';
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
} from '../../domain/entities/wager-transaction';
import { CurrencyMismatchError, Money } from '../../domain/value-objects/money';
import { WagerTransactionProcessed } from './wager-transaction-processed';
import { WagerTransactionRejected } from './wager-transaction-rejected';
import { WagerTransactionPendingReference } from './wager-transaction-pending-reference';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

const context = () => ({
  eventId: 'event-1',
  correlationId: 'correlation-1',
  causationId: 'request-1',
  occurredAt: new Date('2026-10-29T12:01:00.000Z'),
});

const createTransaction = (kind = WagerTransactionKind.Bet): WagerTransaction =>
  WagerTransaction.create({
    id: 'transaction-1',
    providerId: 'provider-a',
    externalTransactionId: 'external-1',
    idempotencyKey: 'provider-a:external-1',
    payloadHash: 'a'.repeat(64),
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: kind === WagerTransactionKind.Loss ? brl('0.00') : brl('25.00'),
    referenceExternalTransactionId:
      kind === WagerTransactionKind.Refund ? 'original-bet' : undefined,
    createdAt: new Date('2026-10-29T12:00:00.000Z'),
  });

describe('Wager transaction integration events', () => {
  test('creates a processed event with the original balance', () => {
    const transaction = createTransaction();
    transaction.markProcessed(undefined, context().occurredAt);

    const event = WagerTransactionProcessed.from(
      transaction,
      brl('75.00'),
      context(),
    );

    const envelope = event.toJSON();

    expect(envelope.eventType).toBe('WagerTransactionProcessed');
    expect(envelope.version).toBe(1);
    expect(envelope.aggregateId).toBe('wallet-1');
    expect(envelope.correlationId).toBe('correlation-1');
    expect(envelope.data.transactionId).toBe('transaction-1');
    expect(envelope.data.money.amount).toBe('25.00');
    expect(envelope.data.balance.amount).toBe('75.00');
    expect(envelope.data.processedAt).toBe('2026-10-29T12:01:00.000Z');

    const serialized: unknown = JSON.parse(JSON.stringify(envelope));

    expect(serialized).toEqual(envelope);
  });

  test('creates a processed event for LOSS without a movement', () => {
    const transaction = createTransaction(WagerTransactionKind.Loss);
    transaction.markProcessed(undefined, context().occurredAt);

    const event = WagerTransactionProcessed.from(
      transaction,
      brl('100.00'),
      context(),
    );

    expect(event.data.money.amount).toBe('0.00');
    expect(event.data.balance.amount).toBe('100.00');
    expect(transaction.affectsBalance()).toBe(false);
  });

  test('creates a rejection event with a stable failure code', () => {
    const transaction = createTransaction();
    transaction.reject(FailureCode.InsufficientBalance);

    const event = WagerTransactionRejected.from(
      transaction,
      brl('10.00'),
      context(),
    );

    expect(event.eventType).toBe('WagerTransactionRejected');
    expect(event.data.failureCode).toBe(FailureCode.InsufficientBalance);
    expect(event.data.balance?.amount).toBe('10.00');
  });

  test('allows a rejection without an observed balance', () => {
    const transaction = createTransaction();
    transaction.reject(FailureCode.WalletNotFound);

    const event = WagerTransactionRejected.from(transaction, null, context());

    expect(event.data.balance).toBeNull();
  });

  test('creates an event identifying the missing reference', () => {
    const transaction = createTransaction(WagerTransactionKind.Refund);
    transaction.markPendingReference();

    const event = WagerTransactionPendingReference.from(transaction, context());

    expect(event.eventType).toBe('WagerTransactionPendingReference');
    expect(event.data.referenceExternalTransactionId).toBe('original-bet');
    expect(event.data.referenceTransactionId).toBeNull();
  });

  test('rejects events incompatible with transaction status', () => {
    const pending = createTransaction();

    expect(() =>
      WagerTransactionProcessed.from(pending, brl('100.00'), context()),
    ).toThrow('Processed event requires a processed transaction');

    expect(() =>
      WagerTransactionRejected.from(pending, null, context()),
    ).toThrow('Rejected event requires a rejected transaction');

    expect(() =>
      WagerTransactionPendingReference.from(pending, context()),
    ).toThrow(
      'Pending reference event requires a transaction awaiting a reference',
    );
  });

  test('rejects a balance in another currency', () => {
    const transaction = createTransaction();
    transaction.markProcessed(undefined, context().occurredAt);

    expect(() =>
      WagerTransactionProcessed.from(
        transaction,
        Money.from({ amount: '75.00', currency: 'GBP' }),
        context(),
      ),
    ).toThrow(CurrencyMismatchError);
  });

  test('rejects a negative observed balance', () => {
    const transaction = createTransaction();
    transaction.reject(FailureCode.InsufficientBalance);

    expect(() =>
      WagerTransactionRejected.from(
        transaction,
        brl('1.00').negate(),
        context(),
      ),
    ).toThrow('Event balance cannot be negative');
  });
});
