import { WagerTransactionStatus } from '../../domain/entities/wager-transaction';
import type { WagerTransaction } from '../../domain/entities/wager-transaction';
import type { Money, MoneyProps } from '../../domain/value-objects/money';
import { IntegrationEvent } from './integration-event';
import type { EventContext, IntegrationEventProps } from './integration-event';
import {
  assertEventBalance,
  transactionEventData,
} from './wager-transaction-event-data';
import type { WagerTransactionEventData } from './wager-transaction-event-data';

export interface WagerTransactionProcessedData extends WagerTransactionEventData {
  balance: MoneyProps;
  processedAt: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  private constructor(
    props: IntegrationEventProps<WagerTransactionProcessedData>,
  ) {
    super(props);
    Object.freeze(this);
  }

  static from(
    transaction: WagerTransaction,
    balance: Money,
    context: EventContext,
  ): WagerTransactionProcessed {
    const processedAt = transaction.processedAt;

    if (
      transaction.status !== WagerTransactionStatus.Processed ||
      processedAt === undefined
    ) {
      throw new Error('Processed event requires a processed transaction');
    }

    assertEventBalance(transaction, balance);

    return new WagerTransactionProcessed({
      ...context,
      aggregateId: transaction.walletId,
      data: {
        ...transactionEventData(transaction),
        balance: balance.toJSON(),
        processedAt: processedAt.toISOString(),
      },
    });
  }
}
