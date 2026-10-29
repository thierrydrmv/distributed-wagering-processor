import { EntitySchema, ReferenceKind } from '@mikro-orm/core';
import {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../domain/entities/wager-transaction';
import { WalletRecord } from './wallet.record';

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: WagerTransactionKind;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId!: string | null;
  referenceTransactionId!: string | null;
  status!: WagerTransactionStatus;
  failureCode!: FailureCode | null;
  resultBalance!: string | null;
  createdAt!: Date;
  processedAt!: Date | null;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: 'wager_transactions',

  properties: {
    id: {
      type: 'uuid',
      primary: true,
    },
    providerId: {
      type: 'string',
      fieldName: 'provider_id',
    },
    externalTransactionId: {
      type: 'string',
      fieldName: 'external_transaction_id',
    },
    idempotencyKey: {
      type: 'string',
      fieldName: 'idempotency_key',
    },
    payloadHash: {
      type: 'string',
      length: 64,
      fieldName: 'payload_hash',
    },
    walletId: {
      kind: ReferenceKind.MANY_TO_ONE,
      entity: () => WalletRecord,
      mapToPk: true,
      fieldName: 'wallet_id',
      deleteRule: 'restrict',
      updateRule: 'restrict',
    },
    playerId: {
      type: 'uuid',
      fieldName: 'player_id',
    },
    roundId: {
      type: 'string',
      fieldName: 'round_id',
    },
    gameId: {
      type: 'string',
      fieldName: 'game_id',
    },
    kind: {
      enum: true,
      items: () => WagerTransactionKind,
    },
    amount: {
      type: 'decimal',
      precision: 20,
      scale: 2,
      runtimeType: 'string',
    },
    currency: {
      type: 'string',
      length: 3,
    },
    referenceExternalTransactionId: {
      type: 'string',
      fieldName: 'reference_external_transaction_id',
      nullable: true,
    },
    referenceTransactionId: {
      kind: ReferenceKind.MANY_TO_ONE,
      entity: () => WagerTransactionRecord,
      mapToPk: true,
      fieldName: 'reference_transaction_id',
      nullable: true,
      deleteRule: 'restrict',
      updateRule: 'restrict',
    },
    status: {
      enum: true,
      items: () => WagerTransactionStatus,
    },
    failureCode: {
      enum: true,
      items: () => FailureCode,
      fieldName: 'failure_code',
      nullable: true,
    },
    resultBalance: {
      type: 'decimal',
      precision: 20,
      scale: 2,
      runtimeType: 'string',
      fieldName: 'result_balance',
      nullable: true,
    },
    createdAt: {
      type: 'Date',
      columnType: 'timestamptz',
      fieldName: 'created_at',
    },
    processedAt: {
      type: 'Date',
      columnType: 'timestamptz',
      fieldName: 'processed_at',
      nullable: true,
    },
  },

  uniques: [
    {
      name: 'wager_transactions_idempotency_key_unique',
      properties: ['idempotencyKey'],
    },
    {
      name: 'wager_transactions_provider_external_unique',
      properties: ['providerId', 'externalTransactionId'],
    },
  ],

  indexes: [
    {
      name: 'wager_transactions_wallet_created_idx',
      properties: ['walletId', 'createdAt', 'id'],
    },
    {
      name: 'wager_transactions_status_created_idx',
      properties: ['status', 'createdAt', 'id'],
    },
    {
      name: 'wager_transactions_reference_idx',
      properties: ['referenceTransactionId'],
    },
  ],

  checks: [
    {
      name: 'wager_transactions_amount_valid',
      expression: `
          (kind = 'LOSS' AND amount = 0)
          OR (kind = 'WIN' AND amount >= 0)
          OR (
            kind IN ('OPENING', 'BET', 'REFUND', 'ROLLBACK')
            AND amount > 0
          )
        `,
    },
    {
      name: 'wager_transactions_currency_supported',
      expression: "currency ~ '^(BRL|USD|EUR|GBP)$'",
    },
    {
      name: 'wager_transactions_result_balance_non_negative',
      expression: 'result_balance IS NULL OR result_balance >= 0',
    },
    {
      name: 'wager_transactions_required_reference',
      expression: `
          kind NOT IN ('REFUND', 'ROLLBACK')
          OR (
            reference_external_transaction_id IS NOT NULL
            AND length(trim(reference_external_transaction_id)) > 0
          )
        `,
    },
    {
      name: 'wager_transactions_processing_result',
      expression: `
          (
            status = 'PROCESSED'
            AND processed_at IS NOT NULL
            AND result_balance IS NOT NULL
            AND failure_code IS NULL
          )
          OR (
            status IN ('REJECTED', 'FAILED')
            AND processed_at IS NULL
            AND failure_code IS NOT NULL
          )
          OR (
            status IN ('PENDING', 'PENDING_REFERENCE')
            AND processed_at IS NULL
            AND result_balance IS NULL
            AND failure_code IS NULL
          )
        `,
    },
  ],
});
