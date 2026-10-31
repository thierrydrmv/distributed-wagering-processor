import type { EntityManager } from '@mikro-orm/postgresql';
import { InboxMessage } from '../../../application/inbox/inbox-message';
import type { InboxRepository } from '../../../application/ports/financial-unit-of-work';
import { InboxMessageRecord } from '../entities/inbox-message.record';

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async findByIdentity(
    consumerName: string,
    messageId: string,
  ): Promise<InboxMessage | null> {
    const record = await this.em.findOne(
      InboxMessageRecord,
      { consumerName, messageId },
      { refresh: true },
    );

    if (record === null) {
      return null;
    }

    return InboxMessage.rehydrate({
      consumerName: record.consumerName,
      messageId: record.messageId,
      payloadHash: record.payloadHash,
      receivedAt: record.receivedAt,
      processedAt: record.processedAt ?? undefined,
      transactionId: record.transactionId ?? undefined,
    });
  }

  async insert(message: InboxMessage): Promise<void> {
    const state = message.toState();

    await this.em.insert(InboxMessageRecord, {
      consumerName: state.consumerName,
      messageId: state.messageId,
      payloadHash: state.payloadHash,
      receivedAt: state.receivedAt,
      processedAt: state.processedAt ?? null,
      transactionId: state.transactionId ?? null,
    });
  }

  async save(message: InboxMessage): Promise<void> {
    if (!message.isProcessed()) {
      throw new Error('Inbox message has no processing result');
    }

    const state = message.toState();

    const affectedRows = await this.em.nativeUpdate(
      InboxMessageRecord,
      {
        consumerName: state.consumerName,
        messageId: state.messageId,
        payloadHash: state.payloadHash,
        processedAt: null,
      },
      {
        processedAt: state.processedAt,
        transactionId: state.transactionId,
      },
    );

    if (affectedRows !== 1) {
      throw new Error('Inbox processing state changed concurrently');
    }
  }
}
