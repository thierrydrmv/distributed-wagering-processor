import { Logger } from '@nestjs/common';
import type { FilterQuery } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { isISO8601, isUUID } from 'class-validator';
import { WageringError } from '../../../application/errors/wagering-error';
import type { LedgerDirection } from '../../../domain/entities/wallet-ledger-entry';
import { WalletRecord } from '../entities/wallet.record';
import { WagerTransactionRecord } from '../entities/wager-transaction.record';
import { FinancialMetrics } from '../../observability/financial-metrics';

interface LedgerCursor {
  version: 1;
  walletId: string;
  createdAt: string;
  id: string;
}

interface LedgerRow {
  id: string;
  transactionId: string;
  direction: LedgerDirection;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  createdAt: string;
}

interface ReconciliationRow {
  walletId: string;
  currency: string;
  storedBalance: string;
  calculatedBalance: string;
  difference: string;
  consistent: boolean;
  checkedEntries: string;
}

export class WageringQueries {
  private readonly logger = new Logger(WageringQueries.name);

  constructor(
    private readonly orm: MikroORM,
    private readonly metrics: FinancialMetrics,
  ) {}

  async getWallet(walletId: string) {
    const wallet = await this.orm.em
      .fork()
      .findOne(WalletRecord, { id: walletId });

    if (wallet === null) {
      throw new WageringError('WALLET_NOT_FOUND', 'Wallet does not exist');
    }

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: {
        amount: wallet.balance,
        currency: wallet.currency,
      },
      version: wallet.version,
      createdAt: wallet.createdAt.toISOString(),
      updatedAt: wallet.updatedAt.toISOString(),
    };
  }

  async getTransactionById(transactionId: string) {
    return this.getTransaction({ id: transactionId });
  }

  async getTransactionByExternalId(
    providerId: string,
    externalTransactionId: string,
  ) {
    if (providerId.length > 255 || externalTransactionId.length > 255) {
      throw new WageringError(
        'INVALID_IDENTIFIER',
        'Transaction identifier is too long',
      );
    }

    return this.getTransaction({
      providerId,
      externalTransactionId,
    });
  }

  async getLedger(walletId: string, limit = 50, cursor?: string) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new WageringError(
        'INVALID_LIMIT',
        'Ledger limit must be between 1 and 100',
      );
    }

    const wallet = await this.getWallet(walletId);

    const after =
      cursor === undefined ? undefined : this.decodeCursor(cursor, wallet.id);

    const params: (string | number)[] = [wallet.id];

    if (after !== undefined) {
      params.push(after.createdAt, after.id);
    }

    params.push(limit + 1);

    const rows = await this.orm.em
      .fork()
      .getConnection()
      .execute<LedgerRow[]>(
        `
          select
            id,
            transaction_id as "transactionId",
            direction,
            amount::text as amount,
            currency,
            balance_before::text as "balanceBefore",
            balance_after::text as "balanceAfter",
            to_char(
              created_at at time zone 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) as "createdAt"
          from wallet_ledger_entries
          where wallet_id = ?::uuid
          ${
            after === undefined
              ? ''
              : 'and (created_at, id) > (?::timestamptz, ?::uuid)'
          }
          order by created_at, id
          limit ?
        `,
        params,
      );

    const page = rows.slice(0, limit);
    const last = page.at(-1);

    const nextCursor =
      rows.length > limit && last !== undefined
        ? this.encodeCursor({
            version: 1,
            walletId: wallet.id,
            createdAt: last.createdAt,
            id: last.id,
          })
        : null;

    return {
      items: page.map((entry) => ({
        id: entry.id,
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: {
          amount: entry.amount,
          currency: entry.currency,
        },
        balanceBefore: {
          amount: entry.balanceBefore,
          currency: entry.currency,
        },
        balanceAfter: {
          amount: entry.balanceAfter,
          currency: entry.currency,
        },
        createdAt: entry.createdAt,
      })),
      nextCursor,
    };
  }

  async reconcile(walletId: string, correlationId?: string) {
    const rows = await this.orm.em
      .fork()
      .getConnection()
      .execute<ReconciliationRow[]>(
        `
          select
            w.id as "walletId",
            w.currency,
            w.balance::text as "storedBalance",
            round(totals.balance, 2)::text
              as "calculatedBalance",
            round(w.balance - totals.balance, 2)::text
              as difference,
            w.balance = totals.balance as consistent,
            totals.entries::text as "checkedEntries"
          from wallets w
          cross join lateral (
            select
              coalesce(
                sum(
                  case
                    when direction = 'CREDIT' then amount
                    else -amount
                  end
                ),
                0
              ) as balance,
              count(*) as entries
            from wallet_ledger_entries
            where wallet_id = w.id
          ) totals
          where w.id = ?::uuid
        `,
        [walletId],
      );

    const result = rows[0];

    if (result === undefined) {
      throw new WageringError('WALLET_NOT_FOUND', 'Wallet does not exist');
    }

    const checkedEntries = Number(result.checkedEntries);

    if (!Number.isSafeInteger(checkedEntries)) {
      throw new Error('Ledger entry count exceeds supported range');
    }

    if (!result.consistent) {
      this.metrics.reconciliationDivergences.inc();

      this.logger.error(
        JSON.stringify({
          event: 'wallet_reconciliation_mismatch',
          walletId,
          correlationId,
        }),
      );
    }

    return {
      walletId: result.walletId,
      storedBalance: {
        amount: result.storedBalance,
        currency: result.currency,
      },
      calculatedBalance: {
        amount: result.calculatedBalance,
        currency: result.currency,
      },
      difference: {
        amount: result.difference,
        currency: result.currency,
      },
      consistent: result.consistent,
      checkedEntries,
    };
  }

  private async getTransaction(where: FilterQuery<WagerTransactionRecord>) {
    const record = await this.orm.em
      .fork()
      .findOne(WagerTransactionRecord, where);

    if (record === null) {
      throw new WageringError(
        'TRANSACTION_NOT_FOUND',
        'Transaction does not exist',
      );
    }

    return {
      transactionId: record.id,
      providerId: record.providerId,
      externalTransactionId: record.externalTransactionId,
      walletId: record.walletId,
      playerId: record.playerId,
      roundId: record.roundId,
      gameId: record.gameId,
      kind: record.kind,
      money: {
        amount: record.amount,
        currency: record.currency,
      },
      status: record.status,
      balance:
        record.resultBalance === null
          ? null
          : {
              amount: record.resultBalance,
              currency: record.currency,
            },
      failureCode: record.failureCode,
      referenceExternalTransactionId: record.referenceExternalTransactionId,
      referenceTransactionId: record.referenceTransactionId,
      createdAt: record.createdAt.toISOString(),
      processedAt: record.processedAt?.toISOString() ?? null,
    };
  }

  private encodeCursor(cursor: LedgerCursor): string {
    return Buffer.from(JSON.stringify(cursor)).toString('base64url');
  }

  private decodeCursor(cursor: string, walletId: string): LedgerCursor {
    try {
      if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
        throw new Error('Invalid encoding');
      }

      const value: unknown = JSON.parse(
        Buffer.from(cursor, 'base64url').toString('utf8'),
      );

      if (
        typeof value !== 'object' ||
        value === null ||
        !('version' in value) ||
        value.version !== 1 ||
        !('walletId' in value) ||
        value.walletId !== walletId ||
        !('id' in value) ||
        typeof value.id !== 'string' ||
        !isUUID(value.id) ||
        !('createdAt' in value) ||
        typeof value.createdAt !== 'string' ||
        !isISO8601(value.createdAt, {
          strict: true,
          strictSeparator: true,
        })
      ) {
        throw new Error('Invalid cursor content');
      }

      return {
        version: 1,
        walletId,
        id: value.id,
        createdAt: value.createdAt,
      };
    } catch {
      throw new WageringError('INVALID_CURSOR', 'Invalid ledger cursor');
    }
  }
}
