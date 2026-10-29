import { CurrencyMismatchError, Money } from '../value-objects/money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletMovementProps {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

export class InvalidWalletOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWalletOperationError';
  }
}

export class InsufficientBalanceError extends Error {
  constructor() {
    super('Wallet has insufficient balance');
    this.name = 'InsufficientBalanceError';
  }
}

export class Wallet {
  private readonly createdAtTimestamp: number;
  private updatedAtTimestamp: number;

  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    createdAt: Date,
    updatedAt: Date,
  ) {
    this.createdAtTimestamp = createdAt.getTime();
    this.updatedAtTimestamp = updatedAt.getTime();
  }

  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    at: Date;
  }): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletOperationError(
        'Initial balance cannot be negative',
      );
    }

    if (!Number.isFinite(props.at.getTime())) {
      throw new InvalidWalletOperationError('Invalid opening date');
    }

    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.at,
      props.at,
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get createdAt(): Date {
    return new Date(this.createdAtTimestamp);
  }

  get updatedAt(): Date {
    return new Date(this.updatedAtTimestamp);
  }

  debit(props: WalletMovementProps): WalletLedgerEntry {
    this.assertMovement(props);

    if (this._balance.isLessThan(props.money)) {
      throw new InsufficientBalanceError();
    }

    return this.applyMovement(props, LedgerDirection.Debit);
  }

  credit(props: WalletMovementProps): WalletLedgerEntry {
    this.assertMovement(props);

    return this.applyMovement(props, LedgerDirection.Credit);
  }

  private assertMovement(props: WalletMovementProps): void {
    this.assertSameCurrency(props.money);

    if (!props.money.isPositive()) {
      throw new InvalidWalletOperationError(
        'Movement amount must be strictly positive',
      );
    }

    if (!Number.isFinite(props.at.getTime())) {
      throw new InvalidWalletOperationError('Invalid movement date');
    }

    if (!Number.isSafeInteger(this._version + 1)) {
      throw new InvalidWalletOperationError(
        'Wallet version exceeds supported range',
      );
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError();
    }
  }

  private applyMovement(
    props: WalletMovementProps,
    direction: LedgerDirection,
  ): WalletLedgerEntry {
    const balanceAfter =
      direction === LedgerDirection.Credit
        ? this._balance.add(props.money)
        : this._balance.subtract(props.money);

    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore: this._balance,
      balanceAfter,
      createdAt: props.at,
    });

    // Só altera o estado depois de construir um lançamento válido.
    this._balance = balanceAfter;
    this._version += 1;
    this.updatedAtTimestamp = props.at.getTime();

    return entry;
  }
}
