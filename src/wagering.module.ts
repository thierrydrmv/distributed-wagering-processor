import { Module } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { FinancialUnitOfWork } from './application/ports/financial-unit-of-work';
import { OpenWallet } from './application/use-cases/open-wallet';
import { ProcessWagerTransaction } from './application/use-cases/process-wager-transaction';
import { DatabaseModule } from './infrastructure/database/database.module';
import { ReferenceRetryWorker } from './infrastructure/workers/reference-retry.worker';
import { WalletsController } from './infrastructure/http/wallets.controller';
import { WageringController } from './infrastructure/http/wagering.controller';
import { ProviderAuthGuard } from './infrastructure/http/provider-auth.guard';
import { ProvidersController } from './infrastructure/http/providers.controller';
import { FinancialMetrics } from './infrastructure/observability/financial-metrics';
import { WageringQueries } from './infrastructure/database/queries/wagering.queries';

@Module({
  imports: [DatabaseModule],
  providers: [
    ProviderAuthGuard,
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
    FinancialMetrics,
    {
      provide: WageringQueries,
      useFactory: (orm: MikroORM, metrics: FinancialMetrics) =>
        new WageringQueries(orm, metrics),
      inject: [MikroORM, FinancialMetrics],
    },
  ],
  controllers: [WalletsController, WageringController, ProvidersController],
  exports: [OpenWallet, ProcessWagerTransaction],
})
export class WageringModule {}
