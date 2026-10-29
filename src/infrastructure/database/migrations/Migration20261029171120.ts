import { Migration } from '@mikro-orm/migrations';

export class Migration20261029171120 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
    alter table "wallets"
    add constraint "wallets_balance_finite"
    check (balance <= 999999999999999999.99);
  `);

    this.addSql(`
    alter table "wager_transactions"
    add constraint "wager_transactions_money_finite"
    check (
      amount <= 999999999999999999.99
      and (
        result_balance is null
        or result_balance <= 999999999999999999.99
      )
    );
  `);

    this.addSql(`
    create unique index "wager_transactions_opening_unique"
    on "wager_transactions" ("wallet_id")
    where kind = 'OPENING' and status = 'PROCESSED';
  `);

    this.addSql(`
    create function public.guard_wallet_identity()
    returns trigger
    language plpgsql
    as $$
    begin
      if row(
        new.id,
        new.player_id,
        new.currency,
        new.created_at
      ) is distinct from row(
        old.id,
        old.player_id,
        old.currency,
        old.created_at
      ) then
        raise exception using
          errcode = '23514',
          message = 'Wallet identity cannot be changed',
          constraint = 'wallet_identity_immutable';
      end if;

      return new;
    end;
    $$;
  `);

    this.addSql(`
    create trigger "wallet_guard_identity"
    before update on "wallets"
    for each row
    execute function public.guard_wallet_identity();
  `);
  }

  override async down(): Promise<void> {
    this.addSql(`
    drop trigger "wallet_guard_identity" on "wallets";
  `);

    this.addSql(`
    drop function public.guard_wallet_identity();
  `);

    this.addSql(`
    drop index "wager_transactions_opening_unique";
  `);

    this.addSql(`
    alter table "wager_transactions"
    drop constraint "wager_transactions_money_finite";
  `);

    this.addSql(`
    alter table "wallets"
    drop constraint "wallets_balance_finite";
  `);
  }
}
