import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureHttp } from './infrastructure/http/configure-http';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  configureHttp(app);
  app.enableShutdownHooks();

  await app.listen(process.env.PORT ?? 3000);
}

void bootstrap();
