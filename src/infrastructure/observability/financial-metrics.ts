import { Counter, Gauge, Histogram, Registry } from 'prom-client';

export class FinancialMetrics {
  readonly registry = new Registry();

  readonly reconciliationDivergences = new Counter({
    name: 'wagering_reconciliation_divergences_total',
    help: 'Number of wallet reconciliation mismatches',
    registers: [this.registry],
  });

  readonly httpRequests = new Counter({
    name: 'wagering_http_requests_total',
    help: 'Completed HTTP requests',
    labelNames: ['method', 'status_code'] as const,
    registers: [this.registry],
  });

  readonly httpDuration = new Histogram({
    name: 'wagering_http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  readonly outboxPending = new Gauge({
    name: 'wagering_outbox_pending_messages',
    help: 'Committed outbox messages awaiting publication',
    registers: [this.registry],
  });

  readonly outboxLag = new Gauge({
    name: 'wagering_outbox_oldest_pending_age_seconds',
    help: 'Age of the oldest unpublished outbox message',
    registers: [this.registry],
  });

  readonly outboxCollectionUp = new Gauge({
    name: 'wagering_outbox_collection_up',
    help: 'Whether the latest outbox metrics collection succeeded',
    registers: [this.registry],
  });
}
