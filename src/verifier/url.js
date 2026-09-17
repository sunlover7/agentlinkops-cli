const RESERVED_SUFFIXES = [
  'localhost', 'local', 'internal', 'intranet', 'lan', 'home', 'home.arpa',
  'test', 'invalid', 'example', 'onion', 'alt', 'arpa',
];

/** Lexical screening only. A public-only fetch transport MUST also prevent DNS rebinding. */
export function validatePublicUrl(input) {
  if (typeof input !== 'string' || input.length > 8192 || /[\u0000-\u0020\u007f\\]/u.test(input)) {
    return { valid: false, reason: 'invalid_url' };
  }
  let url;
  try { url = new URL(input); } catch { return { valid: false, reason: 'invalid_url' }; }
  if (!['http:', 'https:'].includes(url.protocol)) return { valid: false, reason: 'unsupported_protocol' };
  if (url.username || url.password) return { valid: false, reason: 'url_credentials' };
  if (url.port) return { valid: false, reason: 'unsupported_port' };
  // URL canonicalization expands hexadecimal, octal and integer IPv4 spellings.
  // No literal IPs are a supported publisher target, even globally routable ones.
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (hostname.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    return { valid: false, reason: 'ip_literal_not_supported' };
  }
  if (hostname.length > 253 || !hostname.includes('.') || hostname.split('.').some(
    (label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
  )) return { valid: false, reason: 'non_public_hostname' };
  if (RESERVED_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`))) {
    return { valid: false, reason: 'non_public_hostname' };
  }
  url.hostname = hostname;
  url.hash = '';
  return { valid: true, url: url.href, hostname };
}

export function matchesTarget(candidate, target, scope) {
  const found = new URL(candidate);
  const wanted = new URL(target);
  found.hostname = found.hostname.toLowerCase().replace(/\.$/, '');
  wanted.hostname = wanted.hostname.toLowerCase().replace(/\.$/, '');
  switch (scope) {
    case 'domain':
      return found.hostname === wanted.hostname || found.hostname.endsWith(`.${wanted.hostname}`);
    case 'subdomain':
      return found.hostname === wanted.hostname;
    case 'path': {
      const prefix = wanted.pathname.endsWith('/') ? wanted.pathname : `${wanted.pathname}/`;
      return found.origin === wanted.origin
        && (found.pathname === wanted.pathname || found.pathname.startsWith(prefix))
        && (!wanted.search || found.search === wanted.search);
    }
    case 'exact':
      found.hash = '';
      wanted.hash = '';
      return found.href === wanted.href;
    default:
      return false;
  }
}
