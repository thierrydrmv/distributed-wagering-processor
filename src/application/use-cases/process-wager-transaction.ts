import { randomUUID } from 'node:crypto';
import type { Wallet } from '../../domain/entities/wallet';
import { LedgerDirection } from '../../domain/entities/wallet-ledger-entry';
import {
  FailureCode,
  InvalidTransactionReferenceError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/entities/wager-transaction';
import { InvalidMoneyError, Money } from '../../domain/value-objects/money';
import type { MoneyProps } from '../../domain/value-objects/money';
import {
  PersistenceConflictError,
  WageringError,
} from '../errors/wagering-error';
import type {
  EventContext,
  IntegrationEvent,
} from '../events/integration-event';
import { WalletBalanceChanged } from '../events/wallet-balance-changed';
import { WagerTransactionProcessed } from '../events/wager-transaction-processed';
import { WagerTransactionRejected } from '../events/wager-transaction-rejected';
import { WagerTransactionPendingReference } from '../events/wager-transaction-pending-reference';
import { OutboxMessage } from '../outbox/outbox-message';
import { FinancialUnitOfWork } from '../ports/financial-unit-of-work';
import type {
  FinancialTransactionContext,
  StoredWagerTransaction,
} from '../ports/financial-unit-of-work';
import { payloadHash } from '../utils/payload-hash';
import { InboxMessage } from '../inbox/inbox-message';
import type { InboxDelivery } from '../inbox/inbox-message';

export interface ProcessWagerRequest {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId?: string;
}

export interface ProcessWagerResponse {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps | null;
  failureCode: FailureCode | null;
  idempotentReplay: boolean;
}

export class ProcessWagerTransaction {
  constructor(private readonly uow: FinancialUnitOfWork) {}

  async execute(
    request: ProcessWagerRequest,
    delivery?: InboxDelivery,
  ): Promise<ProcessWagerResponse> {
    if (!request.idempotencyKey?.trim()) {
      throw new WageringError(
        'INVALID_IDEMPOTENCY_KEY',
        'Idempotency-Key is required',
      );
    }

    if (
      request.kind === WagerTransactionKind.Opening ||
      request.providerId === 'internal'
    ) {
      throw new WageringError(
        'INTERNAL_OPERATION_FORBIDDEN',
        'Internal operations cannot be submitted externally',
      );
    }

    const money = Money.from(request.money);

    const hash = payloadHash({
      providerId: request.providerId,
      externalTransactionId: request.externalTransactionId,
      playerId: request.playerId,
      walletId: request.walletId,
      roundId: request.roundId,
      gameId: request.gameId,
      kind: request.kind,
      money: { ...money.toJSON() },
      referenceExternalTransactionId:
        request.referenceExternalTransactionId ?? null,
    });

    const transactionId = randomUUID();
    const correlationId = request.correlationId ?? randomUUID();
    const createdAt = new Date();

    // Cada tentativa recebe uma entidade nova.
    // Nunca reutilizamos uma entidade alterada por um rollback.
    const createTransaction = () =>
      WagerTransaction.create({
        id: transactionId,
        providerId: request.providerId,
        externalTransactionId: request.externalTransactionId,
        idempotencyKey: request.idempotencyKey,
        payloadHash: hash,
        walletId: request.walletId,
        playerId: request.playerId,
        roundId: request.roundId,
        gameId: request.gameId,
        kind: request.kind,
        money,
        referenceExternalTransactionId: request.referenceExternalTransactionId,
        createdAt,
      });

    // Valida o contrato de domínio antes de acessar o banco.
    createTransaction();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.uow.execute(async (context) => {
          const inboxMessage =
            delivery === undefined
              ? undefined
              : await this.receiveInbox(context, delivery);

          const result = await this.executeFinancial(
            context,
            request,
            hash,
            createTransaction(),
            correlationId,
          );

          if (inboxMessage !== undefined) {
            if (inboxMessage.isProcessed()) {
              if (inboxMessage.transactionId !== result.transactionId) {
                throw new WageringError(
                  'INBOX_CONFLICT',
                  'Inbox message refers to another transaction',
                );
              }
            } else {
              inboxMessage.markProcessed(result.transactionId, new Date());

              await context.inbox.save(inboxMessage);
            }
          }

          return result;
        });
      } catch (error) {
        if (error instanceof PersistenceConflictError && attempt === 0) {
          continue;
        }

        throw error;
      }
    }

    throw new Error('Transaction retry limit exhausted');
  }

  async resumePendingReference(
    transactionId: string,
    expired = false,
  ): Promise<ProcessWagerResponse> {
    return this.uow.execute(async (context) => {
      const initial = await context.transactions.findById(transactionId);

      if (initial === null) {
        throw new WageringError(
          'TRANSACTION_NOT_FOUND',
          'Transaction does not exist',
        );
      }

      const wallet = await context.wallets.findByIdForUpdate(
        initial.transaction.walletId,
      );

      if (wallet === null) {
        throw new WageringError('WALLET_NOT_FOUND', 'Wallet does not exist');
      }

      const current = await context.transactions.findById(transactionId);

      if (current === null) {
        throw new WageringError(
          'TRANSACTION_NOT_FOUND',
          'Transaction does not exist',
        );
      }

      if (
        current.transaction.status !== WagerTransactionStatus.PendingReference
      ) {
        return this.response(current.transaction, current.resultBalance, true);
      }

      if (expired) {
        return this.reject(
          context,
          current.transaction,
          FailureCode.ReferenceNotFound,
          wallet.balance,
          {
            eventId: randomUUID(),
            correlationId: transactionId,
            causationId: transactionId,
            occurredAt: new Date(),
          },
        );
      }

      return this.apply(context, current.transaction, wallet, transactionId);
    });
  }

  private async apply(
    context: FinancialTransactionContext,
    transaction: WagerTransaction,
    wallet: Wallet,
    correlationId: string,
  ): Promise<ProcessWagerResponse> {
    const at = new Date();

    const eventContext = (): EventContext => ({
      eventId: randomUUID(),
      correlationId,
      causationId: transaction.id,
      occurredAt: at,
    });

    if (wallet.currency !== transaction.money.currency) {
      return this.reject(
        context,
        transaction,
        FailureCode.CurrencyMismatch,
        null,
        eventContext(),
      );
    }

    if (wallet.playerId !== transaction.playerId) {
      return this.reject(
        context,
        transaction,
        FailureCode.WalletPlayerMismatch,
        wallet.balance,
        eventContext(),
      );
    }

    let reference: WagerTransaction | undefined;

    if (transaction.referenceExternalTransactionId !== undefined) {
      const storedReference =
        await context.transactions.findByProviderExternalId(
          transaction.providerId,
          transaction.referenceExternalTransactionId,
        );

      if (storedReference === null) {
        return this.pendingReference(context, transaction, eventContext());
      }

      reference = storedReference.transaction;

      try {
        transaction.validateReference(reference);
      } catch (error) {
        if (!(error instanceof InvalidTransactionReferenceError)) {
          throw error;
        }

        if (
          error.code === FailureCode.ReferenceNotProcessed &&
          !reference.isTerminal()
        ) {
          return this.pendingReference(context, transaction, eventContext());
        }

        return this.reject(
          context,
          transaction,
          error.code,
          wallet.balance,
          eventContext(),
        );
      }
    }

    if (transaction.requiresReference() && reference !== undefined) {
      const previousReversal = await context.transactions.findProcessedReversal(
        reference.id,
        transaction.kind,
      );

      if (previousReversal !== null) {
        return this.reject(
          context,
          transaction,
          FailureCode.ReferenceAlreadyReversed,
          wallet.balance,
          eventContext(),
        );
      }
    }

    const direction = transaction.ledgerDirectionFor(reference);

    if (
      direction === LedgerDirection.Debit &&
      wallet.balance.isLessThan(transaction.money)
    ) {
      return this.reject(
        context,
        transaction,
        transaction.kind === WagerTransactionKind.Bet
          ? FailureCode.InsufficientBalance
          : FailureCode.ReversalInsufficientBalance,
        wallet.balance,
        eventContext(),
      );
    }

    let entry: ReturnType<Wallet['credit']> | undefined;

    if (direction !== undefined) {
      const movement = {
        entryId: randomUUID(),
        transactionId: transaction.id,
        money: transaction.money,
        at,
      };

      try {
        entry =
          direction === LedgerDirection.Credit
            ? wallet.credit(movement)
            : wallet.debit(movement);
      } catch (error) {
        if (!(error instanceof InvalidMoneyError)) {
          throw error;
        }

        return this.reject(
          context,
          transaction,
          FailureCode.BalanceLimitExceeded,
          wallet.balance,
          eventContext(),
        );
      }
    }

    transaction.markProcessed(reference?.id, at);

    await context.transactions.save(transaction, wallet.balance);

    if (entry !== undefined) {
      await context.wallets.save(wallet);
      await context.ledger.insert(entry);
    }

    await this.enqueue(
      context,
      WagerTransactionProcessed.from(
        transaction,
        wallet.balance,
        eventContext(),
      ),
    );

    if (entry !== undefined) {
      await this.enqueue(
        context,
        WalletBalanceChanged.from(wallet, entry, eventContext()),
      );
    }

    return this.response(transaction, wallet.balance, false);
  }

  private async reject(
    context: FinancialTransactionContext,
    transaction: WagerTransaction,
    code: FailureCode,
    balance: Money | null,
    eventContext: EventContext,
  ): Promise<ProcessWagerResponse> {
    transaction.reject(code);

    await context.transactions.save(transaction, balance);

    await this.enqueue(
      context,
      WagerTransactionRejected.from(transaction, balance, eventContext),
    );

    return this.response(transaction, balance, false);
  }

  private async pendingReference(
    context: FinancialTransactionContext,
    transaction: WagerTransaction,
    eventContext: EventContext,
  ): Promise<ProcessWagerResponse> {
    // Não gera outro evento em cada tentativa sem referência.
    if (transaction.status === WagerTransactionStatus.PendingReference) {
      return this.response(transaction, null, false);
    }

    transaction.markPendingReference();

    await context.transactions.save(transaction);

    await this.enqueue(
      context,
      WagerTransactionPendingReference.from(transaction, eventContext),
    );

    return this.response(transaction, null, false);
  }

  private replay(
    stored: StoredWagerTransaction,
    hash: string,
  ): ProcessWagerResponse {
    if (!stored.transaction.matchesPayload(hash)) {
      throw new WageringError(
        'IDEMPOTENCY_CONFLICT',
        'Idempotency key was already used with a different payload',
      );
    }

    return this.response(stored.transaction, stored.resultBalance, true);
  }

  private response(
    transaction: WagerTransaction,
    balance: Money | null,
    idempotentReplay: boolean,
  ): ProcessWagerResponse {
    return {
      transactionId: transaction.id,
      status: transaction.status,
      balance: balance?.toJSON() ?? null,
      failureCode: transaction.failureCode ?? null,
      idempotentReplay,
    };
  }

  private async enqueue(
    context: FinancialTransactionContext,
    event: IntegrationEvent<object>,
  ): Promise<void> {
    await context.outbox.insert(OutboxMessage.enqueue(event));
  }

  private async receiveInbox(
    context: FinancialTransactionContext,
    delivery: InboxDelivery,
  ): Promise<InboxMessage> {
    const existing = await context.inbox.findByIdentity(
      delivery.consumerName,
      delivery.messageId,
    );

    if (existing !== null) {
      if (!existing.matchesPayload(delivery.payloadHash)) {
        throw new WageringError(
          'INBOX_CONFLICT',
          'Message identity was reused with another payload',
        );
      }

      return existing;
    }

    const message = InboxMessage.receive({
      ...delivery,
      receivedAt: new Date(),
    });

    await context.inbox.insert(message);

    return message;
  }

  private async executeFinancial(
    context: FinancialTransactionContext,
    request: ProcessWagerRequest,
    hash: string,
    transaction: WagerTransaction,
    correlationId: string,
  ): Promise<ProcessWagerResponse> {
    const existing = await context.transactions.findByIdempotencyKey(
      request.idempotencyKey,
    );

    if (existing !== null) {
      return this.replay(existing, hash);
    }

    const wallet = await context.wallets.findByIdForUpdate(request.walletId);

    if (wallet === null) {
      throw new WageringError('WALLET_NOT_FOUND', 'Wallet does not exist');
    }

    const afterLock = await context.transactions.findByIdempotencyKey(
      request.idempotencyKey,
    );

    if (afterLock !== null) {
      return this.replay(afterLock, hash);
    }

    const sameExternal = await context.transactions.findByProviderExternalId(
      request.providerId,
      request.externalTransactionId,
    );

    if (sameExternal !== null) {
      throw new WageringError(
        'EXTERNAL_TRANSACTION_CONFLICT',
        'External transaction already exists under another key',
      );
    }

    await context.transactions.insert(transaction);

    return this.apply(context, transaction, wallet, correlationId);
  }
}
