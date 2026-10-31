import { Migration } from '@mikro-orm/migrations';

export class Migration20261031132501 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
    alter table "outbox_messages"
      add column "claim_token" uuid null,
      add column "claimed_until" timestamptz null;
  `);
  }

  override async down(): Promise<void> {
    this.addSql(`
    alter table "outbox_messages"
      drop column "claimed_until",
      drop column "claim_token";
  `);
  }
}
