// Safety helpers for capture.mjs, which loads pages the user did not write. Node built-ins only.
//  1. Network policy (SSRF): a captured page must not be able to make this machine call loopback, LAN, link-local or
//     cloud-metadata addresses, or non-web schemes, unless the request goes to the capture target's own host. Enforced
//     for the page's own requests (Playwright route) and for the downloads Node makes on the page's behalf (get()).
//  2. Credential hygiene: userinfo and secret-looking query values never reach logs, manifest.json or studio.json.
// Three layers, because Playwright's route sees only part of what Chrome sends: the route judges the first URL of every
// page request; a per-page DevTools session judges redirect hops; a browser-wide DevTools session judges every http(s)
// request of every target, including the ones a route never sees (SharedWorker, <link rel=prerender>).
// Residual risk [measured, Chrome 154]: speculation rules (<script type="speculationrules"> prefetch and prerender) are sent by
// the browser process and reach no DevTools session, so a page that declares them can still make Chrome GET a refused
// address; capture.mjs notes that in the manifest. UDP (WebRTC) and bare TCP preconnects are not filtered either.
// Residual risk [assumption]: the address check and Chrome's own DNS lookup are two lookups, so a DNS-rebinding server
// that answers them differently can still slip past a hostname check. Literal IPs, localhost names and every name that
// resolves to a private address at check time are refused.
import dns from 'node:dns';
import net from 'node:net';

// ---- addresses ------------------------------------------------------------------------------------------------

const BLOCKED = new net.BlockList();
for (const [addr, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]]) BLOCKED.addSubnet(addr, bits, 'ipv4'); // 224/3 = multicast + reserved + broadcast
for (const [addr, bits] of [['::', 96], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['2002::', 16], ['2001::', 32]]) {
  BLOCKED.addSubnet(addr, bits, 'ipv6'); // ::/96 = unspecified, loopback, v4-compatible; fc00::/7 ULA; fe80::/10 link-local; NAT64, 6to4 and Teredo embed a v4 address
}
// BlockList maps IPv4-mapped IPv6 (::ffff:127.0.0.1) onto the IPv4 rules.

/** True for loopback, private (RFC 1918), CGNAT, link-local (169.254/16 incl. cloud metadata), IPv6 ULA/link-local, multicast and reserved addresses. Anything that is not an IP is refused too. */
export function isPrivateAddress(ip) {
  const s = String(ip).replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const family = net.isIP(s);
  return family === 0 ? true : BLOCKED.check(s, family === 4 ? 'ipv4' : 'ipv6');
}

// Names that mean "this machine" or a cloud metadata service without needing DNS (RFC 6761 for localhost).
const LOCAL_NAME = /(^|\.)localhost$|^metadata\.google\.internal$|^metadata$|^instance-data(\.|$)/;

export const defaultLookup = (host) => dns.promises.lookup(host, { all: true, verbatim: true });

const WEB_FREE = new Set(['data:', 'blob:', 'about:']); // never touch the network
const size = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.ceil(n / 1024))} KB`);

/**
 * A request policy for one capture. `target` is the URL being captured: requests to its host (host:port) are always
 * allowed, so capturing a local dev server or an intranet page works. `allowPrivate` lifts the address checks only;
 * schemes other than http(s), data:, blob: and about: stay refused.
 * `lookup(host)` returns [{ address }] (dns.promises.lookup with all:true); tests inject a fake.
 * `credentials` ({ username, password, origin }) are answered for HTTP auth challenges of that origin (see watch()).
 */
export function createGuard({ target, allowPrivate = false, lookup = defaultLookup, credentials = null } = {}) {
  let own = '';
  try { own = new URL(target).host.toLowerCase(); } catch { /* no target: every private address is refused */ }
  const cache = new Map(); // hostname -> Promise<string[] | null>  (null = not resolvable here)
  const known = new Map(); // hostname -> string[]  (settled results, for the synchronous WebSocket check)
  const blocked = []; // { url, reason } with credentials removed
  const unresolved = new Set();
  const unfiltered = []; // notes about layers that could not be started

  const resolve = (host) => {
    if (!cache.has(host)) {
      cache.set(host, Promise.resolve().then(() => lookup(host)).then((r) => {
        const addrs = (Array.isArray(r) ? r : [r]).map((x) => (typeof x === 'string' ? x : x.address));
        known.set(host, addrs);
        return addrs;
      }, () => null));
    }
    return cache.get(host);
  };
  const deny = (url, reason) => {
    const shown = redactUrl(url).slice(0, 200);
    if (!blocked.some((b) => b.url === shown && b.reason === reason)) blocked.push({ url: shown, reason });
    return { ok: false, reason };
  };
  const hostOf = (u) => u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();

  /** { ok: true } or { ok: false, reason } for one URL; every refusal is recorded in `blocked`. */
  async function check(raw) {
    let u;
    try { u = new URL(raw); } catch { return deny(String(raw), 'not a valid URL'); }
    if (WEB_FREE.has(u.protocol)) return { ok: true };
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return deny(raw, `${u.protocol} requests are not allowed`);
    if (allowPrivate || u.host.toLowerCase() === own) return { ok: true };
    const host = hostOf(u);
    if (net.isIP(host)) return isPrivateAddress(host) ? deny(raw, `${host} is a private, local or link-local address`) : { ok: true };
    if (LOCAL_NAME.test(host)) return deny(raw, `${host} is a local name`);
    const addrs = await resolve(host);
    if (!addrs) { unresolved.add(host); return { ok: true }; } // nothing to connect to from here; a proxy may resolve it
    const bad = addrs.find(isPrivateAddress);
    return bad ? deny(raw, `${host} resolves to the private address ${bad}`) : { ok: true };
  }

  /** Synchronous subset of check() for WebSocket URLs (Playwright's predicate cannot await): literal IPs, local names and hosts already resolved. */
  function blocksSync(raw) {
    let u;
    try { u = new URL(raw); } catch { return true; }
    const web = u.protocol === 'ws:' || u.protocol === 'wss:' || u.protocol === 'http:' || u.protocol === 'https:';
    if (!web) return true;
    if (allowPrivate || u.host.toLowerCase() === own) return false;
    const host = hostOf(u);
    if (net.isIP(host)) return isPrivateAddress(host);
    if (LOCAL_NAME.test(host)) return true;
    return (known.get(host) || []).some(isPrivateAddress);
  }

  /**
   * GET a URL from Node (Playwright's request context: browser cookies, proxy and credentials) with every hop checked.
   * Redirects are followed by hand, at most `maxRedirects`, so a public URL cannot bounce the request to an internal one.
   * A declared Content-Length above `maxBytes` is refused before the body is read.
   * @returns {Promise<{ ok: true, url: string, status: number, headers: object, body: Buffer } | { ok: false, reason: string }>}
   */
  async function get(context, url, { timeout = 15000, headers, maxBytes = Infinity, maxRedirects = 5 } = {}) {
    let cur = url;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const verdict = await check(cur);
      if (!verdict.ok) return { ok: false, reason: `blocked: ${verdict.reason}` };
      let res;
      try { res = await context.request.get(cur, { timeout, headers, maxRedirects: 0 }); } catch { return { ok: false, reason: 'download failed' }; }
      const status = res.status();
      const h = res.headers();
      if (status >= 300 && status < 400 && h.location) {
        try { cur = new URL(h.location, cur).href; } catch { return { ok: false, reason: 'bad redirect target' }; }
        continue;
      }
      if (status < 200 || status >= 300) return { ok: false, reason: `HTTP ${status}` };
      const declared = Number(h['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, reason: `${size(declared)} is over the ${size(maxBytes)} limit` };
      const body = await res.body().catch(() => null);
      if (!body) return { ok: false, reason: 'download failed' };
      if (body.length > maxBytes) return { ok: false, reason: `${size(body.length)} is over the ${size(maxBytes)} limit` };
      return { ok: true, url: cur, status, headers: h, body };
    }
    return { ok: false, reason: `more than ${maxRedirects} redirects` };
  }

  const escaped = []; // redirect hops that got a response although the policy refuses them: { url, reason }
  const pending = [];
  const watched = new Map(); // page -> Promise, one DevTools session per page

  /**
   * Route every request of a browser context through check(): refused ones are aborted, and so are WebSockets to private hosts.
   * Playwright's route only sees the first URL of a request: Chromium follows redirects by itself and Playwright continues
   * every hop unseen. Those hops are handled by watch() (prevention) and the response listener below (detection).
   */
  async function protect(context) {
    await context.route('**/*', async (route) => {
      let verdict;
      try { verdict = await check(route.request().url()); } catch { verdict = { ok: false }; } // fail closed
      if (verdict.ok) await route.continue().catch(() => {});
      else await route.abort('blockedbyclient').catch(() => {});
    });
    if (typeof context.routeWebSocket === 'function') {
      await context.routeWebSocket((u) => blocksSync(u.href), (ws) => { blocked.push({ url: redactUrl(ws.url()).slice(0, 200), reason: 'WebSocket to a private, local or link-local host' }); ws.close({ code: 1008, reason: 'blocked' }); });
    }
    context.on('response', (res) => { // a redirect hop that was answered: it reached its server, so it must have been allowed
      const req = res.request();
      if (!req.redirectedFrom()) return;
      pending.push(check(req.url()).then((v) => { if (!v.ok) escaped.push({ url: redactUrl(req.url()).slice(0, 200), reason: v.reason }); }, () => {}));
    });
    context.on('page', (page) => { watch(page).catch(() => {}); }); // popups
  }

  /**
   * Fails every redirect hop of a page (and of its cross-process iframes) that check() refuses. A second DevTools Fetch
   * session sees the hops (requestPaused with redirectedRequestId) that Playwright's route never gets; the session
   * continues everything else at once, since route() already judged the first URL of each request.
   */
  function watch(page) {
    if (!watched.has(page)) {
      watched.set(page, (async () => {
        const context = page.context();
        const arm = async (target) => {
          const cdp = await context.newCDPSession(target);
          cdp.on('Fetch.requestPaused', (ev) => { hop(cdp, ev).catch(() => {}); });
          // With two Fetch sessions on a page the browser hands an HTTP auth challenge to the innermost one, which cancels it unless
          // it answers itself; so this session answers for the target's origin, as Playwright's httpCredentials would.
          cdp.on('Fetch.authRequired', (ev) => { answerAuth(cdp, ev); });
          await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }], handleAuthRequests: true });
        };
        await arm(page);
        const armed = new WeakSet();
        page.on('framenavigated', (frame) => {
          if (frame === page.mainFrame() || armed.has(frame)) return;
          armed.add(frame);
          arm(frame).catch(() => armed.delete(frame)); // a same-process frame has no session of its own: the page's covers it
        });
      })());
    }
    return watched.get(page);
  }

  const authTried = new Set();
  function answerAuth(cdp, ev) {
    let sameOrigin = false;
    try { sameOrigin = !!credentials && new URL(ev.request.url).origin === credentials.origin; } catch { /* no credentials for this URL */ }
    const provide = sameOrigin && !authTried.has(ev.requestId); // one attempt per request: a wrong password must not loop
    authTried.add(ev.requestId);
    const authChallengeResponse = provide ? { response: 'ProvideCredentials', username: credentials.username, password: credentials.password } : { response: 'Default' };
    cdp.send('Fetch.continueWithAuth', { requestId: ev.requestId, authChallengeResponse }).catch(() => {});
  }

  async function hop(cdp, ev) {
    const send = (method, params) => cdp.send(method, { requestId: ev.requestId, ...params }).catch(() => {});
    if (!ev.redirectedRequestId) return send('Fetch.continueRequest');
    let ok = false;
    try { ok = (await check(ev.request.url)).ok; } catch { /* fail closed */ }
    return ok ? send('Fetch.continueRequest') : send('Fetch.failRequest', { errorReason: 'BlockedByClient' });
  }

  /**
   * A browser-wide DevTools Fetch session (Chromium): every http(s) request of every target passes check() before it is
   * sent. This is the layer that sees what Playwright's route does not: a SharedWorker's requests and <link rel=prerender>
   * reach the network without touching a route (measured on Chrome 154: both hit a loopback server with route + per-page
   * session in place). Other schemes (chrome-error:, blob:, data:) continue untouched so Chrome's own pages keep working.
   * Resolves true when the session is up; false (with a note) when this browser has no browser-level DevTools session.
   */
  async function protectBrowser(browser) {
    try {
      const cdp = await browser.newBrowserCDPSession();
      cdp.on('Fetch.requestPaused', (ev) => {
        const send = (method, params) => cdp.send(method, { requestId: ev.requestId, ...params }).catch(() => {});
        if (!/^https?:/i.test(ev.request.url)) { send('Fetch.continueRequest'); return; }
        check(ev.request.url).then((v) => v.ok, () => false) // fail closed
          .then((ok) => (ok ? send('Fetch.continueRequest') : send('Fetch.failRequest', { errorReason: 'BlockedByClient' })));
      });
      await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      return true;
    } catch (err) {
      unfiltered.push(`the browser-wide request filter could not start (${String(err.message).split('\n')[0]}); SharedWorker and <link rel=prerender> requests are not filtered`);
      return false;
    }
  }

  /** Waits for the checks of answered redirect hops; returns the ones that reached a refused address (empty when everything held). */
  async function settle() {
    await Promise.all(pending.splice(0));
    return escaped.slice();
  }

  /** Human notes for the manifest: what was refused, and what could not be checked. */
  function notes() {
    const out = [];
    if (blocked.length) {
      const first = blocked.slice(0, 3).map((b) => `${b.url} (${b.reason})`).join('; ');
      out.push(`blocked ${blocked.length} request(s) to private, local or non-web addresses: ${first}${blocked.length > 3 ? '; ...' : ''}. Pass --allow-private only when you trust the page.`);
    }
    if (unresolved.size) out.push(`${unresolved.size} host(s) could not be resolved from this machine, so their addresses were not checked (${[...unresolved].slice(0, 3).join(', ')}${unresolved.size > 3 ? ', ...' : ''})`);
    out.push(...unfiltered);
    return out;
  }

  return { check, get, protect, protectBrowser, watch, settle, blocksSync, notes, blocked, escaped, own, allowPrivate };
}

// ---- credentials ----------------------------------------------------------------------------------------------

export const SENSITIVE_WORDS = new Set(['token', 'tokens', 'secret', 'secrets', 'password', 'passwd', 'pass', 'pwd', 'passphrase', 'auth', 'authorization', 'authkey', 'sig', 'signature',
  'session', 'sessionid', 'sessid', 'sid', 'jwt', 'credential', 'credentials', 'bearer', 'otp', 'key', 'apikey', 'code', 'cookie', 'ticket', 'sas']);
export const SENSITIVE_TAIL = /(token|secret|password|passwd|passphrase|signature|apikey|sessionid|sessid|accesskey|secretkey|privatekey|credential)s?$/;

/** True for a query/fragment parameter name that usually carries a secret: token, access_token, apiKey, X-Amz-Signature, sig, password, session, code, ... */
export function isSensitiveParam(name) {
  const words = String(name).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.some((w) => SENSITIVE_WORDS.has(w)) || SENSITIVE_TAIL.test(words.join(''));
}

const decodeName = (s) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; } };

/** A URL as it may be logged and stored: no user:password@, and `***` for every secret-looking query or fragment value. Works on truncated URLs too. */
export function redactUrl(input) {
  return String(input)
    .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#\s]*@/i, '$1')
    .replace(/([?&#])([^=&#\s]*)=([^&#\s]*)/g, (m, sep, name) => (isSensitiveParam(decodeName(name)) ? `${sep}${name}=***` : m));
}

/** redactUrl() for every http(s) URL inside free text (notes, error messages). */
export const redactText = (text) => String(text).replace(/\bhttps?:\/\/[^\s"'<>`\\]+/gi, (m) => {
  const tail = /[.,;:!?)\]}]+$/.exec(m)?.[0] ?? ''; // sentence punctuation after a URL is not part of it
  return redactUrl(m.slice(0, m.length - tail.length)) + tail;
});

/** A copy of any JSON-like value with redactText() applied to every string. */
export function redactDeep(value) {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)]));
  return value;
}

/**
 * Splits a URL into what navigation needs and what may be shown.
 * url: without user:password@ (the credentials go to Playwright's httpCredentials, scoped to the origin);
 * display: url with secret query values replaced by ***.
 */
export function parseTarget(href) {
  const u = new URL(href);
  const decode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
  const credentials = u.username || u.password ? { username: decode(u.username), password: decode(u.password), origin: u.origin } : null;
  u.username = '';
  u.password = '';
  return { url: u.href, credentials, display: redactUrl(u.href), origin: u.origin };
}
