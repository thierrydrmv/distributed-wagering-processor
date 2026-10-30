export interface EventContext {
  eventId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
}

export interface IntegrationEventProps<T extends object> extends EventContext {
  aggregateId: string;
  data: T;
}

export interface IntegrationEventEnvelope<T extends object> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: T;
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) {
      freezeDeep(child);
    }

    Object.freeze(value);
  }

  return value;
}

export abstract class IntegrationEvent<T extends object> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId: string | undefined;
  readonly data: Readonly<T>;

  private readonly occurredAtTimestamp: number;

  protected constructor(props: IntegrationEventProps<T>) {
    if (
      !props.eventId.trim() ||
      !props.aggregateId.trim() ||
      !props.correlationId.trim()
    ) {
      throw new Error('Event identifiers cannot be empty');
    }

    if (!Number.isFinite(props.occurredAt.getTime())) {
      throw new Error('Invalid event occurrence date');
    }

    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAtTimestamp = props.occurredAt.getTime();

    // O evento não compartilha objetos mutáveis com o chamador.
    this.data = freezeDeep(structuredClone(props.data));
  }

  get occurredAt(): Date {
    return new Date(this.occurredAtTimestamp);
  }

  toJSON(): IntegrationEventEnvelope<T> {
    const envelope: IntegrationEventEnvelope<T> = {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: structuredClone(this.data),
    };

    if (this.causationId !== undefined) {
      envelope.causationId = this.causationId;
    }

    return envelope;
  }
}
