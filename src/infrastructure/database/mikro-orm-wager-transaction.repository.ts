import type { FilterQuery } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import {
  StoredWagerTransaction,
  WagerTransactionRepository,
} from '../../application/ports/financial-unit-of-work';
import type {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/entities/wager-transaction';
import type { Money } from '../../domain/value-objects/money';
import { WagerTransactionRecord } from '../database/entities/wager-transaction.record';
import { WagerTransactionMapper } from '../database/mappers/wager-transaction.mapper';
import { WagerTransactionStatus as TransactionStatus } from '../../domain/entities/wager-transaction';

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  private readonly loadedStatuses = new Map<string, WagerTransactionStatus>();

  constructor(private readonly em: EntityManager) {}

  async insert(
    transaction: WagerTransaction,
    resultBalance: Money | null = null,
  ): Promise<void> {
    await this.em.insert(
      WagerTransactionRecord,
      WagerTransactionMapper.toRecord(transaction, resultBalance),
    );

    this.loadedStatuses.set(transaction.id, transaction.status);
  }

  async findById(id: string): Promise<StoredWagerTransaction | null> {
    return this.findOne({ id });
  }

  async findByIdempotencyKey(
    key: string,
  ): Promise<StoredWagerTransaction | null> {
    return this.findOne({ idempotencyKey: key });
  }

  async findByProviderExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<StoredWagerTransaction | null> {
    return this.findOne({
      providerId,
      externalTransactionId,
    });
  }

  async save(
    transaction: WagerTransaction,
    resultBalance: Money | null = null,
  ): Promise<void> {
    const originalStatus = this.loadedStatuses.get(transaction.id);

    if (originalStatus === undefined) {
      throw new Error('Transaction must be loaded or inserted before saving');
    }

    const record = WagerTransactionMapper.toRecord(transaction, resultBalance);

    const affectedRows = await this.em.nativeUpdate(
      WagerTransactionRecord,
      {
        id: transaction.id,
        status: originalStatus,
      },
      {
        status: record.status,
        referenceTransactionId: record.referenceTransactionId,
        failureCode: record.failureCode,
        resultBalance: record.resultBalance,
        processedAt: record.processedAt,
      },
    );

    if (affectedRows !== 1) {
      throw new Error(
        'Transaction changed concurrently; retry the entire operation',
      );
    }

    this.loadedStatuses.set(transaction.id, transaction.status);
  }

  private async findOne(
    where: FilterQuery<WagerTransactionRecord>,
  ): Promise<StoredWagerTransaction | null> {
    const record = await this.em.findOne(WagerTransactionRecord, where, {
      refresh: true,
    });

    if (record === null) {
      return null;
    }

    this.loadedStatuses.set(record.id, record.status);

    return {
      transaction: WagerTransactionMapper.toDomain(record),
      resultBalance: WagerTransactionMapper.toResultBalance(record),
    };
  }
  async findProcessedReversal(
    referenceTransactionId: string,
    kind: WagerTransactionKind,
  ): Promise<StoredWagerTransaction | null> {
    return this.findOne({
      referenceTransactionId,
      kind,
      status: TransactionStatus.Processed,
    });
  }
}
