import { WagerTransactionStatus } from '../../domain/entities/wager-transaction';
import type { WagerTransaction } from '../../domain/entities/wager-transaction';
import { IntegrationEvent } from './integration-event';
import type { EventContext, IntegrationEventProps } from './integration-event';
import { transactionEventData } from './wager-transaction-event-data';
import type { WagerTransactionEventData } from './wager-transaction-event-data';

export interface WagerTransactionPendingReferenceData extends WagerTransactionEventData {
  referenceExternalTransactionId: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  private constructor(
    props: IntegrationEventProps<WagerTransactionPendingReferenceData>,
  ) {
    super(props);
    Object.freeze(this);
  }

  static from(
    transaction: WagerTransaction,
    context: EventContext,
  ): WagerTransactionPendingReference {
    const reference = transaction.referenceExternalTransactionId;

    if (
      transaction.status !== WagerTransactionStatus.PendingReference ||
      reference === undefined
    ) {
      throw new Error(
        'Pending reference event requires a transaction awaiting a reference',
      );
    }

    return new WagerTransactionPendingReference({
      ...context,
      aggregateId: transaction.walletId,
      data: {
        ...transactionEventData(transaction),
        referenceExternalTransactionId: reference,
      },
    });
  }
}
