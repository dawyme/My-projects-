/**
 * Shared HTTP transport for API and feed connectors.
 *
 * Uses the platform's global fetch (Node 18+). Adds:
 *   • hard timeouts (a hung supplier must never hang a sync job)
 *   • bounded retries with jittered backoff on 429/5xx and network errors
 *   • response-size caps
 *   • secret redaction on every error message before it is persisted
 */
const { SupplierConnectorError } = require('./connectors/base');
const { redactString } = require('./credentials');

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildUrl(baseUrl, path, query) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const suffix = String(path || '').replace(/^\/+/, '');
  const url = suffix ? `${base}/${suffix}` : base;
  const out = new URL(url);
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === '') continue;
    out.searchParams.set(k, String(v));
  }
  return out.toString();
}

/**
 * Performs an HTTP request with timeout + retry.
 * @returns {{status:number, ok:boolean, headers:Headers, body:string, json:any, latencyMs:number}}
 */
async function httpRequest(url, {
  method = 'GET', headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS,
  retries = 2, backoffMs = 500, secrets = [], expect = 'auto',
} = {}) {
  let lastError = null;
  const attempts = Math.max(1, retries + 1);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : (typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)),
        signal: controller.signal,
        redirect: 'follow',
      });
      clearTimeout(timer);
      const latencyMs = Date.now() - started;

      const contentLength = Number(res.headers.get('content-length') || 0);
      if (contentLength > MAX_RESPONSE_BYTES) {
        throw new SupplierConnectorError(`Supplier response too large (${contentLength} bytes)`, { code: 'RESPONSE_TOO_LARGE', status: res.status });
      }
      const text = await res.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
        throw new SupplierConnectorError('Supplier response too large', { code: 'RESPONSE_TOO_LARGE', status: res.status });
      }

      let json = null;
      if (expect === 'json' || (expect === 'auto' && /json/i.test(res.headers.get('content-type') || ''))) {
        try { json = JSON.parse(text); } catch (e) {
          throw new SupplierConnectorError(`Supplier returned invalid JSON: ${e.message}`, { code: 'INVALID_JSON', status: res.status });
        }
      }

      if (!res.ok) {
        const detail = (json && (json.message || json.error || json.detail)) || text.slice(0, 200);
        const retryable = res.status === 429 || res.status >= 500;
        if (retryable && attempt < attempts) {
          lastError = new SupplierConnectorError(
            redactString(`Supplier returned ${res.status}: ${detail}`, secrets),
            { code: 'HTTP_STATUS', status: res.status }
          );
          await sleep(backoffMs * attempt + Math.floor(Math.random() * 150));
          continue;
        }
        throw new SupplierConnectorError(
          redactString(`Supplier returned HTTP ${res.status}: ${detail}`, secrets),
          { code: 'HTTP_STATUS', status: res.status }
        );
      }

      return { status: res.status, ok: true, headers: res.headers, body: text, json, latencyMs };
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof SupplierConnectorError) {
        if (attempt >= attempts) throw err;
        lastError = err;
        await sleep(backoffMs * attempt);
        continue;
      }
      const message = err.name === 'AbortError'
        ? `Supplier request timed out after ${timeoutMs}ms`
        : redactString(`Supplier request failed: ${err.message}`, secrets);
      lastError = new SupplierConnectorError(message, { code: err.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK' });
      if (attempt >= attempts) break;
      await sleep(backoffMs * attempt + Math.floor(Math.random() * 150));
    }
  }
  throw lastError || new SupplierConnectorError('Supplier request failed', { code: 'NETWORK' });
}

/** Rejects URLs that would make the server talk to itself or the LAN. */
const BLOCKED_HOSTS = /^(localhost|127\.|0\.0\.0\.0|::1|\[::1\]|169\.254\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|metadata\.google\.internal|169\.254\.169\.254)/i;

/**
 * Explicit opt-in for private / loopback supplier hosts.
 *
 * Some suppliers are reached over a VPN, a leased line or an on-premise
 * appliance with a private address, and test environments run the supplier
 * stub on localhost. Set SUPPLIER_ALLOWED_HOSTS to a comma-separated list of
 * exact hostnames to permit them; SSRF protection stays on for everything
 * else. Cloud metadata addresses are never permitted.
 */
const NEVER_ALLOWED = /^(169\.254\.169\.254|metadata\.google\.internal|metadata|fd00:ec2::254)$/i;

function allowedPrivateHosts() {
  return String(process.env.SUPPLIER_ALLOWED_HOSTS || '')
    .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
}

function assertPublicUrl(rawUrl) {
  let url;
  try { url = new URL(String(rawUrl)); } catch { throw new SupplierConnectorError('Supplier URL is not valid', { code: 'INVALID_URL' }); }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new SupplierConnectorError('Supplier URL must use http or https', { code: 'INVALID_URL' });
  }
  const host = url.hostname.toLowerCase();
  if (NEVER_ALLOWED.test(host)) {
    throw new SupplierConnectorError('Supplier URL may not point at a cloud metadata address', { code: 'SSRF_BLOCKED' });
  }
  if (BLOCKED_HOSTS.test(host) && !allowedPrivateHosts().includes(host)) {
    throw new SupplierConnectorError(
      'Supplier URL may not point at a private or link-local address (add the host to SUPPLIER_ALLOWED_HOSTS to allow it)',
      { code: 'SSRF_BLOCKED' }
    );
  }
  return url.toString();
}

module.exports = { httpRequest, buildUrl, assertPublicUrl, allowedPrivateHosts, DEFAULT_TIMEOUT_MS };
