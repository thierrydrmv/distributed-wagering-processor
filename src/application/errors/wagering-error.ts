export class WageringError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WageringError';
  }
}

export class PersistenceConflictError extends Error {
  constructor(cause: unknown) {
    super('A unique persistence constraint was violated', { cause });
    this.name = 'PersistenceConflictError';
  }
}
