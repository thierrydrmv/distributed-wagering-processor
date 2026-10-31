import { Counter, Registry } from 'prom-client';

export class FinancialMetrics {
  readonly registry = new Registry();

  readonly reconciliationDivergences = new Counter({
    name: 'wagering_reconciliation_divergences_total',
    help: 'Number of wallet reconciliation mismatches',
    registers: [this.registry],
  });
}
