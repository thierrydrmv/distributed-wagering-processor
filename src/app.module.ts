import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { FinancialUnitOfWork } from './application/ports/financial-unit-of-work';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { WageringModule } from './wavering.module';

@Module({
  imports: [WageringModule],
  controllers: [AppController],
  providers: [AppService],
  exports: [FinancialUnitOfWork, MikroOrmModule],
})
export class AppModule {}
