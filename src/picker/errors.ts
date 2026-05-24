/**
 * Structured error classes thrown by `provider.catalog.runOne` per ADR-0001.
 *
 * `ProviderModels` catches these and translates into freshness state for the
 * picker. Channel render layer surfaces them to users.
 */

export class RunOneError extends Error {
  readonly kind: string;
  constructor(kind: string, message: string) {
    super(message);
    this.kind = kind;
    this.name = "RunOneError";
  }
}

export class AuthMissingError extends RunOneError {
  constructor(message: string) {
    super("AuthMissing", message);
    this.name = "AuthMissingError";
  }
}

export class AuthInvalidError extends RunOneError {
  constructor(message: string) {
    super("AuthInvalid", message);
    this.name = "AuthInvalidError";
  }
}

export class EndpointUnreachableError extends RunOneError {
  constructor(message: string) {
    super("EndpointUnreachable", message);
    this.name = "EndpointUnreachableError";
  }
}

export class ProtocolError extends RunOneError {
  constructor(message: string) {
    super("Protocol", message);
    this.name = "ProtocolError";
  }
}

export class TimeoutError extends RunOneError {
  constructor(message: string) {
    super("Timeout", message);
    this.name = "TimeoutError";
  }
}
