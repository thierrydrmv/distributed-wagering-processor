import { Migration } from '@mikro-orm/migrations';

export class Migration20261029164853 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
    create unique index "wager_transactions_processed_reversal_unique"
    on "wager_transactions" ("reference_transaction_id", "kind")
    where
      status = 'PROCESSED'
      and kind in ('REFUND', 'ROLLBACK');
  `);

    this.addSql(`
    alter table "wager_transactions"
    add constraint "wager_transactions_processed_reference_required"
    check (
      status <> 'PROCESSED'
      or kind not in ('REFUND', 'ROLLBACK')
      or reference_transaction_id is not null
    );
  `);

    this.addSql(`
    create function public.guard_wager_transaction_update()
    returns trigger
    language plpgsql
    as $$
    begin
      if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
        raise exception using
          errcode = '23514',
          message = 'Terminal wagering transactions cannot be changed',
          constraint = 'wager_transaction_terminal';
      end if;

      if row(
        new.id,
        new.provider_id,
        new.external_transaction_id,
        new.idempotency_key,
        new.payload_hash,
        new.wallet_id,
        new.player_id,
        new.round_id,
        new.game_id,
        new.kind,
        new.amount,
        new.currency,
        new.reference_external_transaction_id,
        new.created_at
      ) is distinct from row(
        old.id,
        old.provider_id,
        old.external_transaction_id,
        old.idempotency_key,
        old.payload_hash,
        old.wallet_id,
        old.player_id,
        old.round_id,
        old.game_id,
        old.kind,
        old.amount,
        old.currency,
        old.reference_external_transaction_id,
        old.created_at
      ) then
        raise exception using
          errcode = '23514',
          message = 'Original wagering transaction data cannot be changed',
          constraint = 'wager_transaction_identity_immutable';
      end if;

      if
        new.status = 'PENDING'
        and old.status = 'PENDING_REFERENCE'
      then
        raise exception using
          errcode = '23514',
          message = 'Cannot return a pending reference to pending',
          constraint = 'wager_transaction_transition_valid';
      end if;

      return new;
    end;
    $$;
  `);

    this.addSql(`
    create trigger "wager_transaction_guard_update"
    before update on "wager_transactions"
    for each row
    execute function public.guard_wager_transaction_update();
  `);

    this.addSql(`
    create function public.reject_wager_transaction_removal()
    returns trigger
    language plpgsql
    as $$
    begin
      raise exception using
        errcode = '23514',
        message = 'Wagering transaction history cannot be removed',
        constraint = 'wager_transactions_immutable';
    end;
    $$;
  `);

    this.addSql(`
    create trigger "wager_transactions_prevent_removal"
    before delete or truncate on "wager_transactions"
    for each statement
    execute function public.reject_wager_transaction_removal();
  `);
  }

  override async down(): Promise<void> {
    this.addSql(`
    drop trigger "wager_transactions_prevent_removal"
    on "wager_transactions";
  `);

    this.addSql(`
    drop function public.reject_wager_transaction_removal();
  `);

    this.addSql(`
    drop trigger "wager_transaction_guard_update"
    on "wager_transactions";
  `);

    this.addSql(`
    drop function public.guard_wager_transaction_update();
  `);

    this.addSql(`
    alter table "wager_transactions"
    drop constraint "wager_transactions_processed_reference_required";
  `);

    this.addSql(`
    drop index "wager_transactions_processed_reversal_unique";
  `);
  }
}
