import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { FinancialUnitOfWork } from '../ports/financial-unit-of-work';
import type { FinancialTransactionContext } from '../ports/financial-unit-of-work';
import { FinancialMetrics } from '../../infrastructure/observability/financial-metrics';
import { WagerTransactionKind } from '../../domain/entities/wager-transaction';
import { ProcessWagerTransaction } from './process-wager-transaction';
import type { ProcessWagerRequest } from './process-wager-transaction';

class FailingUnitOfWork extends FinancialUnitOfWork {
  constructor(private readonly failure: Error) {
    super();
  }

  execute<T>(
    _work: (context: FinancialTransactionContext) => Promise<T>,
  ): Promise<T> {
    void _work;

    return Promise.reject(this.failure);
  }
}

function request(): ProcessWagerRequest {
  return {
    idempotencyKey: randomUUID(),
    providerId: 'metrics-test',
    externalTransactionId: randomUUID(),
    playerId: randomUUID(),
    walletId: randomUUID(),
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: {
      amount: '10.00',
      currency: 'BRL',
    },
  };
}

async function captureFailure(action: () => Promise<unknown>): Promise<Error> {
  try {
    await action();
  } catch (error: unknown) {
    if (error instanceof Error) {
      return error;
    }

    throw new Error('Expected an Error instance');
  }

  throw new Error('Expected the operation to fail');
}

describe('ProcessWagerTransaction metrics', () => {
  test('records an HTTP failure and duration without a committed result', async () => {
    const failure = new Error('Commit failed');
    const metrics = new FinancialMetrics();

    const processor = new ProcessWagerTransaction(
      new FailingUnitOfWork(failure),
      metrics,
    );

    const captured = await captureFailure(() => processor.execute(request()));

    expect(captured).toBe(failure);

    const failures = await metrics.processingFailures.get();

    expect(failures.values).toEqual([
      {
        labels: { source: 'http' },
        value: 1,
      },
    ]);

    const duration = await metrics.processingDuration.get();

    const count = duration.values.find(
      (value) =>
        value.metricName === 'wagering_processing_duration_seconds_count' &&
        value.labels.source === 'http',
    );

    expect(count?.value).toBe(1);

    const results = await metrics.transactionResults.get();
    const replays = await metrics.idempotentReplays.get();

    expect(results.values).toHaveLength(0);
    expect(replays.values).toHaveLength(0);
  });

  test('classifies a delivery failure as SQS', async () => {
    const failure = new Error('Database unavailable');
    const metrics = new FinancialMetrics();

    const processor = new ProcessWagerTransaction(
      new FailingUnitOfWork(failure),
      metrics,
    );

    const captured = await captureFailure(() =>
      processor.execute(request(), {
        consumerName: 'wager-transactions-v1',
        messageId: randomUUID(),
        payloadHash: 'a'.repeat(64),
      }),
    );

    expect(captured).toBe(failure);

    const failures = await metrics.processingFailures.get();

    expect(failures.values).toEqual([
      {
        labels: { source: 'sqs' },
        value: 1,
      },
    ]);

    const duration = await metrics.processingDuration.get();

    const count = duration.values.find(
      (value) =>
        value.metricName === 'wagering_processing_duration_seconds_count' &&
        value.labels.source === 'sqs',
    );

    expect(count?.value).toBe(1);
  });

  test('classifies a reference retry failure as reference', async () => {
    const failure = new Error('Reference processing failed');
    const metrics = new FinancialMetrics();

    const processor = new ProcessWagerTransaction(
      new FailingUnitOfWork(failure),
      metrics,
    );

    const captured = await captureFailure(() =>
      processor.resumePendingReference(randomUUID()),
    );

    expect(captured).toBe(failure);

    const failures = await metrics.processingFailures.get();

    expect(failures.values).toEqual([
      {
        labels: { source: 'reference' },
        value: 1,
      },
    ]);

    const duration = await metrics.processingDuration.get();

    const count = duration.values.find(
      (value) =>
        value.metricName === 'wagering_processing_duration_seconds_count' &&
        value.labels.source === 'reference',
    );

    expect(count?.value).toBe(1);
  });

  test('preserves the original failure when telemetry is omitted', async () => {
    const failure = new Error('Database unavailable');

    const processor = new ProcessWagerTransaction(
      new FailingUnitOfWork(failure),
    );

    const captured = await captureFailure(() => processor.execute(request()));

    expect(captured).toBe(failure);
  });
});
