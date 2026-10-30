import type { Wallet } from '../../domain/entities/wallet';
import type { WalletLedgerEntry } from '../../domain/entities/wallet-ledger-entry';
import type { WagerTransaction } from '../../domain/entities/wager-transaction';
import type { Money } from '../../domain/value-objects/money';
import { OutboxMessage } from '../outbox/outbox-message';

export interface WalletRepository {
  insert(wallet: Wallet): Promise<void>;
  findByIdForUpdate(id: string): Promise<Wallet | null>;
  save(wallet: Wallet): Promise<void>;
}

export interface StoredWagerTransaction {
  transaction: WagerTransaction;
  resultBalance: Money | null;
}

export interface WagerTransactionRepository {
  insert(
    transaction: WagerTransaction,
    resultBalance?: Money | null,
  ): Promise<void>;

  findById(id: string): Promise<StoredWagerTransaction | null>;

  findByIdempotencyKey(key: string): Promise<StoredWagerTransaction | null>;

  findByProviderExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<StoredWagerTransaction | null>;

  save(
    transaction: WagerTransaction,
    resultBalance?: Money | null,
  ): Promise<void>;
}

export interface WalletLedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
}

export interface FinancialTransactionContext {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: WalletLedgerRepository;
  outbox: OutboxRepository;
}

export abstract class FinancialUnitOfWork {
  abstract execute<T>(
    work: (context: FinancialTransactionContext) => Promise<T>,
  ): Promise<T>;
}

export interface OutboxRepository {
  insert(message: OutboxMessage): Promise<void>;
}
