import { randomUUID } from 'node:crypto';
import { Wallet } from '../../domain/entities/wallet';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../domain/entities/wallet-ledger-entry';
import {
  WagerTransaction,
  WagerTransactionKind,
} from '../../domain/entities/wager-transaction';
import { Money } from '../../domain/value-objects/money';
import type { MoneyProps } from '../../domain/value-objects/money';
import { FinancialUnitOfWork } from '../ports/financial-unit-of-work';
import { WalletBalanceChanged } from '../events/wallet-balance-changed';
import { WagerTransactionProcessed } from '../events/wager-transaction-processed';
import { OutboxMessage } from '../outbox/outbox-message';
import { payloadHash } from '../utils/payload-hash';

export interface OpenWalletRequest {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId?: string;
}

export interface OpenWalletResponse {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export class OpenWallet {
  constructor(private readonly uow: FinancialUnitOfWork) {}

  async execute(request: OpenWalletRequest): Promise<OpenWalletResponse> {
    const initialBalance = Money.from(request.initialBalance);
    const at = new Date();
    const walletId = randomUUID();
    const correlationId = request.correlationId ?? randomUUID();

    const wallet = Wallet.open({
      id: walletId,
      playerId: request.playerId,
      initialBalance,
      at,
    });

    return this.uow.execute(
      async ({ wallets, transactions, ledger, outbox }) => {
        await wallets.insert(wallet);

        if (initialBalance.isPositive()) {
          const transactionId = randomUUID();

          const opening = WagerTransaction.create({
            id: transactionId,
            providerId: 'internal',
            externalTransactionId: `opening:${walletId}`,
            idempotencyKey: `internal:opening:${walletId}`,
            payloadHash: payloadHash({
              kind: WagerTransactionKind.Opening,
              walletId,
              playerId: request.playerId,
              money: { ...initialBalance.toJSON() },
            }),
            walletId,
            playerId: request.playerId,
            roundId: `opening:${walletId}`,
            gameId: 'internal',
            kind: WagerTransactionKind.Opening,
            money: initialBalance,
            createdAt: at,
          });

          opening.markProcessed(undefined, at);

          const entry = WalletLedgerEntry.create({
            id: randomUUID(),
            walletId,
            transactionId,
            direction: LedgerDirection.Credit,
            money: initialBalance,
            balanceBefore: Money.zero(wallet.currency),
            balanceAfter: initialBalance,
            createdAt: at,
          });

          await transactions.insert(opening, initialBalance);
          await ledger.insert(entry);

          const processedEvent = WagerTransactionProcessed.from(
            opening,
            initialBalance,
            {
              eventId: randomUUID(),
              correlationId,
              causationId: transactionId,
              occurredAt: at,
            },
          );

          const balanceEvent = WalletBalanceChanged.from(wallet, entry, {
            eventId: randomUUID(),
            correlationId,
            causationId: transactionId,
            occurredAt: at,
          });

          await outbox.insert(OutboxMessage.enqueue(processedEvent));
          await outbox.insert(OutboxMessage.enqueue(balanceEvent));
        }

        return {
          id: wallet.id,
          playerId: wallet.playerId,
          balance: wallet.balance.toJSON(),
          version: wallet.version,
        };
      },
    );
  }
}
