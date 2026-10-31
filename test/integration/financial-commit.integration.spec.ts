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
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/entities/wager-transaction';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../src/domain/entities/wallet-ledger-entry';
import { OutboxMessage } from 'src/application/outbox/outbox-message';
import { WalletBalanceChanged } from 'src/application/events/wallet-balance-changed';
import { OpenWallet } from 'src/application/use-cases/open-wallet';
import {
  ProcessWagerRequest,
  ProcessWagerTransaction,
} from 'src/application/use-cases/process-wager-transaction';
import { ReferenceRetryWorker } from 'src/infrastructure/workers/reference-retry.worker';
import { Test } from '@nestjs/testing';
import { WalletsController } from '../../src/infrastructure/http/wallets.controller';
import { WageringController } from '../../src/infrastructure/http/wagering.controller';
import { ProviderAuthGuard } from '../../src/infrastructure/http/provider-auth.guard';
import { configureHttp } from '../../src/infrastructure/http/configure-http';
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

  const wageringFixture = async () => {
    const uow = new MikroOrmFinancialUnitOfWork(applicationOrm);
    const playerId = randomUUID();

    const wallet = await new OpenWallet(uow).execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const request = (
      overrides: Partial<ProcessWagerRequest> = {},
    ): ProcessWagerRequest => {
      const externalTransactionId = randomUUID();

      return {
        providerId: 'provider-a',
        externalTransactionId,
        idempotencyKey: `provider-a:${externalTransactionId}`,
        playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet,
        money: { amount: '25.00', currency: 'BRL' },
        ...overrides,
      };
    };

    return {
      processor: new ProcessWagerTransaction(uow),
      wallet,
      request,
    };
  };

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

  test('OpenWallet persists opening, ledger and events atomically', async () => {
    const useCase = new OpenWallet(
      new MikroOrmFinancialUnitOfWork(applicationOrm),
    );

    const playerId = randomUUID();
    const correlationId = randomUUID();

    const result = await useCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'GBP' },
      correlationId,
    });

    expect(result.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    expect(result).toEqual({
      id: result.id,
      playerId,
      balance: { amount: '100.00', currency: 'GBP' },
      version: 1,
    });

    const financialRecords = await client.query<{
      kind: string;
      status: string;
      amount: string;
      balance_before: string;
      balance_after: string;
    }>(
      `
      select
        t.kind,
        t.status,
        l.amount,
        l.balance_before,
        l.balance_after
      from wager_transactions t
      join wallet_ledger_entries l on l.transaction_id = t.id
      where t.wallet_id = $1
    `,
      [result.id],
    );

    expect(financialRecords.rows).toEqual([
      {
        kind: 'OPENING',
        status: 'PROCESSED',
        amount: '100.00',
        balance_before: '0.00',
        balance_after: '100.00',
      },
    ]);

    const events = await client.query<{
      event_type: string;
      correlation_id: string;
      published_at: Date | null;
    }>(
      `
      select
        event_type,
        payload->>'correlationId' as correlation_id,
        published_at
      from outbox_messages
      where aggregate_id = $1
      order by event_type
    `,
      [result.id],
    );

    expect(events.rows).toEqual([
      {
        event_type: 'WagerTransactionProcessed',
        correlation_id: correlationId,
        published_at: null,
      },
      {
        event_type: 'WalletBalanceChanged',
        correlation_id: correlationId,
        published_at: null,
      },
    ]);
  });

  test('OpenWallet creates a zero-balance wallet without financial entries', async () => {
    const useCase = new OpenWallet(
      new MikroOrmFinancialUnitOfWork(applicationOrm),
    );

    const result = await useCase.execute({
      playerId: randomUUID(),
      initialBalance: { amount: '0.00', currency: 'BRL' },
    });

    const counts = await client.query<{
      transactions: string;
      entries: string;
      events: string;
    }>(
      `
      select
        (
          select count(*)
          from wager_transactions
          where wallet_id = $1::uuid
        ) as transactions,
        (
          select count(*)
          from wallet_ledger_entries
          where wallet_id = $1::uuid
        ) as entries,
        (
          select count(*)
          from outbox_messages
          where aggregate_id = $1::uuid
        ) as events
    `,
      [result.id],
    );

    expect(result.version).toBe(1);
    expect(result.balance.amount).toBe('0.00');

    expect(counts.rows).toEqual([
      { transactions: '0', entries: '0', events: '0' },
    ]);
  });

  test('OpenWallet prevents concurrent duplicate wallets', async () => {
    const useCase = new OpenWallet(
      new MikroOrmFinancialUnitOfWork(applicationOrm),
    );

    const playerId = randomUUID();

    const request = {
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    };

    const results = await Promise.allSettled([
      useCase.execute(request),
      useCase.execute(request),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);

    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);

    const counts = await client.query<{
      wallets: string;
      openings: string;
      entries: string;
      events: string;
    }>(
      `
      select
        (
          select count(*) from wallets
          where player_id = $1
        ) as wallets,
        (
          select count(*) from wager_transactions
          where player_id = $1 and kind = 'OPENING'
        ) as openings,
        (
          select count(*)
          from wallet_ledger_entries l
          join wallets w on w.id = l.wallet_id
          where w.player_id = $1
        ) as entries,
        (
          select count(*)
          from outbox_messages o
          join wallets w on w.id = o.aggregate_id
          where w.player_id = $1
        ) as events
    `,
      [playerId],
    );

    expect(counts.rows).toEqual([
      {
        wallets: '1',
        openings: '1',
        entries: '1',
        events: '2',
      },
    ]);
  });

  test('processes fifty parallel copies with one debit', async () => {
    const { processor, wallet, request } = await wageringFixture();
    const input = request();

    const results = await Promise.all(
      Array.from({ length: 50 }, () => processor.execute(input)),
    );

    expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(
      1,
    );

    expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);

    const persisted = await client.query<{
      balance: string;
      debits: string;
    }>(
      `
      select
        w.balance,
        (
          select count(*)
          from wallet_ledger_entries
          where wallet_id = w.id and direction = 'DEBIT'
        ) as debits
      from wallets w
      where w.id = $1
    `,
      [wallet.id],
    );

    expect(persisted.rows).toEqual([{ balance: '75.00', debits: '1' }]);
  });

  test('two concurrent bets cannot overspend the wallet', async () => {
    const { processor, wallet, request } = await wageringFixture();

    const results = await Promise.all([
      processor.execute(
        request({ money: { amount: '80.00', currency: 'BRL' } }),
      ),
      processor.execute(
        request({ money: { amount: '80.00', currency: 'BRL' } }),
      ),
    ]);

    expect(
      results.filter(
        (result) => result.status === WagerTransactionStatus.Processed,
      ),
    ).toHaveLength(1);

    expect(
      results.filter(
        (result) =>
          result.status === WagerTransactionStatus.Rejected &&
          result.failureCode === FailureCode.InsufficientBalance,
      ),
    ).toHaveLength(1);

    const persisted = await client.query<{ balance: string }>(
      'select balance from wallets where id = $1',
      [wallet.id],
    );

    expect(persisted.rows).toEqual([{ balance: '20.00' }]);
  });

  test('replay returns the original balance after later movements', async () => {
    const { processor, request } = await wageringFixture();
    const bet = request();

    const original = await processor.execute(bet);

    await processor.execute(
      request({
        kind: WagerTransactionKind.Win,
        money: { amount: '10.00', currency: 'BRL' },
      }),
    );

    const replay = await processor.execute(bet);

    expect(original.balance?.amount).toBe('75.00');
    expect(replay.balance?.amount).toBe('75.00');
    expect(replay.transactionId).toBe(original.transactionId);
    expect(replay.idempotentReplay).toBe(true);

    const error = await captureFailure(() =>
      processor.execute({
        ...bet,
        money: { amount: '26.00', currency: 'BRL' },
      }),
    );

    expect(error).toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
  });

  test('processes BET WIN LOSS REFUND and ROLLBACK', async () => {
    const { processor, wallet, request } = await wageringFixture();

    const bet = request();
    expect((await processor.execute(bet)).balance?.amount).toBe('75.00');

    const win = request({
      kind: WagerTransactionKind.Win,
      money: { amount: '10.00', currency: 'BRL' },
      referenceExternalTransactionId: bet.externalTransactionId,
    });

    expect((await processor.execute(win)).balance?.amount).toBe('85.00');

    const loss = await processor.execute(
      request({
        kind: WagerTransactionKind.Loss,
        money: { amount: '0.00', currency: 'BRL' },
      }),
    );

    expect(loss.status).toBe(WagerTransactionStatus.Processed);
    expect(loss.balance?.amount).toBe('85.00');

    const refund = await processor.execute(
      request({
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );

    expect(refund.balance?.amount).toBe('110.00');

    const rollback = await processor.execute(
      request({
        kind: WagerTransactionKind.Rollback,
        money: { amount: '10.00', currency: 'BRL' },
        referenceExternalTransactionId: win.externalTransactionId,
      }),
    );

    expect(rollback.balance?.amount).toBe('100.00');

    const duplicateReversal = await processor.execute(
      request({
        kind: WagerTransactionKind.Rollback,
        money: { amount: '10.00', currency: 'BRL' },
        referenceExternalTransactionId: win.externalTransactionId,
      }),
    );

    expect(duplicateReversal.failureCode).toBe(
      FailureCode.ReferenceAlreadyReversed,
    );

    const persisted = await client.query<{
      balance: string;
      version: number;
    }>('select balance, version from wallets where id = $1', [wallet.id]);

    expect(persisted.rows).toEqual([{ balance: '100.00', version: 5 }]);
  });

  test('persists an out-of-order refund without changing balance', async () => {
    const { processor, wallet, request } = await wageringFixture();

    const result = await processor.execute(
      request({
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'not-arrived-yet',
      }),
    );

    expect(result.status).toBe(WagerTransactionStatus.PendingReference);
    expect(result.balance).toBeNull();

    const persisted = await client.query<{ balance: string }>(
      'select balance from wallets where id = $1',
      [wallet.id],
    );

    expect(persisted.rows).toEqual([{ balance: '100.00' }]);
  });

  test('reference worker resumes a refund after its BET arrives', async () => {
    const { processor, wallet, request } = await wageringFixture();

    const bet = request();

    const pending = await processor.execute(
      request({
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );

    expect(pending.status).toBe(WagerTransactionStatus.PendingReference);

    await processor.execute(bet);

    const worker = new ReferenceRetryWorker(applicationOrm, processor);

    await worker.runOnce();

    const stored = await client.query<{
      status: string;
      result_balance: string;
    }>(
      `
      select status, result_balance
      from wager_transactions
      where id = $1
    `,
      [pending.transactionId],
    );

    expect(stored.rows).toEqual([
      { status: 'PROCESSED', result_balance: '100.00' },
    ]);

    const balance = await client.query<{ balance: string }>(
      'select balance from wallets where id = $1',
      [wallet.id],
    );

    expect(balance.rows).toEqual([{ balance: '100.00' }]);

    // Uma segunda execução não pode repetir o crédito.
    await worker.runOnce();

    const entries = await client.query<{ count: string }>(
      `
      select count(*) as count
      from wallet_ledger_entries
      where transaction_id = $1
    `,
      [pending.transactionId],
    );

    expect(entries.rows[0]?.count).toBe('1');
  });

  test('reference worker persists backoff and rejects expired references', async () => {
    const { processor, request } = await wageringFixture();

    const pending = await processor.execute(
      request({
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: randomUUID(),
      }),
    );

    const worker = new ReferenceRetryWorker(applicationOrm, processor);

    const due = await client.query<{ due_at_ms: string }>(
      `
    select
      ceil(
        extract(epoch from next_reference_attempt_at) * 1000
      )::text as due_at_ms
    from wager_transactions
    where id = $1
  `,
      [pending.transactionId],
    );

    const dueAtMs = Number(due.rows[0]?.due_at_ms);

    if (!Number.isSafeInteger(dueAtMs)) {
      throw new Error('Missing or invalid reference retry timestamp');
    }

    // Executa depois do horário agendado, sem depender de espera.
    const now = new Date(dueAtMs + 1);

    await worker.runOnce(now);

    const scheduled = await client.query<{
      reference_attempts: number;
      next_reference_attempt_at: Date;
      reference_claim_token: string | null;
    }>(
      `
      select
        reference_attempts,
        next_reference_attempt_at,
        reference_claim_token
      from wager_transactions
      where id = $1
    `,
      [pending.transactionId],
    );

    expect(scheduled.rows[0]?.reference_attempts).toBe(1);
    expect(scheduled.rows[0]?.next_reference_attempt_at.getTime()).toBe(
      now.getTime() + 1_000,
    );
    expect(scheduled.rows[0]?.reference_claim_token).toBeNull();

    // Avança o relógio fornecido ao worker sem esperar quinze minutos.
    await worker.runOnce(new Date(now.getTime() + 16 * 60 * 1_000));

    const rejected = await client.query<{
      status: string;
      failure_code: string;
    }>(
      `
      select status, failure_code
      from wager_transactions
      where id = $1
    `,
      [pending.transactionId],
    );

    expect(rejected.rows).toEqual([
      {
        status: 'REJECTED',
        failure_code: 'REFERENCE_NOT_FOUND',
      },
    ]);

    const events = await client.query<{ count: string }>(
      `
      select count(*) as count
      from outbox_messages
      where
        event_type = 'WagerTransactionRejected'
        and payload->'data'->>'transactionId' = $1
    `,
      [pending.transactionId],
    );

    expect(events.rows[0]?.count).toBe('1');
  });

  test('HTTP validates payloads and preserves idempotent results', async () => {
    const uow = new MikroOrmFinancialUnitOfWork(applicationOrm);

    const testingModule = await Test.createTestingModule({
      controllers: [WalletsController, WageringController],
      providers: [
        ProviderAuthGuard,
        {
          provide: OpenWallet,
          useValue: new OpenWallet(uow),
        },
        {
          provide: ProcessWagerTransaction,
          useValue: new ProcessWagerTransaction(uow),
        },
      ],
    }).compile();

    const app = testingModule.createNestApplication();
    configureHttp(app);

    await app.listen(0, '127.0.0.1');

    try {
      const baseUrl = await app.getUrl();
      const playerId = randomUUID();

      const createdResponse = await fetch(`${baseUrl}/wallets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerId,
          initialBalance: {
            amount: '100.00',
            currency: 'BRL',
          },
        }),
      });

      expect(createdResponse.status).toBe(201);

      const created: unknown = await createdResponse.json();

      if (
        typeof created !== 'object' ||
        created === null ||
        !('id' in created) ||
        typeof created.id !== 'string'
      ) {
        throw new Error('Invalid wallet response');
      }

      const externalTransactionId = randomUUID();

      const payload = {
        providerId: 'provider-a',
        externalTransactionId,
        playerId,
        walletId: created.id,
        roundId: 'http-round-1',
        gameId: 'game-1',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      };

      const headers = {
        'Content-Type': 'application/json',
        'Idempotency-Key': `provider-a:${externalTransactionId}`,
      };

      const submit = (body: object) =>
        fetch(`${baseUrl}/wagering/transactions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });

      const first = await submit(payload);
      expect(first.status).toBe(200);

      const firstBody: unknown = await first.json();
      expect(firstBody).toMatchObject({
        status: 'PROCESSED',
        balance: { amount: '75.00', currency: 'BRL' },
        idempotentReplay: false,
      });

      const replay = await submit(payload);
      expect(replay.status).toBe(200);

      const replayBody: unknown = await replay.json();
      expect(replayBody).toMatchObject({
        balance: { amount: '75.00', currency: 'BRL' },
        idempotentReplay: true,
      });

      const conflict = await submit({
        ...payload,
        money: { amount: '26.00', currency: 'BRL' },
      });

      expect(conflict.status).toBe(409);

      const invalid = await submit({
        ...payload,
        money: { amount: 25, currency: 'BRL' },
      });

      expect(invalid.status).toBe(400);
    } finally {
      await app.close();
    }
  }, 30_000);
});
