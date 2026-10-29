import { describe, expect, test } from 'bun:test';
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../domain/entities/wager-transaction';
import {
  CurrencyMismatchError,
  Money,
} from '../../../domain/value-objects/money';
import { WagerTransactionMapper } from './wager-transaction.mapper';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

const createTransaction = (): WagerTransaction =>
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
    kind: WagerTransactionKind.Bet,
    money: brl('25.00'),
    createdAt: new Date('2026-10-29T12:00:00.000Z'),
  });

describe('WagerTransactionMapper', () => {
  test('preserves pending transaction identity and amount', () => {
    const transaction = createTransaction();
    const record = WagerTransactionMapper.toRecord(transaction);
    const restored = WagerTransactionMapper.toDomain(record);

    expect(record.amount).toBe('25.00');
    expect(record.resultBalance).toBeNull();
    expect(record.processedAt).toBeNull();
    expect(record.failureCode).toBeNull();

    expect(restored.id).toBe(transaction.id);
    expect(restored.providerId).toBe(transaction.providerId);
    expect(restored.externalTransactionId).toBe(
      transaction.externalTransactionId,
    );
    expect(restored.idempotencyKey).toBe(transaction.idempotencyKey);
    expect(restored.payloadHash).toBe(transaction.payloadHash);
    expect(restored.walletId).toBe(transaction.walletId);
    expect(restored.playerId).toBe(transaction.playerId);
    expect(restored.roundId).toBe(transaction.roundId);
    expect(restored.gameId).toBe(transaction.gameId);
    expect(restored.kind).toBe(transaction.kind);
    expect(restored.money.equals(transaction.money)).toBe(true);
    expect(restored.status).toBe(WagerTransactionStatus.Pending);
    expect(restored.createdAt).toEqual(transaction.createdAt);
    expect(restored.referenceTransactionId).toBeUndefined();
  });

  test('preserves the original processed balance and timestamp', () => {
    const transaction = createTransaction();
    const at = new Date('2026-10-29T12:01:00.000Z');

    transaction.markProcessed(undefined, at);

    const record = WagerTransactionMapper.toRecord(transaction, brl('75.00'));

    const restored = WagerTransactionMapper.toDomain(record);
    const resultBalance = WagerTransactionMapper.toResultBalance(record);

    expect(record.resultBalance).toBe('75.00');
    expect(restored.status).toBe(WagerTransactionStatus.Processed);
    expect(restored.processedAt).toEqual(at);
    expect(resultBalance?.toJSON()).toEqual({
      amount: '75.00',
      currency: 'BRL',
    });
  });

  test('requires a balance for a processed transaction', () => {
    const transaction = createTransaction();
    transaction.markProcessed(undefined, new Date());

    expect(() => WagerTransactionMapper.toRecord(transaction)).toThrow(
      'Processed transactions require the original result balance',
    );
  });

  test('preserves a zero result balance', () => {
    const transaction = createTransaction();
    transaction.markProcessed(undefined, new Date());

    const record = WagerTransactionMapper.toRecord(transaction, brl('0.00'));

    expect(record.resultBalance).toBe('0.00');
    expect(WagerTransactionMapper.toResultBalance(record)?.isZero()).toBe(true);
  });

  test('preserves rejection details and observed balance', () => {
    const transaction = createTransaction();
    transaction.reject(FailureCode.InsufficientBalance);

    const record = WagerTransactionMapper.toRecord(transaction, brl('10.00'));

    const restored = WagerTransactionMapper.toDomain(record);

    expect(restored.status).toBe(WagerTransactionStatus.Rejected);
    expect(restored.failureCode).toBe(FailureCode.InsufficientBalance);
    expect(restored.processedAt).toBeUndefined();
    expect(record.resultBalance).toBe('10.00');
  });

  test('preserves a permanent failure without a balance', () => {
    const transaction = createTransaction();
    transaction.fail(FailureCode.PermanentInfrastructureFailure);

    const record = WagerTransactionMapper.toRecord(transaction);
    const restored = WagerTransactionMapper.toDomain(record);

    expect(restored.status).toBe(WagerTransactionStatus.Failed);
    expect(restored.failureCode).toBe(
      FailureCode.PermanentInfrastructureFailure,
    );
    expect(WagerTransactionMapper.toResultBalance(record)).toBeNull();
  });

  test('preserves pending and resolved reference states', () => {
    const transaction = WagerTransaction.create({
      id: 'refund-1',
      providerId: 'provider-a',
      externalTransactionId: 'refund-external-1',
      idempotencyKey: 'provider-a:refund-external-1',
      payloadHash: 'b'.repeat(64),
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Refund,
      money: brl('25.00'),
      referenceExternalTransactionId: 'external-1',
      createdAt: new Date('2026-10-29T12:02:00.000Z'),
    });

    transaction.markPendingReference();

    const pending = WagerTransactionMapper.toDomain(
      WagerTransactionMapper.toRecord(transaction),
    );

    expect(pending.status).toBe(WagerTransactionStatus.PendingReference);
    expect(pending.referenceExternalTransactionId).toBe('external-1');

    transaction.markProcessed('transaction-1', new Date());

    const processed = WagerTransactionMapper.toDomain(
      WagerTransactionMapper.toRecord(transaction, brl('100.00')),
    );

    expect(processed.referenceTransactionId).toBe('transaction-1');
  });

  test('rejects a result balance in another currency', () => {
    const transaction = createTransaction();
    transaction.markProcessed(undefined, new Date());

    expect(() =>
      WagerTransactionMapper.toRecord(
        transaction,
        Money.from({ amount: '75.00', currency: 'GBP' }),
      ),
    ).toThrow(CurrencyMismatchError);
  });

  test('rejects negative result balances', () => {
    const transaction = createTransaction();
    transaction.markProcessed(undefined, new Date());

    expect(() =>
      WagerTransactionMapper.toRecord(transaction, brl('1.00').negate()),
    ).toThrow('Result balance cannot be negative');
  });

  test('rejects a result balance for a pending transaction', () => {
    expect(() =>
      WagerTransactionMapper.toRecord(createTransaction(), brl('100.00')),
    ).toThrow('Pending transactions cannot have a result balance');
  });
});
