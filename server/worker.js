// Clients for the two Cloudflare Workers this server talks to (its only way into Cloudflare):
//   gateway: auth-gateway (auth-gateway/) checks logins against the shared users-db accounts
//   api:     deadair-api (worker/) stores Deadair's own data in the deadair-db D1 database
// Each has its own URL and secret, so neither credential opens the other.
function client(name, url, secret) {
  const base = String(url || '').replace(/\/+$/, '');
  return {
    configured: () => !!(base && secret),
    // POST to the Worker. Throws if it can't be reached or rejects the request.
    async call(route, body, { timeout = 15000 } = {}) {
      const res = await fetch(base + route, {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) {
        throw Object.assign(new Error(`${name} ${route} failed (${res.status}): ${data?.error || res.statusText}`), { status: res.status });
      }
      return data;
    },
  };
}

const gateway = client('auth-gateway', process.env.AUTH_GATEWAY_URL, process.env.AUTH_GATEWAY_SECRET);
const api = client('deadair-api', process.env.DEADAIR_API_URL, process.env.DEADAIR_API_SECRET);

module.exports = { gateway, api };
