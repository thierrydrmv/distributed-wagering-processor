import { Migration } from '@mikro-orm/migrations';

export class Migration20261029022239 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
    create table "wallet_ledger_entries" (
      "id" uuid not null,
      "wallet_id" uuid not null,
      "transaction_id" uuid not null,
      "direction" text not null,
      "amount" numeric(20,2) not null,
      "currency" varchar(3) not null,
      "balance_before" numeric(20,2) not null,
      "balance_after" numeric(20,2) not null,
      "created_at" timestamptz not null,

      constraint "wallet_ledger_entries_pkey"
        primary key ("id"),

      constraint "ledger_wallet_transaction_unique"
        unique ("wallet_id", "transaction_id"),

      constraint "wallet_ledger_entries_wallet_id_foreign"
        foreign key ("wallet_id")
        references "wallets" ("id")
        on update restrict on delete restrict,

      constraint "wallet_ledger_entries_transaction_id_foreign"
        foreign key ("transaction_id")
        references "wager_transactions" ("id")
        on update restrict on delete restrict,

      constraint "wallet_ledger_entries_direction_check"
        check ("direction" in ('DEBIT', 'CREDIT')),

      constraint "ledger_currency_supported"
        check (currency ~ '^(BRL|USD|EUR|GBP)$'),

      constraint "ledger_amount_valid"
        check (
          amount > 0
          AND amount <= 999999999999999999.99
        ),

      constraint "ledger_balances_valid"
        check (
          balance_before >= 0
          AND balance_before <= 999999999999999999.99
          AND balance_after >= 0
          AND balance_after <= 999999999999999999.99
        ),

      constraint "ledger_arithmetic_valid"
        check (
          (direction = 'CREDIT' AND balance_after = balance_before + amount)
          OR
          (direction = 'DEBIT' AND balance_after = balance_before - amount)
        )
    );
  `);

    this.addSql(`
    create index "ledger_wallet_created_id_idx"
      on "wallet_ledger_entries" ("wallet_id", "created_at", "id");
  `);

    this.addSql(`
    create index "ledger_transaction_idx"
      on "wallet_ledger_entries" ("transaction_id");
  `);

    this.addSql(`
    create function public.reject_wallet_ledger_mutation()
    returns trigger
    language plpgsql
    as $$
    begin
      raise exception using
        errcode = '23514',
        message = 'Wallet ledger is immutable',
        constraint = 'ledger_immutable';
    end;
    $$;
  `);

    this.addSql(`
    create trigger "ledger_prevent_mutation"
    before update or delete or truncate
    on "wallet_ledger_entries"
    for each statement
    execute function public.reject_wallet_ledger_mutation();
  `);
  }

  override async down(): Promise<void> {
    this.addSql(`
    drop trigger "ledger_prevent_mutation"
      on "wallet_ledger_entries";
  `);

    this.addSql(`
    drop table "wallet_ledger_entries";
  `);

    this.addSql(`
    drop function public.reject_wallet_ledger_mutation();
  `);
  }
}
