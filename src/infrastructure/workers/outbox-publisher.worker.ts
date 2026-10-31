import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { OutboxMessage } from '../../application/outbox/outbox-message';
import type { EventPublisher } from '../../application/ports/event-publisher';
import { OutboxMessageRecord } from '../database/entities/outbox-message.record';
import { FinancialMetrics } from '../observability/financial-metrics';

interface OutboxJob {
  id: string;
  claimToken: string;
}

export interface OutboxPublisherOptions {
  batchSize?: number;
  aggregateId?: string;
}

export class OutboxPublisherWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisherWorker.name);
  private readonly batchSize: number;

  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<number> | undefined;
  private stopping = false;

  constructor(
    private readonly orm: MikroORM,
    private readonly publisher: EventPublisher,
    private readonly options: OutboxPublisherOptions = {},
    private readonly metrics?: FinancialMetrics,
  ) {
    this.batchSize = options.batchSize ?? 5;

    if (
      !Number.isInteger(this.batchSize) ||
      this.batchSize < 1 ||
      this.batchSize > 100
    ) {
      throw new Error('Invalid outbox batch size');
    }
  }

  onModuleInit(): void {
    if (process.env.OUTBOX_PUBLISHER_ENABLED !== 'true') {
      return;
    }

    this.timer = setInterval(() => {
      void this.runOnce().catch((error: unknown) => {
        this.logFailure('outbox_claim_failed', error);
      });
    }, 1_000);

    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;

    if (this.timer !== undefined) {
      clearInterval(this.timer);
    }

    try {
      await this.inFlight;
    } finally {
      this.publisher.close();
    }
  }

  async runOnce(): Promise<number> {
    if (this.stopping || this.inFlight !== undefined) {
      return 0;
    }

    const task = this.runBatch();
    this.inFlight = task;

    try {
      return await task;
    } finally {
      this.inFlight = undefined;
    }
  }

  private async runBatch(): Promise<number> {
    const jobs = await this.claim();
    let published = 0;

    for (const job of jobs) {
      try {
        if (this.stopping) {
          await this.release(job);
          continue;
        }

        if (await this.publish(job)) {
          published += 1;
        }
      } catch (error) {
        this.logFailure('outbox_publication_failed', error, job.id);

        try {
          await this.scheduleRetry(job);
        } catch (retryError) {
          // O claim expirará se o banco estiver indisponível.
          this.logFailure('outbox_retry_schedule_failed', retryError, job.id);
        }
      }
    }

    return published;
  }

  private async claim(): Promise<OutboxJob[]> {
    const token = randomUUID();
    const aggregateId = this.options.aggregateId ?? null;

    return this.orm.em
      .fork()
      .getConnection()
      .execute<OutboxJob[]>(
        `
          with due as (
            select id
            from outbox_messages
            where
              published_at is null
              and (
                next_attempt_at is null
                or next_attempt_at <= clock_timestamp()
              )
              and (
                claimed_until is null
                or claimed_until <= clock_timestamp()
              )
              and (
                ?::uuid is null
                or aggregate_id = ?::uuid
              )
            order by occurred_at, id
            limit ?
            for update skip locked
          )
          update outbox_messages o
          set
            claim_token = ?::uuid,
            claimed_until =
              clock_timestamp() + interval '60 seconds'
          from due
          where o.id = due.id
          returning
            o.id,
            o.claim_token as "claimToken"
        `,
        [aggregateId, aggregateId, this.batchSize, token],
      );
  }

  private async publish(job: OutboxJob): Promise<boolean> {
    const em = this.orm.em.fork();

    const record = await em.findOne(OutboxMessageRecord, {
      id: job.id,
      claimToken: job.claimToken,
      publishedAt: null,
    });

    if (record === null) {
      return false;
    }

    const message = this.rehydrate(record);

    await this.publisher.publish(message.toState().payload);

    message.markPublished(new Date());

    const affectedRows = await em.nativeUpdate(
      OutboxMessageRecord,
      {
        id: job.id,
        claimToken: job.claimToken,
        publishedAt: null,
      },
      {
        publishedAt: message.publishedAt,
        nextAttemptAt: null,
        claimToken: null,
        claimedUntil: null,
      },
    );

    if (affectedRows !== 1) {
      this.logger.warn(
        JSON.stringify({
          event: 'outbox_claim_lost',
          eventId: job.id,
        }),
      );

      return false;
    }

    const payload = message.toState().payload;

    this.logger.log(
      JSON.stringify({
        event: 'outbox_event_published',
        eventId: payload.eventId,
        eventType: payload.eventType,
        walletId: payload.aggregateId,
        correlationId: payload.correlationId,
      }),
    );

    return true;
  }

  private async scheduleRetry(job: OutboxJob): Promise<void> {
    const em = this.orm.em.fork();

    const record = await em.findOne(OutboxMessageRecord, {
      id: job.id,
      claimToken: job.claimToken,
      publishedAt: null,
    });

    if (record === null) {
      return;
    }

    const message = this.rehydrate(record);
    message.scheduleRetry(new Date());

    const affectedRows = await em.nativeUpdate(
      OutboxMessageRecord,
      {
        id: job.id,
        claimToken: job.claimToken,
        publishedAt: null,
      },
      {
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt,
        claimToken: null,
        claimedUntil: null,
      },
    );

    if (affectedRows === 1) {
      this.metrics?.retries.inc({
        component: 'outbox',
      });
    }

    await em.nativeUpdate(
      OutboxMessageRecord,
      {
        id: job.id,
        claimToken: job.claimToken,
        publishedAt: null,
      },
      {
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt,
        claimToken: null,
        claimedUntil: null,
      },
    );
  }

  private async release(job: OutboxJob): Promise<void> {
    await this.orm.em.fork().nativeUpdate(
      OutboxMessageRecord,
      {
        id: job.id,
        claimToken: job.claimToken,
        publishedAt: null,
      },
      {
        claimToken: null,
        claimedUntil: null,
      },
    );
  }

  private rehydrate(record: OutboxMessageRecord): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: record.id,
      aggregateId: record.aggregateId,
      eventType: record.eventType,
      payload: record.payload,
      occurredAt: record.occurredAt,
      attempts: record.attempts,
      nextAttemptAt: record.nextAttemptAt ?? undefined,
      publishedAt: record.publishedAt ?? undefined,
    });
  }

  private logFailure(event: string, error: unknown, eventId?: string): void {
    this.logger.error(
      JSON.stringify({
        event,
        eventId,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      }),
    );
  }
}
