import 'dotenv/config';

import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import {
  createSqsClient,
  queueNames,
} from '../infrastructure/messaging/sqs-client';

async function setupQueues(): Promise<void> {
  const sqs = createSqsClient();
  const names = queueNames();

  try {
    const dlq = await sqs.send(
      new CreateQueueCommand({
        QueueName: names.dlq,
        Attributes: {
          FifoQueue: 'true',
          ContentBasedDeduplication: 'false',
          MessageRetentionPeriod: '1209600',
        },
      }),
    );

    if (!dlq.QueueUrl) {
      throw new Error('DLQ URL was not returned');
    }

    const attributes = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: dlq.QueueUrl,
        AttributeNames: ['QueueArn'],
      }),
    );

    const dlqArn = attributes.Attributes?.QueueArn;

    if (!dlqArn) {
      throw new Error('DLQ ARN was not returned');
    }

    const transactions = await sqs.send(
      new CreateQueueCommand({
        QueueName: names.transactions,
        Attributes: {
          FifoQueue: 'true',
          ContentBasedDeduplication: 'false',
          VisibilityTimeout: '30',
          ReceiveMessageWaitTimeSeconds: '10',
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: dlqArn,
            maxReceiveCount: 5,
          }),
        },
      }),
    );

    const events = await sqs.send(
      new CreateQueueCommand({
        QueueName: names.events,
        Attributes: {
          FifoQueue: 'true',
          ContentBasedDeduplication: 'false',
          VisibilityTimeout: '30',
          ReceiveMessageWaitTimeSeconds: '10',
        },
      }),
    );

    if (!transactions.QueueUrl || !events.QueueUrl) {
      throw new Error('Queue URLs were not returned');
    }

    console.log(
      JSON.stringify({
        event: 'sqs_queues_ready',
        transactions: transactions.QueueUrl,
        dlq: dlq.QueueUrl,
        events: events.QueueUrl,
      }),
    );
  } finally {
    sqs.destroy();
  }
}

void setupQueues().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: 'sqs_setup_failed',
      errorType: error instanceof Error ? error.name : 'UnknownError',
      message: error instanceof Error ? error.message : 'Setup failed',
    }),
  );

  process.exitCode = 1;
});
