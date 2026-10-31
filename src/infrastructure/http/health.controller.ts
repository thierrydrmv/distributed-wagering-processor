import {
  Controller,
  Get,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

export class HealthService implements OnModuleDestroy {
  private readonly sqs: SQSClient;

  constructor(private readonly orm: MikroORM) {
    this.sqs = new SQSClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
      ...(process.env.SQS_ENDPOINT
        ? { endpoint: process.env.SQS_ENDPOINT }
        : {}),
      maxAttempts: 1,
    });
  }

  async ready(): Promise<{
    status: 'ok';
    checks: {
      postgres: 'up';
      sqs: 'up';
    };
  }> {
    const [postgres, sqs] = await Promise.allSettled([
      this.checkPostgres(),
      this.checkSqs(),
    ]);

    if (postgres.status === 'rejected' || sqs.status === 'rejected') {
      throw new ServiceUnavailableException({
        code: 'NOT_READY',
        status: 'not_ready',
        checks: {
          postgres: postgres.status === 'fulfilled' ? 'up' : 'down',
          sqs: sqs.status === 'fulfilled' ? 'up' : 'down',
        },
      });
    }

    return {
      status: 'ok',
      checks: {
        postgres: 'up',
        sqs: 'up',
      },
    };
  }

  onModuleDestroy(): void {
    this.sqs.destroy();
  }

  private async checkPostgres(): Promise<void> {
    const em = this.orm.em.fork({
      clear: true,
      useContext: false,
    });

    await em.transactional(async (transactionEm) => {
      await transactionEm
        .getConnection()
        .execute(`SET LOCAL statement_timeout = '2000ms'`);

      await transactionEm.getConnection().execute('SELECT 1');
    });
  }

  private async checkSqs(): Promise<void> {
    const queueNames = [
      process.env.SQS_TRANSACTIONS_QUEUE ?? 'wager-transactions.fifo',
      process.env.SQS_TRANSACTIONS_DLQ ?? 'wager-transactions-dlq.fifo',
      process.env.SQS_EVENTS_QUEUE ?? 'wager-events.fifo',
    ];

    const abortSignal = AbortSignal.timeout(3_000);

    await Promise.all(
      queueNames.map(async (queueName) => {
        const queue = await this.sqs.send(
          new GetQueueUrlCommand({
            QueueName: queueName,
          }),
          { abortSignal },
        );

        if (!queue.QueueUrl) {
          throw new Error('SQS queue URL is unavailable');
        }

        await this.sqs.send(
          new GetQueueAttributesCommand({
            QueueUrl: queue.QueueUrl,
            AttributeNames: ['QueueArn'],
          }),
          { abortSignal },
        );
      }),
    );
  }
}

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  ready() {
    return this.health.ready();
  }
}
