import { IsolationLevel } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { FinancialUnitOfWork } from '../../application/ports/financial-unit-of-work';
import type { FinancialTransactionContext } from '../../application/ports/financial-unit-of-work';
import { MikroOrmWalletRepository } from './repositories/mikro-orm-wallet.repository';
import { MikroOrmWalletLedgerRepository } from './repositories/mikro-orm-wallet-ledger.repository';
import { MikroOrmWagerTransactionRepository } from './mikro-orm-wager-transaction.repository';

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

    return em.transactional(
      async (transactionEm) => {
        const context: FinancialTransactionContext = {
          wallets: new MikroOrmWalletRepository(transactionEm),
          transactions: new MikroOrmWagerTransactionRepository(transactionEm),
          ledger: new MikroOrmWalletLedgerRepository(transactionEm),
        };

        return work(context);
      },
      {
        isolationLevel: IsolationLevel.READ_COMMITTED,
      },
    );
  }
}
