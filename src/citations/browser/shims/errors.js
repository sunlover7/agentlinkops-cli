// Local shims for the @oneglanse/* runtime imports in the vendored browser
// layer. Upstream, these live in workspace packages we did not vendor; the
// behavior below is the minimal honest equivalent. The logger writes to
// stderr so a --json stdout reader never sees framework chatter.
export class ExternalServiceError extends Error {
  constructor(service, message, status, meta, cause) {
    super(`${service}: ${message}`);
    this.name = 'ExternalServiceError';
    this.service = service;
    this.status = status ?? null;
    this.meta = meta ?? null;
    if (cause) this.cause = cause;
  }
}

export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export function toErrorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
