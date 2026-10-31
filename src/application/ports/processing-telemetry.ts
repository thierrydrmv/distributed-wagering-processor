export type ProcessingSource = 'http' | 'sqs' | 'reference';

export interface ProcessingTelemetry {
  recordResult(
    source: ProcessingSource,
    status: string,
    idempotentReplay: boolean,
  ): void;

  recordFailure(source: ProcessingSource): void;

  observeDuration(source: ProcessingSource, seconds: number): void;
}
