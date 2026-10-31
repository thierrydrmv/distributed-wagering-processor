import type { EntityManager } from '@mikro-orm/postgresql';
import type { OutboxMessage } from '../../../application/outbox/outbox-message';
import type { OutboxRepository } from '../../../application/ports/financial-unit-of-work';
import { OutboxMessageRecord } from '../entities/outbox-message.record';

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(message: OutboxMessage): Promise<void> {
    const state = message.toState();

    await this.em.insert(OutboxMessageRecord, {
      id: state.id,
      aggregateId: state.aggregateId,
      eventType: state.eventType,
      payload: state.payload,
      occurredAt: state.occurredAt,
      attempts: state.attempts,
      nextAttemptAt: state.nextAttemptAt ?? null,
      publishedAt: state.publishedAt ?? null,
      claimToken: null,
      claimedUntil: null,
    });
  }
}
