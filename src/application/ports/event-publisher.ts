import type { IntegrationEventEnvelope } from '../events/integration-event';

export abstract class EventPublisher {
  abstract publish(event: IntegrationEventEnvelope<object>): Promise<void>;

  abstract close(): void;
}
