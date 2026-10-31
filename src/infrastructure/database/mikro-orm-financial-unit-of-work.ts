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

export class MikroOrmFinancialUnitOfWork extends FinancialUnitOfWork {
  constructor(private readonly orm: MikroORM) {
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
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        throw new PersistenceConflictError(error);
      }

      throw error;
    }
  }
}
