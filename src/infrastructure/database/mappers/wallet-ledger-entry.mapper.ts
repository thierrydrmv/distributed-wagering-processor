import { WalletLedgerEntry } from '../../../domain/entities/wallet-ledger-entry';
import { Money } from '../../../domain/value-objects/money';
import { WalletLedgerEntryRecord } from '../entities/wallet-ledger-entry.record';

export class WalletLedgerEntryMapper {
  static toDomain(record: WalletLedgerEntryRecord): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: record.id,
      walletId: record.walletId,
      transactionId: record.transactionId,
      direction: record.direction,
      money: Money.from({
        amount: record.amount,
        currency: record.currency,
      }),
      balanceBefore: Money.from({
        amount: record.balanceBefore,
        currency: record.currency,
      }),
      balanceAfter: Money.from({
        amount: record.balanceAfter,
        currency: record.currency,
      }),
      createdAt: record.createdAt,
    });
  }

  static toRecord(entry: WalletLedgerEntry): WalletLedgerEntryRecord {
    const record = new WalletLedgerEntryRecord();

    record.id = entry.id;
    record.walletId = entry.walletId;
    record.transactionId = entry.transactionId;
    record.direction = entry.direction;
    record.amount = entry.money.toJSON().amount;
    record.currency = entry.money.currency;
    record.balanceBefore = entry.balanceBefore.toJSON().amount;
    record.balanceAfter = entry.balanceAfter.toJSON().amount;
    record.createdAt = entry.createdAt;

    return record;
  }
}
