import { Migration } from '@mikro-orm/migrations';

export class Migration20261029011746 extends Migration {
  override async up(): Promise<void> {
    this
      .addSql(`create table "wager_transactions" ("id" uuid not null, "provider_id" varchar(255) not null, "external_transaction_id" varchar(255) not null, "idempotency_key" varchar(255) not null, "payload_hash" varchar(64) not null, "wallet_id" uuid not null, "player_id" uuid not null, "round_id" varchar(255) not null, "game_id" varchar(255) not null, "kind" text check ("kind" in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')) not null, "amount" numeric(20,2) not null, "currency" varchar(3) not null, "reference_external_transaction_id" varchar(255) null, "reference_transaction_id" uuid null, "status" text check ("status" in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')) not null, "failure_code" text check ("failure_code" in ('INSUFFICIENT_BALANCE', 'REVERSAL_INSUFFICIENT_BALANCE', 'WALLET_NOT_FOUND', 'WALLET_PLAYER_MISMATCH', 'CURRENCY_MISMATCH', 'REFERENCE_NOT_FOUND', 'REFERENCE_NOT_PROCESSED', 'REFERENCE_MISMATCH', 'INVALID_REFERENCE_KIND', 'REFERENCE_AMOUNT_MISMATCH', 'REFERENCE_ALREADY_REVERSED', 'PERMANENT_INFRASTRUCTURE_FAILURE')) null, "result_balance" numeric(20,2) null, "created_at" timestamptz not null, "processed_at" timestamptz null, constraint "wager_transactions_pkey" primary key ("id"), constraint wager_transactions_amount_valid check (
          (kind = 'LOSS' AND amount = 0)
          OR (kind = 'WIN' AND amount >= 0)
          OR (
            kind IN ('OPENING', 'BET', 'REFUND', 'ROLLBACK')
            AND amount > 0
          )
        ), constraint wager_transactions_currency_supported check (currency IN ('BRL', 'USD', 'EUR', 'GBP')), constraint wager_transactions_result_balance_non_negative check (result_balance IS NULL OR result_balance >= 0), constraint wager_transactions_required_reference check (
          kind NOT IN ('REFUND', 'ROLLBACK')
          OR (
            reference_external_transaction_id IS NOT NULL
            AND length(trim(reference_external_transaction_id)) > 0
          )
        ), constraint wager_transactions_processing_result check (
          (
            status = 'PROCESSED'
            AND processed_at IS NOT NULL
            AND result_balance IS NOT NULL
            AND failure_code IS NULL
          )
          OR (
            status IN ('REJECTED', 'FAILED')
            AND processed_at IS NULL
            AND failure_code IS NOT NULL
          )
          OR (
            status IN ('PENDING', 'PENDING_REFERENCE')
            AND processed_at IS NULL
            AND result_balance IS NULL
            AND failure_code IS NULL
          )
        ));`);
    this.addSql(
      `create index "wager_transactions_wallet_created_idx" on "wager_transactions" ("wallet_id", "created_at", "id");`,
    );
    this.addSql(
      `create index "wager_transactions_status_created_idx" on "wager_transactions" ("status", "created_at", "id");`,
    );
    this.addSql(
      `create index "wager_transactions_reference_idx" on "wager_transactions" ("reference_transaction_id");`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "wager_transactions_idempotency_key_unique" unique ("idempotency_key");`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "wager_transactions_provider_external_unique" unique ("provider_id", "external_transaction_id");`,
    );

    this.addSql(
      `alter table "wager_transactions" add constraint "wager_transactions_wallet_id_foreign" foreign key ("wallet_id") references "wallets" ("id") on update restrict on delete restrict;`,
    );
    this.addSql(
      `alter table "wager_transactions" add constraint "wager_transactions_reference_transaction_id_foreign" foreign key ("reference_transaction_id") references "wager_transactions" ("id") on update restrict on delete restrict;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table "wager_transactions" drop constraint "wager_transactions_reference_transaction_id_foreign";`,
    );

    this.addSql(`drop table if exists "wager_transactions" cascade;`);
  }
}
