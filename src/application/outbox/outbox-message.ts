import type {
  IntegrationEvent,
  IntegrationEventEnvelope,
} from '../events/integration-event';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: IntegrationEventEnvelope<object>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export class OutboxMessage {
  private constructor(private readonly state: OutboxMessageState) {}

  static enqueue(event: IntegrationEvent<object>): OutboxMessage {
    return new OutboxMessage({
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: event.toJSON(),
      occurredAt: event.occurredAt,
      attempts: 0,
    });
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(structuredClone(state));
  }

  get id(): string {
    return this.state.id;
  }

  get attempts(): number {
    return this.state.attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this.state.nextAttemptAt === undefined
      ? undefined
      : new Date(this.state.nextAttemptAt);
  }

  get publishedAt(): Date | undefined {
    return this.state.publishedAt === undefined
      ? undefined
      : new Date(this.state.publishedAt);
  }

  isPending(): boolean {
    return this.state.publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    this.assertValidDate(now);

    return (
      this.isPending() &&
      (this.state.nextAttemptAt === undefined ||
        this.state.nextAttemptAt.getTime() <= now.getTime())
    );
  }

  markPublished(at: Date): void {
    this.assertPending();
    this.assertValidDate(at);

    this.state.publishedAt = new Date(at);
    this.state.nextAttemptAt = undefined;
  }

  scheduleRetry(now: Date): void {
    this.assertPending();
    this.assertValidDate(now);

    if (this.state.attempts >= 2_147_483_647) {
      throw new Error('Outbox attempt counter exhausted');
    }

    this.state.attempts += 1;

    const delayMs = Math.min(
      30_000,
      1_000 * 2 ** Math.min(this.state.attempts - 1, 5),
    );

    this.state.nextAttemptAt = new Date(now.getTime() + delayMs);
  }

  toState(): OutboxMessageState {
    return structuredClone(this.state);
  }

  private assertPending(): void {
    if (!this.isPending()) {
      throw new Error('Published outbox messages cannot transition');
    }
  }

  private assertValidDate(date: Date): void {
    if (!Number.isFinite(date.getTime())) {
      throw new Error('Invalid outbox date');
    }
  }
}
