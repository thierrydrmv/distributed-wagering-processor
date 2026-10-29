import 'dotenv/config';

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { Client } from 'pg';
import ormConfig from '../../src/infrastructure/database/mikro-orm.config';

describe('Financial consistency at real commit', () => {
  const databaseName = `wagering_commit_${randomUUID().replaceAll('-', '')}_test`;

  let admin: Client;
  let client: Client;
  let adminConnected = false;
  let clientConnected = false;
  let databaseCreated = false;

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
  }, 30_000);

  afterAll(async () => {
    try {
      if (clientConnected) {
        await client.end();
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
});
