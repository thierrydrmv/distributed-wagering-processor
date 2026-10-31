import { MikroORM } from '@mikro-orm/postgresql';
import ormConfig from '../../src/infrastructure/database/mikro-orm.config';
import { MikroOrmFinancialUnitOfWork } from '../../src/infrastructure/database/mikro-orm-financial-unit-of-work';
import { ProcessWagerTransaction } from '../../src/application/use-cases/process-wager-transaction';
import type {
  ProcessWagerRequest,
  ProcessWagerResponse,
} from '../../src/application/use-cases/process-wager-transaction';
import type { InboxDelivery } from '../../src/application/inbox/inbox-message';
import { SqsWagerConsumer } from '../../src/infrastructure/messaging/sqs-wager.consumer';

class CrashAfterCommitProcessor extends ProcessWagerTransaction {
  override async execute(
    request: ProcessWagerRequest,
    delivery?: InboxDelivery,
  ): Promise<ProcessWagerResponse> {
    await super.execute(request, delivery);

    // O commit terminou, mas o consumidor ainda não recebeu
    // o resultado para executar DeleteMessage.
    process.kill(process.pid, 'SIGKILL');

    return new Promise<never>(() => {
      // Impede continuar até o ACK caso o sinal ainda
      // não tenha encerrado o processo.
    });
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const endpoint = process.env.TEST_SQS_ENDPOINT;
  const transactionsQueue = process.argv[2];
  const dlqQueue = process.argv[3];

  if (!databaseUrl || !endpoint || !transactionsQueue || !dlqQueue) {
    throw new Error('Missing crash consumer configuration');
  }

  const orm = await MikroORM.init({
    ...ormConfig,
    clientUrl: databaseUrl,
    dbName: new URL(databaseUrl).pathname.slice(1),
  });

  const processor = new CrashAfterCommitProcessor(
    new MikroOrmFinancialUnitOfWork(orm),
  );

  const consumer = new SqsWagerConsumer(processor, {
    endpoint,
    transactionsQueue,
    dlqQueue,
  });

  try {
    await consumer.runOnce(10);

    throw new Error('Crash consumer did not process a message');
  } finally {
    await consumer.onModuleDestroy();
    await orm.close(true);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Crash helper failed');

  process.exitCode = 1;
});
