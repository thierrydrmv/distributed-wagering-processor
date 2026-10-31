import { GetQueueUrlCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { IntegrationEventEnvelope } from '../../application/events/integration-event';
import type { EventPublisher } from '../../application/ports/event-publisher';
import { createSqsClient, queueNames } from './sqs-client';

export interface SqsEventPublisherOptions {
  endpoint?: string;
  queueName?: string;
}

export class SqsEventPublisher implements EventPublisher {
  private readonly sqs: SQSClient;
  private queueUrl: Promise<string> | undefined;

  constructor(private readonly options: SqsEventPublisherOptions = {}) {
    this.sqs = createSqsClient(options.endpoint);
  }

  async publish(event: IntegrationEventEnvelope<object>): Promise<void> {
    const queueUrl = await this.getQueueUrl();

    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(event),
        MessageGroupId: event.aggregateId,
        MessageDeduplicationId: event.eventId,
      }),
      { abortSignal: AbortSignal.timeout(10_000) },
    );
  }

  close(): void {
    this.sqs.destroy();
  }

  private getQueueUrl(): Promise<string> {
    if (this.queueUrl === undefined) {
      this.queueUrl = this.resolveQueueUrl().catch((error: unknown) => {
        this.queueUrl = undefined;
        throw error;
      });
    }

    return this.queueUrl;
  }

  private async resolveQueueUrl(): Promise<string> {
    const result = await this.sqs.send(
      new GetQueueUrlCommand({
        QueueName: this.options.queueName ?? queueNames().events,
      }),
      { abortSignal: AbortSignal.timeout(10_000) },
    );

    if (!result.QueueUrl) {
      throw new Error('Events queue URL was not returned');
    }

    return result.QueueUrl;
  }
}
