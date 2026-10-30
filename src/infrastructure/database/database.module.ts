import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { MikroORM } from '@mikro-orm/postgresql';
import { FinancialUnitOfWork } from '../../application/ports/financial-unit-of-work';
import mikroOrmConfig from './mikro-orm.config';
import { MikroOrmFinancialUnitOfWork } from './mikro-orm-financial-unit-of-work';

@Module({
  imports: [MikroOrmModule.forRoot(mikroOrmConfig)],
  providers: [
    {
      provide: FinancialUnitOfWork,
      useFactory: (orm: MikroORM) => new MikroOrmFinancialUnitOfWork(orm),
      inject: [MikroORM],
    },
  ],
  exports: [FinancialUnitOfWork],
})
export class DatabaseModule {}
