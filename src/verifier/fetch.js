// Compatibility facade: every verifier and installed-package consumer shares the same
// HTTP policy and error identity. Keep the legacy export names stable.
export { VerificationError, readBounded, PRODUCT_TOKEN, MAX_RETRY_AFTER_SECONDS,
  retryAfterSeconds, publicFetcher } from '../page-acquisition/http.js';
