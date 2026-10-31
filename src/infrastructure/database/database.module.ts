import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { MikroORM } from '@mikro-orm/postgresql';
import { FinancialUnitOfWork } from '../../application/ports/financial-unit-of-work';
import mikroOrmConfig from './mikro-orm.config';
import { MikroOrmFinancialUnitOfWork } from './mikro-orm-financial-unit-of-work';
import { FinancialMetrics } from '../observability/financial-metrics';

@Module({
  imports: [MikroOrmModule.forRoot(mikroOrmConfig)],
  providers: [
    FinancialMetrics,
    {
      provide: FinancialUnitOfWork,
      useFactory: (orm: MikroORM, metrics: FinancialMetrics) =>
        new MikroOrmFinancialUnitOfWork(orm, metrics),
      inject: [MikroORM, FinancialMetrics],
    },
  ],
  exports: [FinancialUnitOfWork, FinancialMetrics],
})
export class DatabaseModule {}
