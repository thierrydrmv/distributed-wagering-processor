import { Money } from '../value-objects/money';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export enum FailureCode {
  InsufficientBalance = 'INSUFFICIENT_BALANCE',
  ReversalInsufficientBalance = 'REVERSAL_INSUFFICIENT_BALANCE',
  WalletNotFound = 'WALLET_NOT_FOUND',
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  PermanentInfrastructureFailure = 'PERMANENT_INFRASTRUCTURE_FAILURE',
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
}

export class InvalidWagerTransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWagerTransactionError';
  }
}

export class InvalidTransactionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTransactionStateError';
  }
}

export class WagerTransaction {
  public readonly id: string;
  public readonly providerId: string;
  public readonly externalTransactionId: string;
  public readonly idempotencyKey: string;
  public readonly payloadHash: string;
  public readonly walletId: string;
  public readonly playerId: string;
  public readonly roundId: string;
  public readonly gameId: string;
  public readonly kind: WagerTransactionKind;
  public readonly money: Money;
  public readonly referenceExternalTransactionId: string | undefined;

  private readonly createdAtTimestamp: number;
  private _status: WagerTransactionStatus;
  private _referenceTransactionId: string | undefined;
  private _failureCode: FailureCode | undefined;
  private processedAtTimestamp: number | undefined;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;

    this.createdAtTimestamp = state.createdAt.getTime();
    this._status = state.status;
    this._referenceTransactionId = state.referenceTransactionId;
    this._failureCode = state.failureCode;
    this.processedAtTimestamp = state.processedAt?.getTime();
  }

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (!Object.values(WagerTransactionKind).includes(props.kind)) {
      throw new InvalidWagerTransactionError('Invalid transaction kind');
    }

    const identifiers = [
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
    ];

    if (identifiers.some((value) => !value?.trim())) {
      throw new InvalidWagerTransactionError(
        'Transaction identifiers cannot be empty',
      );
    }

    if (!Number.isFinite(props.createdAt.getTime())) {
      throw new InvalidWagerTransactionError(
        'Invalid transaction creation date',
      );
    }

    if (props.money.isNegative()) {
      throw new InvalidWagerTransactionError(
        'Transaction amount cannot be negative',
      );
    }

    if (props.kind === WagerTransactionKind.Loss && !props.money.isZero()) {
      throw new InvalidWagerTransactionError('LOSS amount must be zero');
    }

    if (
      props.kind !== WagerTransactionKind.Loss &&
      props.kind !== WagerTransactionKind.Win &&
      !props.money.isPositive()
    ) {
      throw new InvalidWagerTransactionError(
        'Transaction amount must be strictly positive',
      );
    }

    const requiresReference =
      props.kind === WagerTransactionKind.Refund ||
      props.kind === WagerTransactionKind.Rollback;

    const reference = props.referenceExternalTransactionId;

    if (
      (requiresReference && !reference?.trim()) ||
      (reference !== undefined && !reference.trim())
    ) {
      throw new InvalidWagerTransactionError(
        'A non-empty reference is required',
      );
    }

    if (reference !== undefined && reference === props.externalTransactionId) {
      throw new InvalidWagerTransactionError(
        'A transaction cannot reference itself',
      );
    }

    if (
      reference !== undefined &&
      (props.kind === WagerTransactionKind.Bet ||
        props.kind === WagerTransactionKind.Opening)
    ) {
      throw new InvalidWagerTransactionError(
        'BET and OPENING cannot reference another transaction',
      );
    }

    return new WagerTransaction({
      ...props,
      status: WagerTransactionStatus.Pending,
      referenceTransactionId: undefined,
      failureCode: undefined,
      processedAt: undefined,
    });
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get createdAt(): Date {
    return new Date(this.createdAtTimestamp);
  }

  get processedAt(): Date | undefined {
    return this.processedAtTimestamp === undefined
      ? undefined
      : new Date(this.processedAtTimestamp);
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertNotTerminal();

    if (!Number.isFinite(at.getTime())) {
      throw new InvalidWagerTransactionError('Invalid processing date');
    }

    const hasExternalReference =
      this.referenceExternalTransactionId !== undefined;

    if (
      (hasExternalReference && !referenceTransactionId?.trim()) ||
      (!hasExternalReference && referenceTransactionId !== undefined)
    ) {
      throw new InvalidWagerTransactionError(
        'Resolved reference must match the presence of an external reference',
      );
    }

    this._referenceTransactionId = referenceTransactionId;
    this.processedAtTimestamp = at.getTime();
    this._status = WagerTransactionStatus.Processed;
  }

  markPendingReference(): void {
    this.assertNotTerminal();

    if (this.referenceExternalTransactionId === undefined) {
      throw new InvalidTransactionStateError(
        'Transaction has no reference to wait for',
      );
    }

    this._status = WagerTransactionStatus.PendingReference;
  }

  reject(code: FailureCode): void {
    this.assertNotTerminal();

    this._failureCode = code;
    this._status = WagerTransactionStatus.Rejected;
  }

  fail(code: FailureCode): void {
    this.assertNotTerminal();

    this._failureCode = code;
    this._status = WagerTransactionStatus.Failed;
  }

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss && !this.money.isZero();
  }

  requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback
    );
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  private assertNotTerminal(): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `Cannot transition a terminal transaction: ${this._status}`,
      );
    }
  }
}
