import type {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/entities/wager-transaction';
import { CurrencyMismatchError } from '../../domain/value-objects/money';
import type { Money, MoneyProps } from '../../domain/value-objects/money';

export interface WagerTransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus;
  money: MoneyProps;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
}

export function transactionEventData(
  transaction: WagerTransaction,
): WagerTransactionEventData {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    status: transaction.status,
    money: transaction.money.toJSON(),
    referenceExternalTransactionId:
      transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
  };
}

export function assertEventBalance(
  transaction: WagerTransaction,
  balance: Money,
): void {
  if (balance.currency !== transaction.money.currency) {
    throw new CurrencyMismatchError();
  }

  if (balance.isNegative()) {
    throw new Error('Event balance cannot be negative');
  }
}
