import { Migration } from '@mikro-orm/migrations';

export class Migration20261029012330 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
    alter table "wallets"
      drop constraint "wallets_currency_supported",
      add constraint "wallets_currency_supported"
        check (currency ~ '^(BRL|USD|EUR|GBP)$');
  `);

    this.addSql(`
    alter table "wager_transactions"
      drop constraint "wager_transactions_currency_supported",
      add constraint "wager_transactions_currency_supported"
        check (currency ~ '^(BRL|USD|EUR|GBP)$');
  `);
  }

  override async down(): Promise<void> {
    this.addSql(`
    alter table "wager_transactions"
      drop constraint "wager_transactions_currency_supported",
      add constraint "wager_transactions_currency_supported"
        check (currency IN ('BRL', 'USD', 'EUR', 'GBP'));
  `);

    this.addSql(`
    alter table "wallets"
      drop constraint "wallets_currency_supported",
      add constraint "wallets_currency_supported"
        check (currency IN ('BRL', 'USD', 'EUR', 'GBP'));
  `);
  }
}
