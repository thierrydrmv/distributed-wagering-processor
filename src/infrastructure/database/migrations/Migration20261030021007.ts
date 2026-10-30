import { Migration } from '@mikro-orm/migrations';

export class Migration20261030021007 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
    alter table "wager_transactions"
      add column "reference_attempts" integer not null default 0,
      add column "next_reference_attempt_at" timestamptz
        not null default now(),
      add column "reference_claim_token" uuid null,
      add column "reference_claimed_until" timestamptz null,
      add constraint "wager_reference_attempts_non_negative"
        check (reference_attempts >= 0);
  `);

    this.addSql(`
    create index "wager_reference_retry_idx"
    on "wager_transactions" (
      "status",
      "next_reference_attempt_at",
      "id"
    );
  `);
  }

  override async down(): Promise<void> {
    this.addSql(`
    drop index "wager_reference_retry_idx";
  `);

    this.addSql(`
    alter table "wager_transactions"
      drop constraint "wager_reference_attempts_non_negative",
      drop column "reference_claimed_until",
      drop column "reference_claim_token",
      drop column "next_reference_attempt_at",
      drop column "reference_attempts";
  `);
  }
}
