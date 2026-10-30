import type { EntityManager } from '@mikro-orm/postgresql';
import type { WalletLedgerRepository } from '../../../application/ports/financial-unit-of-work';
import type { WalletLedgerEntry } from '../../../domain/entities/wallet-ledger-entry';
import { WalletLedgerEntryRecord } from '../entities/wallet-ledger-entry.record';
import { WalletLedgerEntryMapper } from '../mappers/wallet-ledger-entry.mapper';

export class MikroOrmWalletLedgerRepository implements WalletLedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(
      WalletLedgerEntryRecord,
      WalletLedgerEntryMapper.toRecord(entry),
    );
  }
}
