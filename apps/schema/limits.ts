export class InputError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export class ValidationBudget {
  constructor(private remaining = 25_000) {}

  use(depth: number, units = 1) {
    this.remaining -= units;
    if (depth > 64 || this.remaining < 0) {
      throw new InputError('Manifest is too complex to validate. Split it into smaller batches or simplify nested values and schemas.', 413);
    }
  }
}
