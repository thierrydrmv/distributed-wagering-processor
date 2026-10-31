import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { WagerTransactionStatus } from '../../domain/entities/wager-transaction';
import { ProcessWagerTransaction } from '../../application/use-cases/process-wager-transaction';
import { WagerTransactionRecord } from '../database/entities/wager-transaction.record';
import { FinancialMetrics } from '../observability/financial-metrics';

interface ReferenceJob {
  id: string;
  attempts: number;
  createdAtMs: string;
  claimToken: string;
}

export class ReferenceRetryWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReferenceRetryWorker.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<number> | undefined;

  private readonly maxAttempts = 12;
  private readonly ttlMs = 15 * 60 * 1_000;

  constructor(
    private readonly orm: MikroORM,
    private readonly processor: ProcessWagerTransaction,
    private readonly metrics?: FinancialMetrics,
  ) {}

  onModuleInit(): void {
    if (process.env.REFERENCE_WORKER_ENABLED === 'false') {
      return;
    }

    this.timer = setInterval(() => {
      void this.runOnce().catch((error: unknown) => {
        this.logFailure('reference_claim_failed', error);
      });
    }, 1_000);

    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
    }

    await this.inFlight;
  }

  async runOnce(now = new Date()): Promise<number> {
    if (!Number.isFinite(now.getTime())) {
      throw new Error('Invalid reference worker date');
    }

    if (this.inFlight !== undefined) {
      return 0;
    }

    const task = this.runBatch(now);
    this.inFlight = task;

    try {
      return await task;
    } finally {
      this.inFlight = undefined;
    }
  }

  private async runBatch(now: Date): Promise<number> {
    const jobs = await this.claim(now);

    for (const job of jobs) {
      try {
        const createdAtMs = Number(job.createdAtMs);

        if (!Number.isSafeInteger(createdAtMs)) {
          throw new Error('Invalid reference job creation timestamp');
        }

        const expired =
          job.attempts >= this.maxAttempts ||
          now.getTime() - createdAtMs >= this.ttlMs;

        const result = await this.processor.resumePendingReference(
          job.id,
          expired,
        );

        if (result.status === WagerTransactionStatus.PendingReference) {
          await this.reschedule(job, now, true);
        }
      } catch (error) {
        this.logFailure('reference_processing_failed', error, job.id);

        // Infraestrutura indisponível não consome uma tentativa
        // de busca da referência.
        try {
          await this.reschedule(job, now, false);
        } catch (releaseError) {
          // Se o banco estiver indisponível, o claim expirará.
          this.logFailure('reference_release_failed', releaseError, job.id);
        }
      }
    }

    return jobs.length;
  }

  private async claim(now: Date): Promise<ReferenceJob[]> {
    const claimToken = randomUUID();
    const em = this.orm.em.fork();

    return em.getConnection().execute<ReferenceJob[]>(
      `
        with due as (
          select id
          from wager_transactions
          where
            status = 'PENDING_REFERENCE'
            and next_reference_attempt_at <= ?::timestamptz
            and (
              reference_claimed_until is null
              or reference_claimed_until <= ?::timestamptz
            )
          order by next_reference_attempt_at, id
          limit 10
          for update skip locked
        )
        update wager_transactions t
        set
          reference_claim_token = ?::uuid,
          reference_claimed_until =
            ?::timestamptz + interval '60 seconds'
        from due
        where t.id = due.id
        returning
          t.id,
          t.reference_attempts as "attempts",
          floor(extract(epoch from t.created_at) * 1000)::text
            as "createdAtMs",
          t.reference_claim_token as "claimToken"
      `,
      [now, now, claimToken, now],
    );
  }

  private async reschedule(
    job: ReferenceJob,
    now: Date,
    countAttempt: boolean,
  ): Promise<void> {
    const attempts = job.attempts + (countAttempt ? 1 : 0);

    const delayMs = countAttempt
      ? Math.min(60_000, 1_000 * 2 ** Math.min(attempts - 1, 6))
      : 1_000;

    const em = this.orm.em.fork();

    const affectedRows = await em.nativeUpdate(
      WagerTransactionRecord,
      {
        id: job.id,
        status: WagerTransactionStatus.PendingReference,
        referenceClaimToken: job.claimToken,
      },
      {
        referenceAttempts: attempts,
        nextReferenceAttemptAt: new Date(now.getTime() + delayMs),
        referenceClaimToken: null,
        referenceClaimedUntil: null,
      },
    );

    if (affectedRows === 1 && countAttempt) {
      this.metrics?.retries.inc({
        component: 'reference',
      });
    }

    await em.nativeUpdate(
      WagerTransactionRecord,
      {
        id: job.id,
        status: WagerTransactionStatus.PendingReference,
        referenceClaimToken: job.claimToken,
      },
      {
        referenceAttempts: attempts,
        nextReferenceAttemptAt: new Date(now.getTime() + delayMs),
        referenceClaimToken: null,
        referenceClaimedUntil: null,
      },
    );
  }

  private logFailure(
    event: string,
    error: unknown,
    transactionId?: string,
  ): void {
    this.logger.error(
      JSON.stringify({
        event,
        transactionId,
        correlationId: transactionId,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      }),
    );
  }
}
