import type { Wallet } from '../../domain/entities/wallet';

export interface WalletRepository {
  insert(wallet: Wallet): Promise<void>;
  findByIdForUpdate(id: string): Promise<Wallet | null>;
  save(wallet: Wallet): Promise<void>;
}

export interface FinancialTransactionContext {
  wallets: WalletRepository;
}

export abstract class FinancialUnitOfWork {
  abstract execute<T>(
    work: (context: FinancialTransactionContext) => Promise<T>,
  ): Promise<T>;
}
