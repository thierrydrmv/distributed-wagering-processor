import { MikroORM } from '@mikro-orm/postgresql';
import ormConfig from '../../src/infrastructure/database/mikro-orm.config';
import type { EventPublisher } from '../../src/application/ports/event-publisher';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event.publisher';
import { OutboxPublisherWorker } from '../../src/infrastructure/workers/outbox-publisher.worker';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const endpoint = process.env.TEST_SQS_ENDPOINT;
  const aggregateId = process.argv[2];
  const queueName = process.argv[3];

  if (!databaseUrl || !endpoint || !aggregateId || !queueName) {
    throw new Error('Missing crash publisher configuration');
  }

  const orm = await MikroORM.init({
    ...ormConfig,
    clientUrl: databaseUrl,
    dbName: new URL(databaseUrl).pathname.slice(1),
  });

  const transport = new SqsEventPublisher({
    endpoint,
    queueName,
  });

  const crashPublisher: EventPublisher = {
    publish: async (event) => {
      await transport.publish(event);

      // O SQS confirmou o envio, mas publish() ainda
      // não retornou para o worker salvar publishedAt.
      process.kill(process.pid, 'SIGKILL');

      return new Promise<never>(() => {
        // Aguarda o encerramento abrupto.
      });
    },
    close: () => transport.close(),
  };

  const worker = new OutboxPublisherWorker(orm, crashPublisher, {
    aggregateId,
    batchSize: 1,
  });

  try {
    await worker.runOnce();

    throw new Error('Crash publisher did not publish an event');
  } finally {
    await worker.onModuleDestroy();
    await orm.close(true);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Crash helper failed');

  process.exitCode = 1;
});
