import { WagerTransactionStatus } from '../../domain/entities/wager-transaction';
import type {
  FailureCode,
  WagerTransaction,
} from '../../domain/entities/wager-transaction';
import type { Money, MoneyProps } from '../../domain/value-objects/money';
import { IntegrationEvent } from './integration-event';
import type { EventContext, IntegrationEventProps } from './integration-event';
import {
  assertEventBalance,
  transactionEventData,
} from './wager-transaction-event-data';
import type { WagerTransactionEventData } from './wager-transaction-event-data';

export interface WagerTransactionRejectedData extends WagerTransactionEventData {
  failureCode: FailureCode;
  balance: MoneyProps | null;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  private constructor(
    props: IntegrationEventProps<WagerTransactionRejectedData>,
  ) {
    super(props);
    Object.freeze(this);
  }

  static from(
    transaction: WagerTransaction,
    balance: Money | null,
    context: EventContext,
  ): WagerTransactionRejected {
    const failureCode = transaction.failureCode;

    if (
      transaction.status !== WagerTransactionStatus.Rejected ||
      failureCode === undefined
    ) {
      throw new Error('Rejected event requires a rejected transaction');
    }

    if (balance !== null) {
      assertEventBalance(transaction, balance);
    }

    return new WagerTransactionRejected({
      ...context,
      aggregateId: transaction.walletId,
      data: {
        ...transactionEventData(transaction),
        failureCode,
        balance: balance?.toJSON() ?? null,
      },
    });
  }
}
