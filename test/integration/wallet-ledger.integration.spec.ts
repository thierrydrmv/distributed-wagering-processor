import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { Client } from 'pg';
import ormConfig from '../../src/infrastructure/database/mikro-orm.config';

interface LedgerInput {
  id: string;
  direction: string;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
}

interface PostgresFailure {
  code: string;
  constraint: string;
}

describe('Wallet ledger PostgreSQL constraints', () => {
  let client: Client;
  let connected = false;
  let walletId: string;
  let transactionId: string;

  beforeAll(async () => {
    const connectionString = process.env.TEST_DATABASE_URL;

    if (!connectionString) {
      throw new Error('TEST_DATABASE_URL is required');
    }

    const databaseName = new URL(connectionString).pathname;

    if (databaseName !== '/wagering_test') {
      throw new Error('Integration tests must use the wagering_test database');
    }

    const orm = await MikroORM.init({
      ...ormConfig,
      clientUrl: connectionString,
    });

    try {
      await orm.getMigrator().up();
    } finally {
      await orm.close(true);
    }

    client = new Client({ connectionString });
    await client.connect();
    connected = true;
  }, 30_000);

  beforeEach(async () => {
    walletId = randomUUID();
    transactionId = randomUUID();

    await client.query('BEGIN');

    await client.query(
      `
        insert into wallets (
          id, player_id, currency, balance,
          version, created_at, updated_at
        )
        values ($1, $2, 'BRL', '100.00', 1, now(), now())
      `,
      [walletId, randomUUID()],
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
    select
      $1::uuid, 'internal', $2::text, $3::text, $4::text,
      id, player_id, 'opening', 'internal',
      'OPENING', '100.00', currency, 'PROCESSED',
      '100.00', now(), now()
    from wallets
    where id = $5::uuid
  `,
      [
        transactionId,
        `opening:${transactionId}`,
        `internal:opening:${transactionId}`,
        'a'.repeat(64),
        walletId,
      ],
    );
  });

  afterEach(async () => {
    if (connected) {
      await client.query('ROLLBACK');
    }
  });

  afterAll(async () => {
    if (connected) {
      await client.end();
    }
  });

  const insertEntry = (overrides: Partial<LedgerInput> = {}) => {
    const input: LedgerInput = {
      id: randomUUID(),
      direction: 'CREDIT',
      amount: '100.00',
      currency: 'BRL',
      balanceBefore: '0.00',
      balanceAfter: '100.00',
      ...overrides,
    };

    return client.query(
      `
        insert into wallet_ledger_entries (
          id, wallet_id, transaction_id, direction,
          amount, currency, balance_before,
          balance_after, created_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, now())
        returning id
      `,
      [
        input.id,
        walletId,
        transactionId,
        input.direction,
        input.amount,
        input.currency,
        input.balanceBefore,
        input.balanceAfter,
      ],
    );
  };

  const expectDatabaseFailure = async (
    action: () => Promise<unknown>,
    expected: PostgresFailure,
  ): Promise<void> => {
    await client.query('SAVEPOINT expected_failure');

    let captured: unknown;

    try {
      await action();
    } catch (error) {
      captured = error;
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT expected_failure');
      await client.query('RELEASE SAVEPOINT expected_failure');
    }

    expect(captured).toMatchObject(expected);
  };

  test('persists a valid opening credit with exact amounts', async () => {
    const entryId = randomUUID();

    await insertEntry({ id: entryId });

    const result = await client.query<{
      amount: string;
      balance_before: string;
      balance_after: string;
    }>(
      `
        select amount, balance_before, balance_after
        from wallet_ledger_entries
        where id = $1
      `,
      [entryId],
    );

    expect(result.rows).toEqual([
      {
        amount: '100.00',
        balance_before: '0.00',
        balance_after: '100.00',
      },
    ]);
  });

  test('rejects inconsistent arithmetic', async () => {
    await expectDatabaseFailure(() => insertEntry({ balanceAfter: '99.00' }), {
      code: '23514',
      constraint: 'ledger_arithmetic_valid',
    });
  });

  test('rejects a zero amount', async () => {
    await expectDatabaseFailure(
      () =>
        insertEntry({
          amount: '0.00',
          balanceAfter: '0.00',
        }),
      {
        code: '23514',
        constraint: 'ledger_amount_valid',
      },
    );
  });

  test('rejects a negative resulting balance', async () => {
    await expectDatabaseFailure(
      () =>
        insertEntry({
          direction: 'DEBIT',
          balanceBefore: '0.00',
          balanceAfter: '-100.00',
        }),
      {
        code: '23514',
        constraint: 'ledger_balances_valid',
      },
    );
  });

  test('rejects an unsupported currency', async () => {
    await expectDatabaseFailure(() => insertEntry({ currency: 'XYZ' }), {
      code: '23514',
      constraint: 'ledger_currency_supported',
    });
  });

  test('rejects a second entry for the same wallet and transaction', async () => {
    await insertEntry();

    await expectDatabaseFailure(() => insertEntry(), {
      code: '23505',
      constraint: 'ledger_wallet_transaction_unique',
    });

    const result = await client.query<{ count: string }>(
      `
        select count(*) as count
        from wallet_ledger_entries
        where wallet_id = $1
      `,
      [walletId],
    );

    expect(result.rows[0]?.count).toBe('1');
  });

  test.each(['UPDATE', 'DELETE', 'TRUNCATE'])(
    'blocks %s and preserves the existing entry',
    async (operation) => {
      const entryId = randomUUID();
      await insertEntry({ id: entryId });

      const statements: Record<string, string> = {
        UPDATE: `
          update wallet_ledger_entries
          set amount = amount
          where id = $1
        `,
        DELETE: `
          delete from wallet_ledger_entries
          where id = $1
        `,
        TRUNCATE: 'truncate table wallet_ledger_entries',
      };

      await expectDatabaseFailure(
        () =>
          client.query(
            statements[operation],
            operation === 'TRUNCATE' ? [] : [entryId],
          ),
        {
          code: '23514',
          constraint: 'ledger_immutable',
        },
      );

      const result = await client.query<{ amount: string }>(
        `
          select amount
          from wallet_ledger_entries
          where id = $1
        `,
        [entryId],
      );

      expect(result.rows).toEqual([{ amount: '100.00' }]);
    },
  );
});
