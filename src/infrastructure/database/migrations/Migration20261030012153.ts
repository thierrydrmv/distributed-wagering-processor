import { Migration } from '@mikro-orm/migrations';

export class Migration20261030012153 extends Migration {
  override async up(): Promise<void> {
    this.replaceFailureCodeCheck(true);
  }

  override async down(): Promise<void> {
    this.replaceFailureCodeCheck(false);
  }

  private replaceFailureCodeCheck(includeBalanceLimit: boolean): void {
    const codes = [
      'INSUFFICIENT_BALANCE',
      'REVERSAL_INSUFFICIENT_BALANCE',
      'WALLET_NOT_FOUND',
      'WALLET_PLAYER_MISMATCH',
      'CURRENCY_MISMATCH',
      'REFERENCE_NOT_FOUND',
      'REFERENCE_NOT_PROCESSED',
      'REFERENCE_MISMATCH',
      'INVALID_REFERENCE_KIND',
      'REFERENCE_AMOUNT_MISMATCH',
      'REFERENCE_ALREADY_REVERSED',
      'PERMANENT_INFRASTRUCTURE_FAILURE',
    ];

    if (includeBalanceLimit) {
      codes.push('BALANCE_LIMIT_EXCEEDED');
    }

    const allowedCodes = codes.map((code) => `'${code}'`).join(', ');

    this.addSql(`
    alter table "wager_transactions"
    drop constraint "wager_transactions_failure_code_check";
  `);

    this.addSql(`
    alter table "wager_transactions"
    add constraint "wager_transactions_failure_code_check"
    check (failure_code in (${allowedCodes}));
  `);
  }
}
