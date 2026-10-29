import { Money } from '../value-objects/money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export class InvalidLedgerEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidLedgerEntryError';
  }
}

export class WalletLedgerEntry {
  private readonly createdAtTimestamp: number;

  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    createdAt: Date,
  ) {
    this.createdAtTimestamp = createdAt.getTime();

    Object.freeze(this);
  }

  static create(props: LedgerEntryState): WalletLedgerEntry {
    if (
      props.direction !== LedgerDirection.Debit &&
      props.direction !== LedgerDirection.Credit
    ) {
      throw new InvalidLedgerEntryError('Invalid ledger direction');
    }

    if (!props.money.isPositive()) {
      throw new InvalidLedgerEntryError(
        'Ledger amount must be strictly positive',
      );
    }

    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError('Ledger balances cannot be negative');
    }

    if (!Number.isFinite(props.createdAt.getTime())) {
      throw new InvalidLedgerEntryError('Invalid creation date');
    }

    const entry = WalletLedgerEntry.rehydrate(props);

    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError(
        'Ledger entry arithmetic is inconsistent',
      );
    }

    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  get createdAt(): Date {
    return new Date(this.createdAtTimestamp);
  }

  isBalanced(): boolean {
    const expectedBalance =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);

    return expectedBalance.equals(this.balanceAfter);
  }
}
