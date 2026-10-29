import { Migration } from '@mikro-orm/migrations';

export class Migration20261029170452 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
    create function public.assert_wallet_financial_consistency(
      target_wallet_id uuid
    )
    returns void
    language plpgsql
    as $$
    declare
      wallet public.wallets%rowtype;
      calculated_balance numeric;
      expected_version bigint;
      incompatible_entries bigint;
    begin
      select *
      into wallet
      from public.wallets
      where id = target_wallet_id
      for no key update;

      if not found then
        raise exception using
          errcode = '23514',
          message = 'Wallet required for financial validation does not exist',
          constraint = 'wallet_financial_consistency';
      end if;

      select
        coalesce(
          sum(
            case
              when ledger.direction = 'CREDIT' then ledger.amount
              else -ledger.amount
            end
          ),
          0
        ),
        1 + count(*) filter (where wager.kind <> 'OPENING'),
        count(*) filter (
          where
            ledger.currency <> wallet.currency
            or wager.player_id <> wallet.player_id
        )
      into
        calculated_balance,
        expected_version,
        incompatible_entries
      from public.wallet_ledger_entries ledger
      join public.wager_transactions wager
        on wager.id = ledger.transaction_id
      where ledger.wallet_id = target_wallet_id;

      if incompatible_entries <> 0 then
        raise exception using
          errcode = '23514',
          message = 'Wallet identity is incompatible with its financial history',
          constraint = 'wallet_history_compatible';
      end if;

      if wallet.balance is distinct from calculated_balance then
        raise exception using
          errcode = '23514',
          message = 'Wallet balance differs from its ledger',
          constraint = 'wallet_balance_matches_ledger';
      end if;

      if wallet.version::bigint <> expected_version then
        raise exception using
          errcode = '23514',
          message = 'Wallet version differs from its financial movements',
          constraint = 'wallet_version_matches_ledger';
      end if;
    end;
    $$;
  `);

    this.addSql(`
    create function public.check_wallet_financial_consistency()
    returns trigger
    language plpgsql
    as $$
    declare
      target_wallet_id uuid;
    begin
      if tg_table_name = 'wallets' then
        target_wallet_id := new.id;
      else
        target_wallet_id := new.wallet_id;
      end if;

      perform public.assert_wallet_financial_consistency(
        target_wallet_id
      );

      return null;
    end;
    $$;
  `);

    this.addSql(`
    create constraint trigger "wallet_financial_consistency"
    after insert or update on "wallets"
    deferrable initially deferred
    for each row
    execute function public.check_wallet_financial_consistency();
  `);

    this.addSql(`
    create constraint trigger "ledger_wallet_financial_consistency"
    after insert on "wallet_ledger_entries"
    deferrable initially deferred
    for each row
    execute function public.check_wallet_financial_consistency();
  `);

    // Verifica também wallets já existentes.
    // A migration falha se encontrar inconsistência; não corrige dados.
    this.addSql(`
    select public.assert_wallet_financial_consistency(id)
    from public.wallets;
  `);
  }

  override async down(): Promise<void> {
    this.addSql(`
    drop trigger "ledger_wallet_financial_consistency"
    on "wallet_ledger_entries";
  `);

    this.addSql(`
    drop trigger "wallet_financial_consistency"
    on "wallets";
  `);

    this.addSql(`
    drop function public.check_wallet_financial_consistency();
  `);

    this.addSql(`
    drop function public.assert_wallet_financial_consistency(uuid);
  `);
  }
}
