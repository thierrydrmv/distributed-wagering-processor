import { Migration } from '@mikro-orm/migrations';

export class Migration20261029010535 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `create table "wallets" ("id" uuid not null, "player_id" uuid not null, "currency" varchar(3) not null, "balance" numeric(20,2) not null, "version" int not null default 1, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "wallets_pkey" primary key ("id"), constraint wallets_balance_non_negative check (balance >= 0), constraint wallets_version_positive check (version >= 1), constraint wallets_currency_supported check (currency IN ('BRL', 'USD', 'EUR', 'GBP')));`,
    );
    this.addSql(
      `alter table "wallets" add constraint "wallets_player_currency_unique" unique ("player_id", "currency");`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "wallets" cascade;`);
  }
}
