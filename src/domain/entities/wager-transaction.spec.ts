import { describe, expect, test } from 'bun:test';
import { Money } from '../value-objects/money';
import { LedgerDirection } from './wallet-ledger-entry';
import {
  FailureCode,
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  InvalidTransactionReferenceError,
} from './wager-transaction';
import type { CreateWagerTransactionProps } from './wager-transaction';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

const props = (
  overrides: Partial<CreateWagerTransactionProps> = {},
): CreateWagerTransactionProps => ({
  id: 'transaction-1',
  providerId: 'provider-a',
  externalTransactionId: 'external-1',
  idempotencyKey: 'provider-a:external-1',
  payloadHash: 'payload-hash',
  walletId: 'wallet-1',
  playerId: 'player-1',
  roundId: 'round-1',
  gameId: 'game-1',
  kind: WagerTransactionKind.Bet,
  money: brl('25.00'),
  createdAt: new Date('2026-10-28T12:00:00.000Z'),
  ...overrides,
});

const refund = (): WagerTransaction =>
  WagerTransaction.create(
    props({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'original-bet',
    }),
  );

describe('WagerTransaction', () => {
  test('starts pending without a processing result', () => {
    const transaction = WagerTransaction.create(props());

    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    expect(transaction.isTerminal()).toBe(false);
    expect(transaction.processedAt).toBeUndefined();
    expect(transaction.failureCode).toBeUndefined();
    expect(transaction.affectsBalance()).toBe(true);
  });

  test.each([WagerTransactionKind.Refund, WagerTransactionKind.Rollback])(
    '%s requires an external reference',
    (kind) => {
      expect(() => WagerTransaction.create(props({ kind }))).toThrow(
        InvalidWagerTransactionError,
      );
    },
  );

  test('rejects a self-reference', () => {
    expect(() =>
      WagerTransaction.create(
        props({
          kind: WagerTransactionKind.Refund,
          referenceExternalTransactionId: 'external-1',
        }),
      ),
    ).toThrow(InvalidWagerTransactionError);
  });

  test('LOSS requires zero and has no financial effect', () => {
    expect(() =>
      WagerTransaction.create(props({ kind: WagerTransactionKind.Loss })),
    ).toThrow(InvalidWagerTransactionError);

    const loss = WagerTransaction.create(
      props({
        kind: WagerTransactionKind.Loss,
        money: brl('0.00'),
      }),
    );

    expect(loss.affectsBalance()).toBe(false);
  });

  test('WIN permits zero without a financial effect', () => {
    const win = WagerTransaction.create(
      props({
        kind: WagerTransactionKind.Win,
        money: brl('0.00'),
      }),
    );

    expect(win.affectsBalance()).toBe(false);
  });

  test('BET rejects zero and negative amounts', () => {
    for (const money of [brl('0.00'), brl('1.00').negate()]) {
      expect(() => WagerTransaction.create(props({ money }))).toThrow(
        InvalidWagerTransactionError,
      );
    }
  });

  test('waits for a reference and then becomes processed', () => {
    const transaction = refund();
    const at = new Date('2026-10-28T12:01:00.000Z');

    transaction.markPendingReference();

    expect(transaction.status).toBe(WagerTransactionStatus.PendingReference);

    transaction.markProcessed('internal-bet-id', at);

    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.referenceTransactionId).toBe('internal-bet-id');
    expect(transaction.processedAt).toEqual(at);
    expect(transaction.isTerminal()).toBe(true);
  });

  test('cannot process an unresolved required reference', () => {
    const transaction = refund();

    expect(() => transaction.markProcessed(undefined, new Date())).toThrow(
      InvalidWagerTransactionError,
    );

    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
  });

  test('cannot wait for a reference when none was submitted', () => {
    const transaction = WagerTransaction.create(props());

    expect(() => transaction.markPendingReference()).toThrow(
      InvalidTransactionStateError,
    );
  });

  test('rejects with an auditable failure code', () => {
    const transaction = WagerTransaction.create(props());

    transaction.reject(FailureCode.InsufficientBalance);

    expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(transaction.failureCode).toBe(FailureCode.InsufficientBalance);
    expect(transaction.processedAt).toBeUndefined();
  });

  test.each([
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
  ])('blocks every transition after %s', (status) => {
    const transaction = refund();

    if (status === WagerTransactionStatus.Processed) {
      transaction.markProcessed('internal-bet-id', new Date());
    } else if (status === WagerTransactionStatus.Rejected) {
      transaction.reject(FailureCode.ReferenceNotFound);
    } else {
      transaction.fail(FailureCode.PermanentInfrastructureFailure);
    }

    expect(() =>
      transaction.markProcessed('internal-bet-id', new Date()),
    ).toThrow(InvalidTransactionStateError);

    expect(() => transaction.markPendingReference()).toThrow(
      InvalidTransactionStateError,
    );

    expect(() => transaction.reject(FailureCode.ReferenceNotFound)).toThrow(
      InvalidTransactionStateError,
    );

    expect(() =>
      transaction.fail(FailureCode.PermanentInfrastructureFailure),
    ).toThrow(InvalidTransactionStateError);

    expect(transaction.status).toBe(status);
  });

  test('compares the persisted payload hash', () => {
    const transaction = WagerTransaction.create(props());

    expect(transaction.matchesPayload('payload-hash')).toBe(true);
    expect(transaction.matchesPayload('different-hash')).toBe(false);
  });

  test('protects creation and processing dates', () => {
    const input = props();
    const transaction = WagerTransaction.create(input);
    const originalCreationTime = input.createdAt.getTime();

    input.createdAt.setTime(0);
    transaction.createdAt.setTime(0);

    expect(transaction.createdAt.getTime()).toBe(originalCreationTime);

    const at = new Date('2026-10-28T12:01:00.000Z');
    const originalProcessingTime = at.getTime();

    transaction.markProcessed(undefined, at);
    at.setTime(0);
    transaction.processedAt?.setTime(0);

    expect(transaction.processedAt?.getTime()).toBe(originalProcessingTime);
  });
});

describe('WagerTransaction references and ledger direction', () => {
  const processedReference = (
    overrides: Partial<CreateWagerTransactionProps> = {},
  ): WagerTransaction => {
    const transaction = WagerTransaction.create(
      props({
        id: 'original-internal-id',
        externalTransactionId: 'original-external-id',
        idempotencyKey: 'provider-a:original-external-id',
        ...overrides,
      }),
    );

    transaction.markProcessed(
      transaction.referenceExternalTransactionId !== undefined
        ? 'earlier-internal-id'
        : undefined,
      new Date('2026-10-28T12:01:00.000Z'),
    );

    return transaction;
  };

  const reversal = (kind = WagerTransactionKind.Refund): WagerTransaction =>
    WagerTransaction.create(
      props({
        kind,
        referenceExternalTransactionId: 'original-external-id',
      }),
    );

  const expectReferenceFailure = (
    action: () => unknown,
    code: FailureCode,
  ): void => {
    let captured: unknown;

    try {
      action();
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(InvalidTransactionReferenceError);

    if (captured instanceof InvalidTransactionReferenceError) {
      expect(captured.code).toBe(code);
    }
  };

  test('BET debits and WIN credits', () => {
    expect(WagerTransaction.create(props()).ledgerDirectionFor()).toBe(
      LedgerDirection.Debit,
    );

    expect(
      WagerTransaction.create(
        props({ kind: WagerTransactionKind.Win }),
      ).ledgerDirectionFor(),
    ).toBe(LedgerDirection.Credit);
  });

  test('LOSS and zero-value WIN produce no ledger direction', () => {
    for (const kind of [WagerTransactionKind.Loss, WagerTransactionKind.Win]) {
      const transaction = WagerTransaction.create(
        props({ kind, money: brl('0.00') }),
      );

      expect(transaction.ledgerDirectionFor()).toBeUndefined();
    }
  });

  test('REFUND credits a processed BET', () => {
    expect(reversal().ledgerDirectionFor(processedReference())).toBe(
      LedgerDirection.Credit,
    );
  });

  test('ROLLBACK of BET credits the wallet', () => {
    expect(
      reversal(WagerTransactionKind.Rollback).ledgerDirectionFor(
        processedReference(),
      ),
    ).toBe(LedgerDirection.Credit);
  });

  test.each([WagerTransactionKind.Win, WagerTransactionKind.Refund])(
    'ROLLBACK of %s debits the wallet',
    (kind) => {
      const reference = processedReference({
        kind,
        referenceExternalTransactionId:
          kind === WagerTransactionKind.Refund ? 'earlier-bet' : undefined,
      });

      expect(
        reversal(WagerTransactionKind.Rollback).ledgerDirectionFor(reference),
      ).toBe(LedgerDirection.Debit);
    },
  );

  test('missing reference has a specific failure code', () => {
    expectReferenceFailure(
      () => reversal().ledgerDirectionFor(),
      FailureCode.ReferenceNotFound,
    );
  });

  test('rejects a reference that is not processed', () => {
    const reference = WagerTransaction.create(
      props({
        id: 'original-internal-id',
        externalTransactionId: 'original-external-id',
      }),
    );

    expectReferenceFailure(
      () => reversal().ledgerDirectionFor(reference),
      FailureCode.ReferenceNotProcessed,
    );
  });

  test('rejects a partial reversal', () => {
    const reference = processedReference({
      money: brl('50.00'),
    });

    expectReferenceFailure(
      () => reversal().ledgerDirectionFor(reference),
      FailureCode.ReferenceAmountMismatch,
    );
  });

  test('REFUND cannot reverse a WIN', () => {
    const reference = processedReference({
      kind: WagerTransactionKind.Win,
    });

    expectReferenceFailure(
      () => reversal().ledgerDirectionFor(reference),
      FailureCode.InvalidReferenceKind,
    );
  });

  test('ROLLBACK cannot reverse another ROLLBACK', () => {
    const reference = processedReference({
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'earlier-bet',
    });

    expectReferenceFailure(
      () =>
        reversal(WagerTransactionKind.Rollback).ledgerDirectionFor(reference),
      FailureCode.InvalidReferenceKind,
    );
  });

  test('rejects references with mismatched identity or currency', () => {
    const mismatches: Partial<CreateWagerTransactionProps>[] = [
      { providerId: 'other-provider' },
      { playerId: 'other-player' },
      { walletId: 'other-wallet' },
      { roundId: 'other-round' },
      { externalTransactionId: 'other-external-id' },
      {
        money: Money.from({
          amount: '25.00',
          currency: 'GBP',
        }),
      },
    ];

    for (const mismatch of mismatches) {
      const reference = processedReference(mismatch);

      expectReferenceFailure(
        () => reversal().ledgerDirectionFor(reference),
        FailureCode.ReferenceMismatch,
      );
    }
  });

  test('WIN may reference a BET with a different amount', () => {
    const win = WagerTransaction.create(
      props({
        kind: WagerTransactionKind.Win,
        money: brl('150.00'),
        referenceExternalTransactionId: 'original-external-id',
      }),
    );

    expect(win.ledgerDirectionFor(processedReference())).toBe(
      LedgerDirection.Credit,
    );
  });

  test('reference validation does not change transaction state', () => {
    const transaction = reversal();

    transaction.validateReference(processedReference());

    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    expect(transaction.referenceTransactionId).toBeUndefined();
  });
});
