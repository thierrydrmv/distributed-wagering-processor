import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import type { Message, SQSClient } from '@aws-sdk/client-sqs';
import { WageringError } from '../../application/errors/wagering-error';
import { ProcessWagerTransaction } from '../../application/use-cases/process-wager-transaction';
import { payloadHash } from '../../application/utils/payload-hash';
import { InvalidMoneyError } from '../../domain/value-objects/money';
import { InvalidWagerTransactionError } from '../../domain/entities/wager-transaction';
import { createSqsClient, queueNames } from './sqs-client';
import { SqsWagerMessageDto } from './sqs-wager.dto';

interface QueueUrls {
  transactions: string;
  dlq: string;
}

export interface SqsConsumerOptions {
  endpoint?: string;
  transactionsQueue: string;
  dlqQueue: string;
  maxAttempts?: number;
}

export class SqsWagerConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SqsWagerConsumer.name);
  private readonly sqs: SQSClient;
  private readonly abort = new AbortController();
  private readonly maxAttempts: number;

  private urls: Promise<QueueUrls> | undefined;
  private loop: Promise<void> | undefined;
  private stopping = false;
  private polling = false;

  constructor(
    private readonly processor: ProcessWagerTransaction,
    private readonly options: SqsConsumerOptions = {
      transactionsQueue: queueNames().transactions,
      dlqQueue: queueNames().dlq,
    },
  ) {
    this.sqs = createSqsClient(options.endpoint);
    this.maxAttempts = options.maxAttempts ?? 5;
  }

  onModuleInit(): void {
    if (process.env.SQS_CONSUMER_ENABLED !== 'true') {
      return;
    }

    this.loop = this.consume();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    this.abort.abort();

    try {
      await this.loop;
    } finally {
      this.sqs.destroy();
    }
  }

  async runOnce(waitTimeSeconds = 10): Promise<number> {
    if (this.stopping || this.polling) {
      return 0;
    }

    this.polling = true;

    try {
      const urls = await this.getQueueUrls();

      const result = await this.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: urls.transactions,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: waitTimeSeconds,
          VisibilityTimeout: 30,
          MessageSystemAttributeNames: [
            'ApproximateReceiveCount',
            'MessageGroupId',
          ],
        }),
        { abortSignal: this.abort.signal },
      );

      const messages = result.Messages ?? [];

      for (const message of messages) {
        if (this.stopping) {
          if (message.ReceiptHandle) {
            await this.changeVisibility(
              urls.transactions,
              message.ReceiptHandle,
              0,
            );
          }

          continue;
        }

        await this.handle(message, urls);
      }

      return messages.length;
    } finally {
      this.polling = false;
    }
  }

  private async consume(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.runOnce();
      } catch (error) {
        if (!this.stopping) {
          this.logFailure('sqs_poll_failed', error);

          await new Promise<void>((resolve) => {
            setTimeout(resolve, 1_000);
          });
        }
      }
    }
  }

  private async handle(message: Message, urls: QueueUrls): Promise<void> {
    const receiptHandle = message.ReceiptHandle;

    if (!receiptHandle) {
      throw new Error('SQS message has no receipt handle');
    }

    const stopHeartbeat = this.startHeartbeat(urls.transactions, receiptHandle);

    try {
      try {
        const envelope = await this.parseMessage(message.Body);

        const correlationId = envelope.correlationId ?? envelope.messageId;

        const result = await this.processor.execute(
          {
            ...envelope.data,
            correlationId,
          },
          {
            consumerName: 'wager-transactions-v1',
            messageId: envelope.messageId,
            payloadHash: this.messageHash(envelope),
          },
        );

        this.logger.log(
          JSON.stringify({
            event: 'sqs_transaction_committed',
            correlationId,
            messageId: envelope.messageId,
            transactionId: result.transactionId,
            walletId: envelope.data.walletId,
            providerId: envelope.data.providerId,
            status: result.status,
          }),
        );
      } catch (error) {
        await this.handleFailure(message, urls, error);
        return;
      }

      // O processador só retorna depois do COMMIT.
      await this.sqs.send(
        new DeleteMessageCommand({
          QueueUrl: urls.transactions,
          ReceiptHandle: receiptHandle,
        }),
      );
    } finally {
      await stopHeartbeat();
    }
  }

  private async handleFailure(
    message: Message,
    urls: QueueUrls,
    error: unknown,
  ): Promise<void> {
    const receiptHandle = message.ReceiptHandle;

    if (!receiptHandle) {
      throw new Error('SQS message has no receipt handle');
    }

    const rawCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');

    const attempts =
      Number.isSafeInteger(rawCount) && rawCount > 0 ? rawCount : 1;

    const permanent =
      error instanceof WageringError ||
      error instanceof InvalidMoneyError ||
      error instanceof InvalidWagerTransactionError;

    this.logFailure(
      permanent ? 'sqs_message_invalid' : 'sqs_processing_failed',
      error,
      message.MessageId,
    );

    if (permanent || attempts >= this.maxAttempts) {
      const failureCode =
        error instanceof WageringError
          ? error.code
          : permanent
            ? 'INVALID_MESSAGE'
            : 'PROCESSING_RETRIES_EXHAUSTED';

      // Só remove da origem depois de confirmar o envio à DLQ.
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: urls.dlq,
          MessageBody: message.Body ?? '{}',
          MessageGroupId:
            message.Attributes?.MessageGroupId ?? 'invalid-message',
          MessageDeduplicationId: message.MessageId ?? randomUUID(),
          MessageAttributes: {
            failureCode: {
              DataType: 'String',
              StringValue: failureCode,
            },
          },
        }),
      );

      await this.sqs.send(
        new DeleteMessageCommand({
          QueueUrl: urls.transactions,
          ReceiptHandle: receiptHandle,
        }),
      );

      return;
    }

    const delay = this.stopping
      ? 0
      : Math.min(30, 2 ** Math.min(attempts - 1, 5));

    await this.changeVisibility(urls.transactions, receiptHandle, delay);
  }

  private async parseMessage(
    body: string | undefined,
  ): Promise<SqsWagerMessageDto> {
    if (!body) {
      throw new WageringError('INVALID_MESSAGE', 'Message body is required');
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(body);
    } catch {
      throw new WageringError(
        'INVALID_MESSAGE',
        'Message body must be valid JSON',
      );
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new WageringError(
        'INVALID_MESSAGE',
        'Message body must be an object',
      );
    }

    const envelope = plainToInstance(SqsWagerMessageDto, parsed);

    const errors = await validate(envelope, {
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      validationError: {
        target: false,
        value: false,
      },
    });

    if (errors.length !== 0) {
      throw new WageringError('INVALID_MESSAGE', 'Message envelope is invalid');
    }

    return envelope;
  }

  private messageHash(envelope: SqsWagerMessageDto): string {
    const data = envelope.data;

    return payloadHash({
      messageId: envelope.messageId,
      type: envelope.type,
      occurredAt: envelope.occurredAt,
      correlationId: envelope.correlationId ?? null,
      data: {
        providerId: data.providerId,
        externalTransactionId: data.externalTransactionId,
        idempotencyKey: data.idempotencyKey,
        playerId: data.playerId,
        walletId: data.walletId,
        roundId: data.roundId,
        gameId: data.gameId,
        kind: data.kind,
        money: { ...data.money },
        referenceExternalTransactionId:
          data.referenceExternalTransactionId ?? null,
      },
    });
  }

  private getQueueUrls(): Promise<QueueUrls> {
    if (this.urls === undefined) {
      this.urls = this.resolveQueueUrls().catch((error: unknown) => {
        this.urls = undefined;
        throw error;
      });
    }

    return this.urls;
  }

  private async resolveQueueUrls(): Promise<QueueUrls> {
    const [transactions, dlq] = await Promise.all([
      this.sqs.send(
        new GetQueueUrlCommand({
          QueueName: this.options.transactionsQueue,
        }),
      ),
      this.sqs.send(
        new GetQueueUrlCommand({
          QueueName: this.options.dlqQueue,
        }),
      ),
    ]);

    if (!transactions.QueueUrl || !dlq.QueueUrl) {
      throw new Error('SQS queue URLs were not returned');
    }

    return {
      transactions: transactions.QueueUrl,
      dlq: dlq.QueueUrl,
    };
  }

  private changeVisibility(
    queueUrl: string,
    receiptHandle: string,
    seconds: number,
  ): Promise<void> {
    return this.sqs
      .send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: seconds,
        }),
      )
      .then(() => undefined);
  }

  private startHeartbeat(
    queueUrl: string,
    receiptHandle: string,
  ): () => Promise<void> {
    let pending: Promise<void> | undefined;

    const timer = setInterval(() => {
      if (pending !== undefined) {
        return;
      }

      pending = this.changeVisibility(queueUrl, receiptHandle, 30)
        .catch((error: unknown) => {
          this.logFailure('sqs_visibility_extension_failed', error);
        })
        .finally(() => {
          pending = undefined;
        });
    }, 10_000);

    timer.unref();

    return async () => {
      clearInterval(timer);
      await pending;
    };
  }

  private logFailure(event: string, error: unknown, messageId?: string): void {
    this.logger.error(
      JSON.stringify({
        event,
        messageId,
        errorType: error instanceof Error ? error.name : 'UnknownError',
        failureCode: error instanceof WageringError ? error.code : undefined,
      }),
    );
  }
}
