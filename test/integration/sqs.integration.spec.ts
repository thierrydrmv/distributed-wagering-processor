import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-client';

describe('SQS integration', () => {
  let sqs: SQSClient;
  let queueUrl: string;

  beforeAll(async () => {
    const endpoint = process.env.TEST_SQS_ENDPOINT;

    if (!endpoint) {
      throw new Error('TEST_SQS_ENDPOINT is required');
    }

    sqs = createSqsClient(endpoint);

    const queue = await sqs.send(
      new CreateQueueCommand({
        QueueName: `wager-test-${randomUUID()}.fifo`,
        Attributes: {
          FifoQueue: 'true',
          ContentBasedDeduplication: 'false',
          VisibilityTimeout: '30',
        },
      }),
    );

    if (!queue.QueueUrl) {
      throw new Error('Test queue URL was not returned');
    }

    queueUrl = queue.QueueUrl;
  }, 30_000);

  afterAll(async () => {
    try {
      if (queueUrl) {
        await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
      }
    } finally {
      sqs?.destroy();
    }
  });

  test('supports FIFO deduplication, redelivery and acknowledgement', async () => {
    const businessMessage = {
      messageId: randomUUID(),
      type: 'WagerTransactionRequested',
      data: {
        money: { amount: '25.00', currency: 'BRL' },
      },
    };

    const send = new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(businessMessage),
      MessageGroupId: 'wallet-1',
      MessageDeduplicationId: businessMessage.messageId,
    });

    await sqs.send(send);
    await sqs.send(send);

    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 2,
      }),
    );

    expect(received.Messages).toHaveLength(1);

    const first = received.Messages?.[0];

    if (!first?.ReceiptHandle || !first.Body || !first.MessageId) {
      throw new Error('Expected a complete SQS message');
    }

    const body: unknown = JSON.parse(first.Body);
    expect(body).toEqual(businessMessage);

    // Simula uma entrega não confirmada.
    await sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: first.ReceiptHandle,
        VisibilityTimeout: 0,
      }),
    );

    const redelivered = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 2,
      }),
    );

    const second = redelivered.Messages?.[0];

    if (!second?.ReceiptHandle) {
      throw new Error('Expected message redelivery');
    }

    expect(second.MessageId).toBe(first.MessageId);

    await sqs.send(
      new DeleteMessageCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: second.ReceiptHandle,
      }),
    );

    const empty = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        WaitTimeSeconds: 1,
        MaxNumberOfMessages: 1,
      }),
    );

    expect(empty.Messages ?? []).toHaveLength(0);
  }, 20_000);
});
