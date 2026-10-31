import { Migration } from '@mikro-orm/migrations';

export class Migration20261031125909 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
    create table "inbox_messages" (
      "consumer_name" varchar(255) not null,
      "message_id" varchar(255) not null,
      "payload_hash" varchar(64) not null,
      "received_at" timestamptz not null,
      "processed_at" timestamptz null,
      "transaction_id" uuid null,

      constraint "inbox_messages_pkey"
        primary key ("consumer_name", "message_id"),

      constraint "inbox_transaction_foreign"
        foreign key ("transaction_id")
        references "wager_transactions" ("id")
        on update restrict on delete restrict,

      constraint "inbox_processing_result"
        check (
          (processed_at is null and transaction_id is null)
          or
          (processed_at is not null and transaction_id is not null)
        )
    );
  `);
  }

  override async down(): Promise<void> {
    this.addSql('drop table "inbox_messages";');
  }
}
