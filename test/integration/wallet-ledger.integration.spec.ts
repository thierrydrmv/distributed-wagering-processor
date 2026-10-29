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

  test('blocks updates to a processed transaction', async () => {
    await insertEntry();

    await expectDatabaseFailure(
      () =>
        client.query(
          `
          update wager_transactions
          set result_balance = '50.00'
          where id = $1
        `,
          [transactionId],
        ),
      {
        code: '23514',
        constraint: 'wager_transaction_terminal',
      },
    );

    const result = await client.query<{
      status: string;
      result_balance: string;
    }>(
      `
      select status, result_balance
      from wager_transactions
      where id = $1
    `,
      [transactionId],
    );

    expect(result.rows).toEqual([
      {
        status: 'PROCESSED',
        result_balance: '100.00',
      },
    ]);
  });

  test('blocks removal of transaction history', async () => {
    await expectDatabaseFailure(
      () =>
        client.query('delete from wager_transactions where id = $1', [
          transactionId,
        ]),
      {
        code: '23514',
        constraint: 'wager_transactions_immutable',
      },
    );
  });

  test('allows rejecting a pending transaction but preserves its payload', async () => {
    const pendingId = randomUUID();

    await client.query(
      `
      insert into wager_transactions (
        id, provider_id, external_transaction_id,
        idempotency_key, payload_hash,
        wallet_id, player_id, round_id, game_id,
        kind, amount, currency, status, created_at
      )
      select
        $1::uuid, 'provider-a', $2::text,
        $3::text, $4::text,
        id, player_id, 'round-1', 'game-1',
        'BET', '25.00', currency, 'PENDING', now()
      from wallets
      where id = $5::uuid
    `,
      [
        pendingId,
        `bet:${pendingId}`,
        `provider-a:bet:${pendingId}`,
        'b'.repeat(64),
        walletId,
      ],
    );

    await expectDatabaseFailure(
      () =>
        client.query(
          `
          update wager_transactions
          set amount = '50.00'
          where id = $1
        `,
          [pendingId],
        ),
      {
        code: '23514',
        constraint: 'wager_transaction_identity_immutable',
      },
    );

    await client.query(
      `
      update wager_transactions
      set
        status = 'REJECTED',
        failure_code = 'INSUFFICIENT_BALANCE',
        result_balance = '10.00'
      where id = $1
    `,
      [pendingId],
    );

    const result = await client.query<{
      status: string;
      amount: string;
    }>(
      `
      select status, amount
      from wager_transactions
      where id = $1
    `,
      [pendingId],
    );

    expect(result.rows).toEqual([
      {
        status: 'REJECTED',
        amount: '25.00',
      },
    ]);

    await expectDatabaseFailure(
      () =>
        client.query(
          `
          update wager_transactions
          set failure_code = 'REFERENCE_NOT_FOUND'
          where id = $1
        `,
          [pendingId],
        ),
      {
        code: '23514',
        constraint: 'wager_transaction_terminal',
      },
    );
  });

  test.each(['REFUND', 'ROLLBACK'])(
    'allows only one processed %s per reference',
    async (kind) => {
      // Registra o crédito de abertura criado no beforeEach.
      await insertEntry();

      const betId = randomUUID();
      const betExternalId = `bet:${betId}`;

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
          $1::uuid, 'provider-a', $2::text,
          $3::text, $4::text,
          id, player_id, 'round-1', 'game-1',
          'BET', '25.00', currency, 'PROCESSED',
          '75.00', now(), now()
        from wallets
        where id = $5::uuid
      `,
        [
          betId,
          betExternalId,
          `provider-a:${betExternalId}`,
          'c'.repeat(64),
          walletId,
        ],
      );

      await client.query(
        `
        update wallets
        set balance = '75.00', version = 2, updated_at = now()
        where id = $1
      `,
        [walletId],
      );

      await client.query(
        `
        insert into wallet_ledger_entries (
          id, wallet_id, transaction_id, direction,
          amount, currency, balance_before,
          balance_after, created_at
        )
        values (
          $1, $2, $3, 'DEBIT',
          '25.00', 'BRL', '100.00', '75.00', now()
        )
      `,
        [randomUUID(), walletId, betId],
      );

      const createPendingReversal = async (): Promise<string> => {
        const id = randomUUID();
        const externalId = `reversal:${id}`;

        await client.query(
          `
          insert into wager_transactions (
            id, provider_id, external_transaction_id,
            idempotency_key, payload_hash,
            wallet_id, player_id, round_id, game_id,
            kind, amount, currency,
            reference_external_transaction_id,
            status, created_at
          )
          select
            $1::uuid, 'provider-a', $2::text,
            $3::text, $4::text,
            id, player_id, 'round-1', 'game-1',
            $5::text, '25.00', currency,
            $6::text, 'PENDING', now()
          from wallets
          where id = $7::uuid
        `,
          [
            id,
            externalId,
            `provider-a:${externalId}`,
            'd'.repeat(64),
            kind,
            betExternalId,
            walletId,
          ],
        );

        return id;
      };

      // Uma rejeição anterior não pode consumir o direito de reverter.
      const rejectedId = await createPendingReversal();

      await client.query(
        `
        update wager_transactions
        set
          status = 'REJECTED',
          failure_code = 'REFERENCE_NOT_PROCESSED',
          result_balance = '75.00'
        where id = $1
      `,
        [rejectedId],
      );

      const firstId = await createPendingReversal();

      await client.query(
        `
        update wager_transactions
        set
          status = 'PROCESSED',
          reference_transaction_id = $2,
          result_balance = '100.00',
          processed_at = now()
        where id = $1
      `,
        [firstId, betId],
      );

      await client.query(
        `
        update wallets
        set balance = '100.00', version = 3, updated_at = now()
        where id = $1
      `,
        [walletId],
      );

      await client.query(
        `
        insert into wallet_ledger_entries (
          id, wallet_id, transaction_id, direction,
          amount, currency, balance_before,
          balance_after, created_at
        )
        values (
          $1, $2, $3, 'CREDIT',
          '25.00', 'BRL', '75.00', '100.00', now()
        )
      `,
        [randomUUID(), walletId, firstId],
      );

      const duplicateId = await createPendingReversal();

      await expectDatabaseFailure(
        () =>
          client.query(
            `
            update wager_transactions
            set
              status = 'PROCESSED',
              reference_transaction_id = $2,
              result_balance = '100.00',
              processed_at = now()
            where id = $1
          `,
            [duplicateId, betId],
          ),
        {
          code: '23505',
          constraint: 'wager_transactions_processed_reversal_unique',
        },
      );

      const processed = await client.query<{ count: string }>(
        `
        select count(*) as count
        from wager_transactions
        where
          reference_transaction_id = $1
          and kind = $2
          and status = 'PROCESSED'
      `,
        [betId, kind],
      );

      expect(processed.rows[0]?.count).toBe('1');

      const reconciliation = await client.query<{
        balance: string;
        calculated_balance: string;
      }>(
        `
        select
          w.balance,
          coalesce(
            sum(
              case
                when l.direction = 'CREDIT' then l.amount
                else -l.amount
              end
            ),
            0
          )::numeric(20,2) as calculated_balance
        from wallets w
        left join wallet_ledger_entries l on l.wallet_id = w.id
        where w.id = $1
        group by w.id, w.balance
      `,
        [walletId],
      );

      expect(reconciliation.rows).toEqual([
        {
          balance: '100.00',
          calculated_balance: '100.00',
        },
      ]);
    },
  );
  test('rejects a ledger amount different from its transaction', async () => {
    await expectDatabaseFailure(
      () =>
        insertEntry({
          amount: '99.00',
          balanceAfter: '99.00',
        }),
      {
        code: '23514',
        constraint: 'ledger_transaction_consistent',
      },
    );
  });

  test('rejects a supported currency different from its transaction', async () => {
    await expectDatabaseFailure(() => insertEntry({ currency: 'GBP' }), {
      code: '23514',
      constraint: 'ledger_transaction_consistent',
    });
  });

  test('rejects a direction incompatible with an opening credit', async () => {
    await expectDatabaseFailure(
      () =>
        insertEntry({
          direction: 'DEBIT',
          balanceBefore: '200.00',
          balanceAfter: '100.00',
        }),
      {
        code: '23514',
        constraint: 'ledger_transaction_consistent',
      },
    );
  });

  test('rejects a balance different from the original transaction result', async () => {
    await expectDatabaseFailure(
      () =>
        insertEntry({
          balanceBefore: '100.00',
          balanceAfter: '200.00',
        }),
      {
        code: '23514',
        constraint: 'ledger_transaction_consistent',
      },
    );
  });

  test('rejects a processed financial transaction without a ledger entry', async () => {
    // O beforeEach cria OPENING processado, ainda sem ledger.
    await expectDatabaseFailure(
      () => client.query('SET CONSTRAINTS wager_ledger_required IMMEDIATE'),
      {
        code: '23514',
        constraint: 'wager_ledger_required',
      },
    );
  });

  test('accepts a processed transaction after its ledger is inserted', async () => {
    await insertEntry();

    await client.query('SET CONSTRAINTS wager_ledger_required IMMEDIATE');

    const result = await client.query<{ count: string }>(
      `
      select count(*) as count
      from wallet_ledger_entries
      where transaction_id = $1
    `,
      [transactionId],
    );

    expect(result.rows[0]?.count).toBe('1');
  });

  test('accepts a processed LOSS without a ledger entry', async () => {
    // Completa a abertura antes de verificar todas as operações.
    await insertEntry();

    const lossId = randomUUID();

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
        $1::uuid, 'provider-a', $2::text,
        $3::text, $4::text,
        id, player_id, 'round-1', 'game-1',
        'LOSS', '0.00', currency, 'PROCESSED',
        '100.00', now(), now()
      from wallets
      where id = $5::uuid
    `,
      [
        lossId,
        `loss:${lossId}`,
        `provider-a:loss:${lossId}`,
        'e'.repeat(64),
        walletId,
      ],
    );

    await client.query('SET CONSTRAINTS wager_ledger_required IMMEDIATE');

    const result = await client.query<{ count: string }>(
      `
      select count(*) as count
      from wallet_ledger_entries
      where transaction_id = $1
    `,
      [lossId],
    );

    expect(result.rows[0]?.count).toBe('0');
  });
});
