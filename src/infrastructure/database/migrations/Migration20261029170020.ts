import { Migration } from '@mikro-orm/migrations';

export class Migration20261029170020 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
    create function public.require_wager_transaction_ledger()
    returns trigger
    language plpgsql
    as $$
    declare
      wager public.wager_transactions%rowtype;
      entry_count bigint;
      requires_entry boolean;
    begin
      -- Consulta o estado final, não o estado intermediário
      -- capturado quando o trigger foi agendado.
      select *
      into wager
      from public.wager_transactions
      where id = new.id;

      if not found then
        raise exception using
          errcode = '23514',
          message = 'Wagering transaction disappeared',
          constraint = 'wager_ledger_required';
      end if;

      select count(*)
      into entry_count
      from public.wallet_ledger_entries
      where transaction_id = wager.id;

      requires_entry :=
        wager.status = 'PROCESSED'
        and wager.kind <> 'LOSS'
        and wager.amount > 0;

      if
        (requires_entry and entry_count <> 1)
        or (not requires_entry and entry_count <> 0)
      then
        raise exception using
          errcode = '23514',
          message = 'Transaction status and ledger entries are inconsistent',
          constraint = 'wager_ledger_required';
      end if;

      return null;
    end;
    $$;
  `);

    this.addSql(`
    create constraint trigger "wager_ledger_required"
    after insert or update on "wager_transactions"
    deferrable initially deferred
    for each row
    execute function public.require_wager_transaction_ledger();
  `);
  }

  override async down(): Promise<void> {
    this.addSql(`
    drop trigger "wager_ledger_required"
    on "wager_transactions";
  `);

    this.addSql(`
    drop function public.require_wager_transaction_ledger();
  `);
  }
}
