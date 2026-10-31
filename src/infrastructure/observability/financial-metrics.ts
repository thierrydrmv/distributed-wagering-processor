import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type {
  ProcessingSource,
  ProcessingTelemetry,
} from '../../application/ports/processing-telemetry';

export class FinancialMetrics implements ProcessingTelemetry {
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

  readonly transactionResults = new Counter({
    name: 'wagering_transaction_results_total',
    help: 'Committed non-replay processing outcomes, including reference retries',
    labelNames: ['source', 'status'] as const,
    registers: [this.registry],
  });

  readonly idempotentReplays = new Counter({
    name: 'wagering_idempotent_replays_total',
    help: 'Processing calls returning a previously persisted result',
    labelNames: ['source'] as const,
    registers: [this.registry],
  });

  readonly processingFailures = new Counter({
    name: 'wagering_processing_failures_total',
    help: 'Processing calls that threw an exception',
    labelNames: ['source'] as const,
    registers: [this.registry],
  });

  readonly processingDuration = new Histogram({
    name: 'wagering_processing_duration_seconds',
    help: 'Financial processing duration, including transaction commit',
    labelNames: ['source'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [this.registry],
  });

  readonly retries = new Counter({
    name: 'wagering_retries_total',
    help: 'Retry attempts scheduled successfully',
    labelNames: ['component'] as const,
    registers: [this.registry],
  });

  readonly dlqMessages = new Counter({
    name: 'wagering_dlq_messages_total',
    help: 'Successful consumer sends to the dead-letter queue',
    registers: [this.registry],
  });

  readonly persistenceConflicts = new Counter({
    name: 'wagering_persistence_conflicts_total',
    help: 'Database constraint and concurrency conflicts observed by the financial unit of work',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });

  recordResult(
    source: ProcessingSource,
    status: string,
    idempotentReplay: boolean,
  ): void {
    if (idempotentReplay) {
      this.idempotentReplays.inc({ source });
      return;
    }

    this.transactionResults.inc({ source, status });
  }

  recordFailure(source: ProcessingSource): void {
    this.processingFailures.inc({ source });
  }

  observeDuration(source: ProcessingSource, seconds: number): void {
    this.processingDuration.observe({ source }, seconds);
  }
}
