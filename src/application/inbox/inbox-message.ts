export interface InboxMessageState {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
  transactionId?: string;
}

export interface InboxDelivery {
  consumerName: string;
  messageId: string;
  payloadHash: string;
}

export class InboxMessage {
  private constructor(private readonly state: InboxMessageState) {}

  static receive(props: InboxDelivery & { receivedAt: Date }): InboxMessage {
    if (
      !props.consumerName.trim() ||
      props.consumerName.length > 255 ||
      !props.messageId.trim() ||
      props.messageId.length > 255 ||
      !/^[0-9a-f]{64}$/.test(props.payloadHash) ||
      !Number.isFinite(props.receivedAt.getTime())
    ) {
      throw new Error('Invalid inbox message');
    }

    return new InboxMessage(structuredClone(props));
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(structuredClone(state));
  }

  get transactionId(): string | undefined {
    return this.state.transactionId;
  }

  isProcessed(): boolean {
    return this.state.processedAt !== undefined;
  }

  matchesPayload(hash: string): boolean {
    return this.state.payloadHash === hash;
  }

  markProcessed(transactionId: string, at: Date): void {
    if (this.isProcessed()) {
      throw new Error('Inbox message is already processed');
    }

    if (!transactionId.trim() || !Number.isFinite(at.getTime())) {
      throw new Error('Invalid inbox processing result');
    }

    this.state.transactionId = transactionId;
    this.state.processedAt = new Date(at);
  }

  toState(): InboxMessageState {
    return structuredClone(this.state);
  }
}
