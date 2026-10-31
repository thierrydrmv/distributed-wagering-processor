import { EntitySchema, ReferenceKind } from '@mikro-orm/core';
import { WagerTransactionRecord } from './wager-transaction.record';

export class InboxMessageRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt!: Date | null;
  transactionId!: string | null;
}

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  class: InboxMessageRecord,
  tableName: 'inbox_messages',

  properties: {
    consumerName: {
      type: 'string',
      primary: true,
      fieldName: 'consumer_name',
    },
    messageId: {
      type: 'string',
      primary: true,
      fieldName: 'message_id',
    },
    payloadHash: {
      type: 'string',
      length: 64,
      fieldName: 'payload_hash',
    },
    receivedAt: {
      type: 'Date',
      columnType: 'timestamptz',
      fieldName: 'received_at',
    },
    processedAt: {
      type: 'Date',
      columnType: 'timestamptz',
      fieldName: 'processed_at',
      nullable: true,
    },
    transactionId: {
      kind: ReferenceKind.MANY_TO_ONE,
      entity: () => WagerTransactionRecord,
      mapToPk: true,
      fieldName: 'transaction_id',
      nullable: true,
      deleteRule: 'restrict',
      updateRule: 'restrict',
    },
  },

  checks: [
    {
      name: 'inbox_processing_result',
      expression: `
          (processed_at IS NULL AND transaction_id IS NULL)
          OR
          (processed_at IS NOT NULL AND transaction_id IS NOT NULL)
        `,
    },
  ],
});
