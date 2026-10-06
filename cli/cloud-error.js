export class CloudError extends Error {
  constructor(code, status, details = null, serverMessage = null, envelope = null, metadata = {}) {
    super(`${code}${status ? ` (${status})` : ''}`);
    this.name = 'CloudError'; this.code = code; this.status = status; this.details = details;
    // DP-0063-T03: the server's message says what to fix; keep it for the CLI to print.
    this.serverMessage = typeof serverMessage === 'string' ? serverMessage : null;
    // Keep the public server envelope structured; the CLI must not stringify issues into a message.
    this.retryAfter = metadata.retryAfter ?? null;
    this.requestId = metadata.requestId ?? envelope?.requestId ?? null;
    this.publicError = envelope ? { ...envelope,
      ...(this.requestId && !envelope.requestId ? { requestId: this.requestId } : {}),
      ...(this.retryAfter !== null ? { retryAfter: this.retryAfter } : {}),
    } : this.requestId || this.retryAfter !== null || this.serverMessage ? {
      code, ...(this.serverMessage ? { message: this.serverMessage } : {}),
      ...(this.details ? { details: this.details } : {}),
      ...(this.requestId ? { requestId: this.requestId } : {}),
      ...(this.retryAfter !== null ? { retryAfter: this.retryAfter } : {}),
    } : null;
    this.exitCode = 2;
  }
}
