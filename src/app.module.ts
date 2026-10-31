import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { WageringModule } from './wagering.module';

@Module({
  imports: [WageringModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
