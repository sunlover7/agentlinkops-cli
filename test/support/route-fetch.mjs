// Test preload: routes one public-looking hostname to a local fixture server so the CLI can be
// exercised end to end as a subprocess. The verifier refuses literal IPs and reserved suffixes
// by design, so a fixture page must be served under a name that passes the public URL screen.
// Responses are rebuilt so `response.url` stays empty; the verifier treats a changed URL as a
// redirect, which a routed fetch is not.
const host = process.env.AGENTLINKOPS_TEST_ROUTE_HOST;
const origin = process.env.AGENTLINKOPS_TEST_ROUTE_ORIGIN;
const realFetch = globalThis.fetch;
if (host && origin) {
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname !== host) return realFetch(input, init);
    const routed = new URL(url.pathname + url.search, origin);
    const response = await realFetch(routed, init);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
