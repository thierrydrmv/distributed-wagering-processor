import { EntitySchema, ReferenceKind } from '@mikro-orm/core';
import { LedgerDirection } from '../../../domain/entities/wallet-ledger-entry';
import { WalletRecord } from './wallet.record';
import { WagerTransactionRecord } from './wager-transaction.record';

export class WalletLedgerEntryRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: LedgerDirection;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export const WalletLedgerEntrySchema =
  new EntitySchema<WalletLedgerEntryRecord>({
    class: WalletLedgerEntryRecord,
    tableName: 'wallet_ledger_entries',

    properties: {
      id: {
        type: 'uuid',
        primary: true,
      },
      walletId: {
        kind: ReferenceKind.MANY_TO_ONE,
        entity: () => WalletRecord,
        mapToPk: true,
        fieldName: 'wallet_id',
        deleteRule: 'restrict',
        updateRule: 'restrict',
      },
      transactionId: {
        kind: ReferenceKind.MANY_TO_ONE,
        entity: () => WagerTransactionRecord,
        mapToPk: true,
        fieldName: 'transaction_id',
        deleteRule: 'restrict',
        updateRule: 'restrict',
      },
      direction: {
        enum: true,
        items: () => LedgerDirection,
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
      balanceBefore: {
        type: 'decimal',
        precision: 20,
        scale: 2,
        runtimeType: 'string',
        fieldName: 'balance_before',
      },
      balanceAfter: {
        type: 'decimal',
        precision: 20,
        scale: 2,
        runtimeType: 'string',
        fieldName: 'balance_after',
      },
      createdAt: {
        type: 'Date',
        columnType: 'timestamptz',
        fieldName: 'created_at',
      },
    },

    uniques: [
      {
        name: 'ledger_wallet_transaction_unique',
        properties: ['walletId', 'transactionId'],
      },
    ],

    indexes: [
      {
        name: 'ledger_wallet_created_id_idx',
        properties: ['walletId', 'createdAt', 'id'],
      },
      {
        name: 'ledger_transaction_idx',
        properties: ['transactionId'],
      },
    ],

    checks: [
      {
        name: 'ledger_currency_supported',
        expression: "currency ~ '^(BRL|USD|EUR|GBP)$'",
      },
      {
        name: 'ledger_amount_valid',
        expression: 'amount > 0 AND amount <= 999999999999999999.99',
      },
      {
        name: 'ledger_balances_valid',
        expression: `
          balance_before >= 0
          AND balance_before <= 999999999999999999.99
          AND balance_after >= 0
          AND balance_after <= 999999999999999999.99
        `,
      },
      {
        name: 'ledger_arithmetic_valid',
        expression: `
          (direction = 'CREDIT' AND balance_after = balance_before + amount)
          OR
          (direction = 'DEBIT' AND balance_after = balance_before - amount)
        `,
      },
    ],
  });
