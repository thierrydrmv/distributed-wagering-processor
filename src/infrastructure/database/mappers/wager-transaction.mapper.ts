import {
  WagerTransaction,
  WagerTransactionStatus,
} from '../../../domain/entities/wager-transaction';
import {
  CurrencyMismatchError,
  Money,
} from '../../../domain/value-objects/money';
import { WagerTransactionRecord } from '../entities/wager-transaction.record';

export class WagerTransactionMapper {
  static toDomain(record: WagerTransactionRecord): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: record.id,
      providerId: record.providerId,
      externalTransactionId: record.externalTransactionId,
      idempotencyKey: record.idempotencyKey,
      payloadHash: record.payloadHash,
      walletId: record.walletId,
      playerId: record.playerId,
      roundId: record.roundId,
      gameId: record.gameId,
      kind: record.kind,
      money: Money.from({
        amount: record.amount,
        currency: record.currency,
      }),
      referenceExternalTransactionId:
        record.referenceExternalTransactionId ?? undefined,
      createdAt: record.createdAt,
      status: record.status,
      referenceTransactionId: record.referenceTransactionId ?? undefined,
      failureCode: record.failureCode ?? undefined,
      processedAt: record.processedAt ?? undefined,
    });
  }

  static toRecord(
    transaction: WagerTransaction,
    resultBalance: Money | null = null,
  ): WagerTransactionRecord {
    if (
      resultBalance !== null &&
      resultBalance.currency !== transaction.money.currency
    ) {
      throw new CurrencyMismatchError();
    }

    if (resultBalance?.isNegative()) {
      throw new Error('Result balance cannot be negative');
    }

    if (
      transaction.status === WagerTransactionStatus.Processed &&
      resultBalance === null
    ) {
      throw new Error(
        'Processed transactions require the original result balance',
      );
    }

    if (!transaction.isTerminal() && resultBalance !== null) {
      throw new Error('Pending transactions cannot have a result balance');
    }

    const record = new WagerTransactionRecord();

    record.id = transaction.id;
    record.providerId = transaction.providerId;
    record.externalTransactionId = transaction.externalTransactionId;
    record.idempotencyKey = transaction.idempotencyKey;
    record.payloadHash = transaction.payloadHash;
    record.walletId = transaction.walletId;
    record.playerId = transaction.playerId;
    record.roundId = transaction.roundId;
    record.gameId = transaction.gameId;
    record.kind = transaction.kind;
    record.amount = transaction.money.toJSON().amount;
    record.currency = transaction.money.currency;
    record.referenceExternalTransactionId =
      transaction.referenceExternalTransactionId ?? null;
    record.referenceTransactionId = transaction.referenceTransactionId ?? null;
    record.status = transaction.status;
    record.failureCode = transaction.failureCode ?? null;
    record.resultBalance = resultBalance?.toJSON().amount ?? null;
    record.createdAt = transaction.createdAt;
    record.processedAt = transaction.processedAt ?? null;

    return record;
  }

  static toResultBalance(record: WagerTransactionRecord): Money | null {
    if (record.resultBalance === null) {
      return null;
    }

    return Money.from({
      amount: record.resultBalance,
      currency: record.currency,
    });
  }
}
