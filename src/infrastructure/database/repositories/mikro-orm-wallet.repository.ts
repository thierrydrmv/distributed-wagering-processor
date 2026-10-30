import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { WalletRepository } from '../../../application/ports/financial-unit-of-work';
import type { Wallet } from '../../../domain/entities/wallet';
import { WalletRecord } from '../entities/wallet.record';
import { WalletMapper } from '../mappers/wallet.mapper';

export class MikroOrmWalletRepository implements WalletRepository {
  private readonly lockedWalletIds = new Set<string>();

  constructor(private readonly em: EntityManager) {}

  async insert(wallet: Wallet): Promise<void> {
    await this.em.insert(WalletRecord, WalletMapper.toRecord(wallet));
  }

  async findByIdForUpdate(id: string): Promise<Wallet | null> {
    const record = await this.em.findOne(
      WalletRecord,
      { id },
      {
        lockMode: LockMode.PESSIMISTIC_WRITE,
        refresh: true,
      },
    );

    if (record === null) {
      return null;
    }

    this.lockedWalletIds.add(id);

    return WalletMapper.toDomain(record);
  }

  async save(wallet: Wallet): Promise<void> {
    if (!this.lockedWalletIds.has(wallet.id)) {
      throw new Error('Wallet must be loaded with a write lock before saving');
    }

    const record = WalletMapper.toRecord(wallet);

    const affectedRows = await this.em.nativeUpdate(
      WalletRecord,
      { id: wallet.id },
      {
        balance: record.balance,
        version: record.version,
        updatedAt: record.updatedAt,
      },
    );

    if (affectedRows !== 1) {
      throw new Error('Expected to update exactly one wallet');
    }
  }
}
