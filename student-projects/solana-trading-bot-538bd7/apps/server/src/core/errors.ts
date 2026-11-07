/** Errors that carry a stable code, so the API and the logs can branch on them. */
export class AppError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode = 500,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ConfigError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'CONFIG_INVALID', 400, details);
  }
}

export class ProviderError extends AppError {
  constructor(
    readonly provider: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(`${provider}: ${message}`, 'PROVIDER_ERROR', 502, details);
  }
}

export class ProviderUnavailableError extends ProviderError {
  constructor(provider: string, message = 'not configured') {
    super(provider, message);
  }
}

export class SafetyError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'SAFETY_BLOCKED', 403, details);
  }
}

export class NotFoundError extends AppError {
  constructor(what: string) {
    super(`${what} not found`, 'NOT_FOUND', 404);
  }
}
