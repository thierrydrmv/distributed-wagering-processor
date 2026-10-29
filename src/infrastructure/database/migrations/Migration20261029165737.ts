import { Migration } from '@mikro-orm/migrations';

export class Migration20261029165737 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
    create function public.validate_wallet_ledger_transaction()
    returns trigger
    language plpgsql
    as $$
    declare
      wager public.wager_transactions%rowtype;
      wallet public.wallets%rowtype;
      referenced public.wager_transactions%rowtype;
      expected_direction text;
    begin
      select *
      into wager
      from public.wager_transactions
      where id = new.transaction_id;

      if not found then
        raise exception using
          errcode = '23503',
          message = 'Ledger transaction does not exist',
          constraint = 'ledger_transaction_exists';
      end if;

      select *
      into wallet
      from public.wallets
      where id = new.wallet_id;

      if not found then
        raise exception using
          errcode = '23503',
          message = 'Ledger wallet does not exist',
          constraint = 'ledger_wallet_exists';
      end if;

      if
        wager.status <> 'PROCESSED'
        or wager.wallet_id <> new.wallet_id
        or wager.player_id <> wallet.player_id
        or wager.currency <> new.currency
        or wallet.currency <> new.currency
        or wager.amount <> new.amount
        or wager.result_balance is distinct from new.balance_after
      then
        raise exception using
          errcode = '23514',
          message = 'Ledger entry does not match its transaction',
          constraint = 'ledger_transaction_consistent';
      end if;

      if wager.reference_transaction_id is not null then
        select *
        into referenced
        from public.wager_transactions
        where id = wager.reference_transaction_id;

        if not found then
          raise exception using
            errcode = '23514',
            message = 'Resolved transaction reference does not exist',
            constraint = 'ledger_reference_consistent';
        end if;

        if
          referenced.status <> 'PROCESSED'
          or referenced.id = wager.id
          or referenced.provider_id <> wager.provider_id
          or referenced.player_id <> wager.player_id
          or referenced.wallet_id <> wager.wallet_id
          or referenced.currency <> wager.currency
          or referenced.round_id <> wager.round_id
          or referenced.external_transaction_id
            is distinct from wager.reference_external_transaction_id
        then
          raise exception using
            errcode = '23514',
            message = 'Ledger transaction has an incompatible reference',
            constraint = 'ledger_reference_consistent';
        end if;
      end if;

      case wager.kind
        when 'OPENING' then
          expected_direction := 'CREDIT';

        when 'BET' then
          expected_direction := 'DEBIT';

        when 'WIN' then
          if
            wager.reference_external_transaction_id is not null
            and (
              wager.reference_transaction_id is null
              or referenced.kind <> 'BET'
            )
          then
            raise exception using
              errcode = '23514',
              message = 'WIN must resolve its submitted BET reference',
              constraint = 'ledger_reference_consistent';
          end if;

          expected_direction := 'CREDIT';

        when 'REFUND' then
          if
            wager.reference_transaction_id is null
            or referenced.kind <> 'BET'
            or referenced.amount <> wager.amount
          then
            raise exception using
              errcode = '23514',
              message = 'REFUND must fully reverse a processed BET',
              constraint = 'ledger_reference_consistent';
          end if;

          expected_direction := 'CREDIT';

        when 'ROLLBACK' then
          if
            wager.reference_transaction_id is null
            or referenced.kind not in ('BET', 'WIN', 'REFUND')
            or referenced.amount <> wager.amount
          then
            raise exception using
              errcode = '23514',
              message = 'ROLLBACK has an invalid reversal reference',
              constraint = 'ledger_reference_consistent';
          end if;

          if referenced.kind = 'BET' then
            expected_direction := 'CREDIT';
          else
            expected_direction := 'DEBIT';
          end if;

        else
          raise exception using
            errcode = '23514',
            message = 'Transaction kind cannot produce a ledger entry',
            constraint = 'ledger_transaction_consistent';
      end case;

      if new.direction <> expected_direction then
        raise exception using
          errcode = '23514',
          message = 'Ledger direction does not match its transaction',
          constraint = 'ledger_transaction_consistent';
      end if;

      return new;
    end;
    $$;
  `);

    this.addSql(`
    create trigger "ledger_validate_transaction"
    after insert on "wallet_ledger_entries"
    for each row
    execute function public.validate_wallet_ledger_transaction();
  `);
  }

  override async down(): Promise<void> {
    this.addSql(`
    drop trigger "ledger_validate_transaction"
    on "wallet_ledger_entries";
  `);

    this.addSql(`
    drop function public.validate_wallet_ledger_transaction();
  `);
  }
}
