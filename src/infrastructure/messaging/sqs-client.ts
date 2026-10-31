import { SQSClient } from '@aws-sdk/client-sqs';

export function createSqsClient(
  endpoint = process.env.SQS_ENDPOINT,
): SQSClient {
  if (!endpoint) {
    throw new Error('SQS_ENDPOINT is required');
  }

  return new SQSClient({
    endpoint,
    region: process.env.AWS_REGION ?? 'us-east-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
    useQueueUrlAsEndpoint: false,
    maxAttempts: 3,
  });
}

export function queueNames() {
  return {
    transactions:
      process.env.SQS_TRANSACTIONS_QUEUE ?? 'wager-transactions.fifo',

    dlq: process.env.SQS_TRANSACTIONS_DLQ ?? 'wager-transactions-dlq.fifo',

    events: process.env.SQS_EVENTS_QUEUE ?? 'wager-events.fifo',
  };
}
