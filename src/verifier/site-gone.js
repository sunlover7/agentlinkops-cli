// DP-0004-T26 "site gone": the page that hosted a link now shows a parked, for-sale, expired,
// default-server, placeholder or suspended page, or its hostname no longer exists. A gone site is
// not a removed link: the reason codes below keep it out of Missing, and the site may come back.
//
// The signatures are deliberately narrow. They run only on a complete page that has no link to the
// watched target, and every page signature also needs a small page (few links) that is not marked
// up as an article. A title rule must match the whole title, and "<hostname> is for sale" only the
// page's own hostname. Body phrases need more: a page with very little visible text, because a short
// post about buying expired domains or a host's outage can quote the same words. The expired and
// suspended phrases also need a second, confirming signal (a renewal or registrar line, a hosting
// provider line). Each rule names one strong, specific phrase or the parking/marketplace host a
// gone domain redirects to. Unknown pages stay unknown.

const MARKETPLACE_HOSTS = ['hugedomains.com', 'dan.com', 'afternic.com', 'sedo.com', 'buydomains.com', 'undeveloped.com',
  'atom.com', 'squadhelp.com', 'domainmarket.com', 'brandbucket.com', 'efty.com', 'domainagents.com', 'spaceship.com'];
const PARKING_HOSTS = ['sedoparking.com', 'parkingcrew.net', 'bodis.com', 'parklogic.com', 'above.com', 'parkingpage.namecheap.com',
  'domainparking.ru', 'skenzo.com', 'voodoo.com', 'dsparking.com'];
const SMALL_PAGE_LINKS = 40;
const SMALL_PAGE_BYTES = 400_000;
// A gone page's notice is a sentence or two; a short article is longer than this.
const NOTICE_WORDS = 150;

const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase().replace(/\.$/, ''); } catch { return ''; } };
const onHost = (host, list) => list.some((item) => host === item || host.endsWith(`.${item}`));
const sameSite = (a, b) => a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);

// Body phrases. Each is specific enough that an ordinary page rarely says it about itself.
const RULES = [
  ['site_gone_for_sale', /\b(?:this|the) domain(?: name)?(?: [a-z0-9.-]+\.[a-z]{2,})? (?:is|may be|might be) (?:available )?for sale\b|\bbuy this domain\b|\bmake an offer on this domain\b|\bthis domain is available for (?:purchase|sale)\b/i],
  ['site_gone_parked', /\bthis domain (?:has been|is) (?:registered and )?parked\b|\bparked (?:free|for free),? courtesy of\b|\bthis web ?page is parked\b/i],
  ['site_gone_expired', /\b(?:this|the) domain(?: name)?(?: [a-z0-9.-]+\.[a-z]{2,})? (?:has )?expired\b|\bdomain (?:name )?expired on\b|\bthis domain registration has expired\b/i],
  ['site_gone_suspended', /\bthis account has been suspended\b|\bthis (?:website|site) (?:has been|is) suspended\b|\baccount suspended\b.{0,200}\bcontact (?:your|the) hosting provider\b/is],
  ['site_gone_default_page', /\bif you see this page, the nginx web server is successfully installed\b|\bthis is the default welcome page used to test the correct operation of the apache2? server\b|\bthis page is used to test the proper operation of the apache http server\b|\bfuture home of something quite cool\b|\bthis is the default (?:web ?site|domain) page\b/i],
];
// The second signal the expired and suspended phrases need on the same page.
const CONFIRM = {
  site_gone_expired: /\brenew(?:al|ed|s)?\b|\bregistrar\b|\bredemption period\b|\bif you are the (?:owner|registrant)\b/i,
  site_gone_suspended: /\bcontact (?:your|the) (?:hosting provider|web ?host(?:ing provider)?|host|server administrator|administrator)\b|\bhosting account\b|\bcpanel\b|\bbilling\b/i,
};
// Article markup: a post or news page, never a registrar's or host's notice.
const ARTICLE = /<article\b|<meta\b[^>]*\bog:type\b[^>]*\barticle\b|<meta\b[^>]*\bcontent\s*=\s*["']?article\b[^>]*\bog:type\b|"@type"\s*:\s*"(?:Blog|News)?(?:Posting|Article)"/i;
const TITLES = [
  ['site_gone_default_page', /^(?:welcome to nginx!?|apache2 (?:ubuntu|debian) default page: it works|test page for the (?:apache http server|nginx http server).*|apache http server test page(?: powered by [a-z0-9 .-]+)?|iis windows server|iis\d* ?|it works!?|default web site page|domain default page|web server'?s default page)$/i],
  ['site_gone_suspended', /^(?:account suspended|website suspended|site suspended)$/i],
  ['site_gone_coming_soon', /^(?:coming soon|under construction|website coming soon|site coming soon|this site is under construction)$/i],
  // The whole title is the sale notice; a title that only starts with the phrase ("Website for
  // sale? How to value one") is an ordinary article. "<hostname> is for sale" is handled below,
  // because the hostname has to be the page's own.
  ['site_gone_for_sale', /^(?:this |the )?(?:domain|website)(?: name)? (?:is )?(?:now )?(?:available )?for sale[.!]?$/i],
  ['site_gone_expired', /^(?:this )?(?:expired domain|domain (?:name )?(?:has )?expired)[.!]?$/i],
];
// "<hostname> is for sale", the whole title, where the hostname is the page's own (source or final).
const HOST_FOR_SALE = /^((?:[a-z0-9-]+\.)+[a-z]{2,}) (?:is |may be )?(?:now )?(?:available )?for sale[.!]?$/i;
const bareHost = (host) => host.replace(/^www\./, '');

/**
 * The site-gone reason for a complete page without the watched link, or null.
 * `links` are the parsed page links; `redirects` are the source's own redirect hops.
 */
export function siteGoneReason({ html = '', title = '', links = [], sourceUrl, finalUrl, redirects = [] } = {}) {
  const start = hostOf(sourceUrl), end = hostOf(finalUrl || sourceUrl);
  // A gone domain often forwards to a marketplace listing or a parking lander on another site.
  if (start && end && !sameSite(start, end) && redirects.length) {
    if (onHost(end, MARKETPLACE_HOSTS)) return 'site_gone_for_sale';
    if (onHost(end, PARKING_HOSTS)) return 'site_gone_parked';
  }
  if (typeof html !== 'string' || !html || html.length > SMALL_PAGE_BYTES || links.length > SMALL_PAGE_LINKS) return null;
  // Parking providers serve their lander from their own script or frame host.
  if (/<(?:script|iframe)\b[^>]*\bsrc\s*=\s*["']?(?:https?:)?\/\/(?:[a-z0-9-]+\.)*(?:sedoparking\.com|parkingcrew\.net|bodis\.com|parklogic\.com)\b/i.test(html)) return 'site_gone_parked';
  // Titles and body phrases: never on a page marked up as an article (a post about a domain sale).
  if (ARTICLE.test(html)) return null;
  const heading = String(title ?? '').replace(/\s+/g, ' ').trim();
  for (const [reason, pattern] of TITLES) if (heading && pattern.test(heading)) return reason;
  const named = HOST_FOR_SALE.exec(heading)?.[1]?.toLowerCase();
  if (named && [start, end].some((host) => host && bareHost(host) === bareHost(named))) return 'site_gone_for_sale';
  // Body phrases: only on a notice-sized page.
  const text = html.replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  if (text.split(' ').filter(Boolean).length > NOTICE_WORDS) return null;
  for (const [reason, pattern] of RULES) if (pattern.test(text) && (!CONFIRM[reason] || CONFIRM[reason].test(text))) return reason;
  return null;
}

/**
 * Whether a hostname still exists, from one DNS-over-HTTPS question to a public resolver. Only an
 * authoritative NXDOMAIN answer (status 3) reads as gone; a timeout, SERVFAIL or any other answer is
 * "unknown", and the check keeps its original reason. The hostname is the only thing sent.
 */
export async function hostnameStatus(hostname, { fetch = globalThis.fetch, signal, deadlineAt, resolver = 'https://cloudflare-dns.com/dns-query', timeoutMs = 3000 } = {}) {
  if (typeof fetch !== 'function' || typeof hostname !== 'string' || !/^[a-z0-9.-]{1,253}$/i.test(hostname)) return { status: 'unknown' };
  // Never past the check's own window: the question gets what is left of it, at most timeoutMs.
  const budget = Math.min(timeoutMs, Number.isFinite(deadlineAt) ? deadlineAt - Date.now() : timeoutMs);
  if (signal?.aborted || !(budget > 0)) return { status: 'unknown' };
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal?.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, budget);
  try {
    const response = await fetch(`${resolver}?name=${encodeURIComponent(hostname)}&type=A`, { headers: { accept: 'application/dns-json' }, signal: controller.signal });
    if (!response.ok) return { status: 'unknown' };
    const answer = await response.json();
    const rcode = Number(answer?.Status);
    if (rcode === 3) return { status: 'nxdomain', rcode, resolver: new URL(resolver).hostname };
    if (rcode === 0) return { status: 'exists', rcode, resolver: new URL(resolver).hostname };
    return { status: 'unknown', rcode };
  } catch {
    return { status: 'unknown' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
}
