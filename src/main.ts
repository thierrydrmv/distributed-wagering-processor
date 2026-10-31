import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureHttp } from './infrastructure/http/configure-http';
import { ConsoleLogger } from '@nestjs/common';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: new ConsoleLogger({
      json: true,
      colors: false,
      compact: true,
    }),
  });

  configureHttp(app);
  app.enableShutdownHooks();

  await app.listen(process.env.PORT ?? 3000);
}

void bootstrap();
