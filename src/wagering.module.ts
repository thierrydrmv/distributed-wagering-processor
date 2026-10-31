import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
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
import { SqsWagerConsumer } from './infrastructure/messaging/sqs-wager.consumer';
import { EventPublisher } from './application/ports/event-publisher';
import { SqsEventPublisher } from './infrastructure/messaging/sqs-event.publisher';
import { OutboxPublisherWorker } from './infrastructure/workers/outbox-publisher.worker';
import {
  HealthController,
  HealthService,
} from './infrastructure/http/health.controller';
import { HttpMetricsMiddleware } from './infrastructure/observability/http-metrics.middleware';
import { MetricsController } from './infrastructure/observability/metrics.controller';

@Module({
  imports: [DatabaseModule],
  providers: [
    ProviderAuthGuard,
    FinancialMetrics,
    HttpMetricsMiddleware,
    {
      provide: OpenWallet,
      useFactory: (uow: FinancialUnitOfWork) => new OpenWallet(uow),
      inject: [FinancialUnitOfWork],
    },
    {
      provide: ProcessWagerTransaction,
      useFactory: (uow: FinancialUnitOfWork, metrics: FinancialMetrics) =>
        new ProcessWagerTransaction(uow, metrics),
      inject: [FinancialUnitOfWork, FinancialMetrics],
    },
    {
      provide: WageringQueries,
      useFactory: (orm: MikroORM, metrics: FinancialMetrics) =>
        new WageringQueries(orm, metrics),
      inject: [MikroORM, FinancialMetrics],
    },
    {
      provide: EventPublisher,
      useFactory: () => new SqsEventPublisher(),
    },
    {
      provide: HealthService,
      inject: [MikroORM],
      useFactory: (orm: MikroORM) => new HealthService(orm),
    },
    {
      provide: ReferenceRetryWorker,
      useFactory: (
        orm: MikroORM,
        processor: ProcessWagerTransaction,
        metrics: FinancialMetrics,
      ) => new ReferenceRetryWorker(orm, processor, metrics),
      inject: [MikroORM, ProcessWagerTransaction, FinancialMetrics],
    },
    {
      provide: SqsWagerConsumer,
      useFactory: (
        processor: ProcessWagerTransaction,
        metrics: FinancialMetrics,
      ) => new SqsWagerConsumer(processor, undefined, metrics),
      inject: [ProcessWagerTransaction, FinancialMetrics],
    },
    {
      provide: OutboxPublisherWorker,
      useFactory: (
        orm: MikroORM,
        publisher: EventPublisher,
        metrics: FinancialMetrics,
      ) => new OutboxPublisherWorker(orm, publisher, undefined, metrics),
      inject: [MikroORM, EventPublisher, FinancialMetrics],
    },
  ],
  controllers: [
    WalletsController,
    WageringController,
    ProvidersController,
    HealthController,
    MetricsController,
  ],
  exports: [OpenWallet, ProcessWagerTransaction],
})
export class WageringModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(HttpMetricsMiddleware).forRoutes('*');
  }
}
