import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { Client } from 'pg';
import ormConfig from '../../src/infrastructure/database/mikro-orm.config';
import { Wallet } from '../../src/domain/entities/wallet';
import { Money } from '../../src/domain/value-objects/money';
import { MikroOrmFinancialUnitOfWork } from '../../src/infrastructure/database/mikro-orm-financial-unit-of-work';
import {
  WagerTransaction,
  WagerTransactionKind,
} from '../../src/domain/entities/wager-transaction';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../src/domain/entities/wallet-ledger-entry';
import { OutboxMessage } from 'src/application/outbox/outbox-message';
import { WalletBalanceChanged } from 'src/application/events/wallet-balance-changed';
async function captureFailure(action: () => Promise<unknown>): Promise<Error> {
  try {
    await action();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }

    throw new Error('Operation rejected with a non-Error value', {
      cause: error,
    });
  }

  throw new Error('Expected operation to fail, but it succeeded');
}

describe('Financial consistency at real commit', () => {
  const databaseName = `wagering_commit_${randomUUID().replaceAll('-', '')}_test`;

  let admin: Client;
  let client: Client;
  let adminConnected = false;
  let clientConnected = false;
  let databaseCreated = false;
  let applicationOrm: MikroORM;

  beforeAll(async () => {
    const connectionString = process.env.TEST_DATABASE_URL;

    if (!connectionString) {
      throw new Error('TEST_DATABASE_URL is required');
    }

    const testUrl = new URL(connectionString);

    if (testUrl.pathname !== '/wagering_test') {
      throw new Error('TEST_DATABASE_URL must point to wagering_test');
    }

    admin = new Client({ connectionString });
    await admin.connect();
    adminConnected = true;

    // Nome gerado internamente, sem entrada externa.
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    databaseCreated = true;

    testUrl.pathname = `/${databaseName}`;
    const temporaryUrl = testUrl.toString();

    const orm = await MikroORM.init({
      ...ormConfig,
      clientUrl: temporaryUrl,
      dbName: databaseName,
    });

    try {
      await orm.getMigrator().up();
    } finally {
      await orm.close(true);
    }

    client = new Client({ connectionString: temporaryUrl });
    await client.connect();
    clientConnected = true;

    applicationOrm = await MikroORM.init({
      ...ormConfig,
      clientUrl: temporaryUrl,
      dbName: databaseName,
    });
  }, 30_000);

  afterAll(async () => {
    try {
      if (clientConnected) {
        await client.end();
      }

      if (applicationOrm) {
        await applicationOrm.close(true);
      }

      if (databaseCreated && adminConnected) {
        await admin.query(`DROP DATABASE "${databaseName}"`);
      }
    } finally {
      if (adminConnected) {
        await admin.end();
      }
    }
  }, 30_000);

  test.each([
    {
      name: 'commits a valid opening',
      walletBalance: '100.00',
      version: 1,
      includeLedger: true,
      expectedConstraint: null,
    },
    {
      name: 'rolls back an opening without its ledger',
      walletBalance: '0.00',
      version: 1,
      includeLedger: false,
      expectedConstraint: 'wager_ledger_required',
    },
    {
      name: 'rolls back a ledger credit without its wallet balance',
      walletBalance: '0.00',
      version: 1,
      includeLedger: true,
      expectedConstraint: 'wallet_balance_matches_ledger',
    },
    {
      name: 'rolls back an opening with an incorrect wallet version',
      walletBalance: '100.00',
      version: 2,
      includeLedger: true,
      expectedConstraint: 'wallet_version_matches_ledger',
    },
  ])(
    '$name',
    async ({ walletBalance, version, includeLedger, expectedConstraint }) => {
      const walletId = randomUUID();
      const playerId = randomUUID();
      const transactionId = randomUUID();
      const entryId = randomUUID();

      let transactionOpen = false;
      let commitError: unknown;

      await client.query('BEGIN');
      transactionOpen = true;

      try {
        await client.query(
          `
            insert into wallets (
              id, player_id, currency, balance,
              version, created_at, updated_at
            )
            values ($1, $2, 'BRL', $3, $4, now(), now())
          `,
          [walletId, playerId, walletBalance, version],
        );

        await client.query(
          `
            insert into wager_transactions (
              id, provider_id, external_transaction_id,
              idempotency_key, payload_hash,
              wallet_id, player_id, round_id, game_id,
              kind, amount, currency, status,
              result_balance, created_at, processed_at
            )
            values (
              $1::uuid, 'internal', $2::text,
              $3::text, $4::text,
              $5::uuid, $6::uuid, 'opening', 'internal',
              'OPENING', '100.00', 'BRL', 'PROCESSED',
              '100.00', now(), now()
            )
          `,
          [
            transactionId,
            `opening:${transactionId}`,
            `internal:opening:${transactionId}`,
            'a'.repeat(64),
            walletId,
            playerId,
          ],
        );

        if (includeLedger) {
          await client.query(
            `
              insert into wallet_ledger_entries (
                id, wallet_id, transaction_id, direction,
                amount, currency, balance_before,
                balance_after, created_at
              )
              values (
                $1, $2, $3, 'CREDIT',
                '100.00', 'BRL', '0.00', '100.00', now()
              )
            `,
            [entryId, walletId, transactionId],
          );
        }

        // O erro esperado precisa ocorrer aqui, no COMMIT.
        try {
          await client.query('COMMIT');
          transactionOpen = false;
        } catch (error) {
          commitError = error;

          // Normaliza o estado da conexão após a falha.
          await client.query('ROLLBACK');
          transactionOpen = false;
        }

        if (expectedConstraint === null) {
          expect(commitError).toBeUndefined();
        } else {
          expect(commitError).toMatchObject({
            code: '23514',
            constraint: expectedConstraint,
          });
        }

        const persisted = await client.query<{
          wallets: string;
          transactions: string;
          entries: string;
        }>(
          `
            select
              (
                select count(*)
                from wallets
                where id = $1::uuid
              ) as wallets,
              (
                select count(*)
                from wager_transactions
                where id = $2::uuid
              ) as transactions,
              (
                select count(*)
                from wallet_ledger_entries
                where id = $3::uuid
              ) as entries
          `,
          [walletId, transactionId, entryId],
        );

        const expectedCount = expectedConstraint === null ? '1' : '0';

        expect(persisted.rows).toEqual([
          {
            wallets: expectedCount,
            transactions: expectedCount,
            entries: expectedCount,
          },
        ]);
      } finally {
        if (transactionOpen) {
          await client.query('ROLLBACK');
        }
      }
    },
  );
  test('unit of work commits a zero-balance wallet', async () => {
    const uow = new MikroOrmFinancialUnitOfWork(applicationOrm);
    const walletId = randomUUID();

    const wallet = Wallet.open({
      id: walletId,
      playerId: randomUUID(),
      initialBalance: Money.zero('BRL'),
      at: new Date(),
    });

    const result = await uow.execute(async ({ wallets }) => {
      await wallets.insert(wallet);

      return wallet.id;
    });

    expect(result).toBe(walletId);

    const persisted = await client.query<{
      balance: string;
      version: number;
    }>('select balance, version from wallets where id = $1', [walletId]);

    expect(persisted.rows).toEqual([{ balance: '0.00', version: 1 }]);
  });

  test('unit of work rolls back when its callback fails', async () => {
    const uow = new MikroOrmFinancialUnitOfWork(applicationOrm);
    const walletId = randomUUID();

    const wallet = Wallet.open({
      id: walletId,
      playerId: randomUUID(),
      initialBalance: Money.zero('BRL'),
      at: new Date(),
    });

    const error = await captureFailure(() =>
      uow.execute(async ({ wallets }) => {
        await wallets.insert(wallet);

        throw new Error('Forced callback failure');
      }),
    );

    expect(error.message).toContain('Forced callback failure');

    const persisted = await client.query<{ count: string }>(
      'select count(*) as count from wallets where id = $1',
      [walletId],
    );

    expect(persisted.rows[0]?.count).toBe('0');
  });

  test('unit of work propagates deferred commit failures', async () => {
    const uow = new MikroOrmFinancialUnitOfWork(applicationOrm);
    const walletId = randomUUID();

    const wallet = Wallet.open({
      id: walletId,
      playerId: randomUUID(),
      initialBalance: Money.from({
        amount: '100.00',
        currency: 'BRL',
      }),
      at: new Date(),
    });

    const error = await captureFailure(() =>
      uow.execute(async ({ wallets }) => {
        await wallets.insert(wallet);

        return wallet.id;
      }),
    );

    expect(error.message).toContain('Wallet balance differs from its ledger');

    const persisted = await client.query<{ count: string }>(
      'select count(*) as count from wallets where id = $1',
      [walletId],
    );

    expect(persisted.rows[0]?.count).toBe('0');
  });
  test('unit of work commits wallet, transaction and ledger together', async () => {
    const uow = new MikroOrmFinancialUnitOfWork(applicationOrm);

    const walletId = randomUUID();
    const transactionId = randomUUID();
    const entryId = randomUUID();
    const playerId = randomUUID();
    const at = new Date();

    const initialBalance = Money.from({
      amount: '100.00',
      currency: 'BRL',
    });

    const wallet = Wallet.open({
      id: walletId,
      playerId,
      initialBalance,
      at,
    });

    const transaction = WagerTransaction.create({
      id: transactionId,
      providerId: 'internal',
      externalTransactionId: `opening:${walletId}`,
      idempotencyKey: `internal:opening:${walletId}`,
      payloadHash: 'a'.repeat(64),
      walletId,
      playerId,
      roundId: `opening:${walletId}`,
      gameId: 'internal',
      kind: WagerTransactionKind.Opening,
      money: initialBalance,
      createdAt: at,
    });

    transaction.markProcessed(undefined, at);

    const entry = WalletLedgerEntry.create({
      id: entryId,
      walletId,
      transactionId,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero('BRL'),
      balanceAfter: initialBalance,
      createdAt: at,
    });

    const eventId = randomUUID();

    const event = WalletBalanceChanged.from(wallet, entry, {
      eventId,
      correlationId: randomUUID(),
      causationId: transactionId,
      occurredAt: at,
    });

    await uow.execute(async ({ wallets, transactions, ledger, outbox }) => {
      await wallets.insert(wallet);
      await transactions.insert(transaction, initialBalance);
      await ledger.insert(entry);
      await outbox.insert(OutboxMessage.enqueue(event));
    });

    const storedEvent = await client.query<{
      event_type: string;
      payload: unknown;
      attempts: number;
      published_at: Date | null;
    }>(
      `
    select event_type, payload, attempts, published_at
    from outbox_messages
    where id = $1
  `,
      [eventId],
    );

    expect(storedEvent.rows).toEqual([
      {
        event_type: 'WalletBalanceChanged',
        payload: event.toJSON(),
        attempts: 0,
        published_at: null,
      },
    ]);

    const persisted = await client.query<{
      balance: string;
      version: number;
      status: string;
      result_balance: string;
      amount: string;
    }>(
      `
      select
        w.balance,
        w.version,
        t.status,
        t.result_balance,
        l.amount
      from wallets w
      join wager_transactions t on t.wallet_id = w.id
      join wallet_ledger_entries l on l.transaction_id = t.id
      where
        w.id = $1
        and t.id = $2
        and l.id = $3
    `,
      [walletId, transactionId, entryId],
    );

    expect(persisted.rows).toEqual([
      {
        balance: '100.00',
        version: 1,
        status: 'PROCESSED',
        result_balance: '100.00',
        amount: '100.00',
      },
    ]);

    const restored = await uow.execute(async ({ wallets, transactions }) => {
      const loadedWallet = await wallets.findByIdForUpdate(walletId);

      const loadedTransaction = await transactions.findByIdempotencyKey(
        transaction.idempotencyKey,
      );

      return {
        balance: loadedWallet?.balance.toJSON().amount,
        resultBalance: loadedTransaction?.resultBalance?.toJSON().amount,
        transactionId: loadedTransaction?.transaction.id,
      };
    });

    expect(restored).toEqual({
      balance: '100.00',
      resultBalance: '100.00',
      transactionId,
    });
  });
});
