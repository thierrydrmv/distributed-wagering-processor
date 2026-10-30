import { EntitySchema } from '@mikro-orm/core';
import type { IntegrationEventEnvelope } from '../../../application/events/integration-event';

export class OutboxMessageRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: IntegrationEventEnvelope<object>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date | null;
  publishedAt!: Date | null;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  class: OutboxMessageRecord,
  tableName: 'outbox_messages',

  properties: {
    id: {
      type: 'uuid',
      primary: true,
    },
    aggregateId: {
      type: 'uuid',
      fieldName: 'aggregate_id',
    },
    eventType: {
      type: 'string',
      fieldName: 'event_type',
    },
    payload: {
      type: 'json',
      columnType: 'jsonb',
    },
    occurredAt: {
      type: 'Date',
      columnType: 'timestamptz',
      fieldName: 'occurred_at',
    },
    attempts: {
      type: 'integer',
      default: 0,
    },
    nextAttemptAt: {
      type: 'Date',
      columnType: 'timestamptz',
      fieldName: 'next_attempt_at',
      nullable: true,
    },
    publishedAt: {
      type: 'Date',
      columnType: 'timestamptz',
      fieldName: 'published_at',
      nullable: true,
    },
  },

  indexes: [
    {
      name: 'outbox_publication_idx',
      properties: ['publishedAt', 'nextAttemptAt', 'occurredAt', 'id'],
    },
  ],

  checks: [
    {
      name: 'outbox_attempts_non_negative',
      expression: 'attempts >= 0',
    },
  ],
});
