import { Migration } from '@mikro-orm/migrations';

export class Migration20261030005550 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
    create table "outbox_messages" (
      "id" uuid not null,
      "aggregate_id" uuid not null,
      "event_type" varchar(255) not null,
      "payload" jsonb not null,
      "occurred_at" timestamptz not null,
      "attempts" integer not null default 0,
      "next_attempt_at" timestamptz null,
      "published_at" timestamptz null,

      constraint "outbox_messages_pkey"
        primary key ("id"),

      constraint "outbox_attempts_non_negative"
        check (attempts >= 0)
    );
  `);

    this.addSql(`
    create index "outbox_publication_idx"
    on "outbox_messages" (
      "published_at",
      "next_attempt_at",
      "occurred_at",
      "id"
    );
  `);
  }

  override async down(): Promise<void> {
    this.addSql('drop table "outbox_messages";');
  }
}
