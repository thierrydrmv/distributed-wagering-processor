import 'dotenv/config';
import { MikroORM } from '@mikro-orm/postgresql';
import ormConfig from '../infrastructure/database/mikro-orm.config';

async function migrate(): Promise<void> {
  const orm = await MikroORM.init({
    ...ormConfig,
    preferTs: false,
  });

  try {
    await orm.getMigrator().up();

    console.log(
      JSON.stringify({
        event: 'database_migrations_completed',
      }),
    );
  } finally {
    await orm.close(true);
  }
}

void migrate().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: 'database_migrations_failed',
      errorType: error instanceof Error ? error.name : 'UnknownError',
    }),
  );

  process.exitCode = 1;
});
