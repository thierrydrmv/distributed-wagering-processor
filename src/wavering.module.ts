import { Module } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { FinancialUnitOfWork } from './application/ports/financial-unit-of-work';
import { OpenWallet } from './application/use-cases/open-wallet';
import { ProcessWagerTransaction } from './application/use-cases/process-wager-transaction';
import { DatabaseModule } from './infrastructure/database/database.module';
import { ReferenceRetryWorker } from './infrastructure/workers/reference-retry.worker';

@Module({
  imports: [DatabaseModule],
  providers: [
    {
      provide: OpenWallet,
      useFactory: (uow: FinancialUnitOfWork) => new OpenWallet(uow),
      inject: [FinancialUnitOfWork],
    },
    {
      provide: ProcessWagerTransaction,
      useFactory: (uow: FinancialUnitOfWork) =>
        new ProcessWagerTransaction(uow),
      inject: [FinancialUnitOfWork],
    },
    {
      provide: ReferenceRetryWorker,
      useFactory: (orm: MikroORM, processor: ProcessWagerTransaction) =>
        new ReferenceRetryWorker(orm, processor),
      inject: [MikroORM, ProcessWagerTransaction],
    },
  ],
  exports: [OpenWallet, ProcessWagerTransaction],
})
export class WageringModule {}
