import 'dotenv/config';

import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { WalletSchema } from './entities/wallet.record';
import { WagerTransactionSchema } from './entities/wager-transaction.record';
import { WalletLedgerEntrySchema } from './entities/wallet-ledger-entry.record';

const clientUrl = process.env.DATABASE_URL;

if (!clientUrl) {
  throw new Error('DATABASE_URL is required');
}

export default defineConfig({
  clientUrl,
  entities: [WalletSchema, WagerTransactionSchema, WalletLedgerEntrySchema],

  extensions: [Migrator],

  migrations: {
    path: 'dist/infrastructure/database/migrations',
    pathTs: 'src/infrastructure/database/migrations',
    transactional: true,
    allOrNothing: true,
    emit: 'ts',
  },

  pool: {
    min: 0,
    max: 5,
  },

  debug: false,
});
