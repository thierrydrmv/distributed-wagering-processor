import {
  IsolationLevel,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { PersistenceConflictError } from '../../application/errors/wagering-error';
import { FinancialUnitOfWork } from '../../application/ports/financial-unit-of-work';
import type { FinancialTransactionContext } from '../../application/ports/financial-unit-of-work';
import { MikroOrmWalletRepository } from './repositories/mikro-orm-wallet.repository';
import { MikroOrmWagerTransactionRepository } from '../database/mikro-orm-wager-transaction.repository';
import { MikroOrmWalletLedgerRepository } from './repositories/mikro-orm-wallet-ledger.repository';
import { MikroOrmOutboxRepository } from './repositories/mikro-orm-outbox.repository';
import { MikroOrmInboxRepository } from './repositories/mikro-orm-inbox.repository';
import { FinancialMetrics } from '../observability/financial-metrics';

export class MikroOrmFinancialUnitOfWork extends FinancialUnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly metrics?: FinancialMetrics,
  ) {
    super();
  }

  async execute<T>(
    work: (context: FinancialTransactionContext) => Promise<T>,
  ): Promise<T> {
    const em = this.orm.em.fork({
      clear: true,
      useContext: false,
    });

    try {
      return await em.transactional(
        async (transactionEm) => {
          const context: FinancialTransactionContext = {
            wallets: new MikroOrmWalletRepository(transactionEm),
            transactions: new MikroOrmWagerTransactionRepository(transactionEm),
            ledger: new MikroOrmWalletLedgerRepository(transactionEm),
            outbox: new MikroOrmOutboxRepository(transactionEm),
            inbox: new MikroOrmInboxRepository(transactionEm),
          };

          return work(context);
        },
        {
          isolationLevel: IsolationLevel.READ_COMMITTED,
        },
      );
    } catch (error: unknown) {
      const reason = this.conflictReason(error);

      if (reason !== undefined) {
        this.metrics?.persistenceConflicts.inc({ reason });
      }

      if (error instanceof UniqueConstraintViolationException) {
        throw new PersistenceConflictError(error);
      }

      throw error;
    }
  }

  private conflictReason(error: unknown): string | undefined {
    if (error instanceof UniqueConstraintViolationException) {
      return 'unique_constraint';
    }

    let current: unknown = error;

    for (let depth = 0; depth < 6; depth += 1) {
      if (typeof current !== 'object' || current === null) {
        return undefined;
      }

      if ('code' in current) {
        switch (current.code) {
          case '23505':
            return 'unique_constraint';
          case '40P01':
            return 'deadlock';
          case '40001':
            return 'serialization_failure';
          case '55P03':
            return 'lock_not_available';
        }
      }

      if (!('cause' in current)) {
        return undefined;
      }

      current = current.cause;
    }

    return undefined;
  }
}
