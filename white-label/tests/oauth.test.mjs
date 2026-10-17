import test from "node:test";
import assert from "node:assert/strict";
import {
  newFlow, flowVerifier, authorizationUrl, readCookie, verifiedValue, verifiedExpires,
  FLOW_COOKIE, VERIFIED_COOKIE, CALLBACK_URL, TOKEN_URL,
} from "../netlify/functions/_lib/supabase-oauth.mjs";
import start from "../netlify/functions/supabase-oauth-start.mjs";
import callback from "../netlify/functions/supabase-oauth-callback.mjs";
import status from "../netlify/functions/supabase-oauth-status.mjs";

const clientId = "a3ff2237-4e0a-41de-982f-079176f54599";
const testSecret = "fake_unit_test_secret_0123456789";

test("PKCE flow and state have adequate entropy and expire", () => {
  const flow = newFlow(1_800_000_000_000);
  assert.match(flow.state, /^[\w-]{43}$/);
  assert.match(flow.verifier, /^[\w-]{43}$/);
  assert.equal(flowVerifier(flow.cookieValue, flow.state, 1_800_000_000_200), flow.verifier);
  assert.equal(flowVerifier(flow.cookieValue, "a".repeat(43), 1_800_000_000_200), null);
  assert.equal(flowVerifier(flow.cookieValue, flow.state, 1_800_000_601_000), null);
  const url = new URL(authorizationUrl(clientId, flow));
  assert.equal(url.origin, "https://api.supabase.com");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), flow.state);
  assert.equal(url.searchParams.get("redirect_uri"), CALLBACK_URL);
});

test("signed verification cookie cannot be forged or replayed after expiry", () => {
  const now = 1_800_000_000_000;
  const signed = verifiedValue(testSecret, now);
  assert.equal(verifiedExpires(signed, testSecret, now), Math.floor(now / 1000) + 900);
  assert.equal(verifiedExpires(signed, "different secret", now), null);
  assert.equal(verifiedExpires(signed, testSecret, now + 901_000), null);
  assert.equal(verifiedExpires(signed.slice(0, -1) + "A", testSecret, now), null);
  assert.equal(readCookie("foo=bar; " + VERIFIED_COOKIE + "=" + signed, VERIFIED_COOKIE), signed);
});

test("start rejects incomplete server configuration", async () => {
  const previousId = process.env.SUPABASE_OAUTH_CLIENT_ID;
  const previousSecret = process.env.SUPABASE_OAUTH_CLIENT_SECRET;
  try {
    process.env.SUPABASE_OAUTH_CLIENT_ID = clientId;
    delete process.env.SUPABASE_OAUTH_CLIENT_SECRET;
    const response = await start(new Request("https://example.com/.netlify/functions/supabase-oauth-start"));
    assert.equal(response.status, 303);
    assert.match(response.headers.get("location"), /configuration_required/);
  } finally {
    if (previousId === undefined) delete process.env.SUPABASE_OAUTH_CLIENT_ID;
    else process.env.SUPABASE_OAUTH_CLIENT_ID = previousId;
    if (previousSecret === undefined) delete process.env.SUPABASE_OAUTH_CLIENT_SECRET;
    else process.env.SUPABASE_OAUTH_CLIENT_SECRET = previousSecret;
  }
});

test("callback checks state, exchanges server-side and never persists OAuth tokens", async () => {
  const oldId = process.env.SUPABASE_OAUTH_CLIENT_ID;
  const oldSecret = process.env.SUPABASE_OAUTH_CLIENT_SECRET;
  const oldFetch = globalThis.fetch;
  process.env.SUPABASE_OAUTH_CLIENT_ID = clientId;
  process.env.SUPABASE_OAUTH_CLIENT_SECRET = testSecret;
  const token = "example-access-token-never-saved";
  try {
    const initial = await start(new Request("https://example.com/.netlify/functions/supabase-oauth-start"));
    assert.equal(initial.status, 302);
    const location = new URL(initial.headers.get("location"));
    const state = location.searchParams.get("state");
    const flowCookie = initial.headers.getSetCookie().find((s) => s.startsWith(FLOW_COOKIE + "=")).split(";")[0];
    const invalid = await callback(new Request(CALLBACK_URL + "?code=valid-code-123&state=bad", { headers: { Cookie: flowCookie } }));
    assert.match(invalid.headers.get("location"), /expired_or_invalid/);
    let exchangeCount = 0;
    globalThis.fetch = async (url, options) => {
      exchangeCount++;
      assert.equal(url, TOKEN_URL);
      assert.equal(options.method, "POST");
      assert.equal(new URLSearchParams(options.body).get("redirect_uri"), CALLBACK_URL);
      assert.match(options.headers.Authorization, /^Basic /);
      return new Response(JSON.stringify({ access_token: token, refresh_token: "refresh-should-never-be-stored" }), {
        status: 200, headers: { "content-type": "application/json" }
      });
    };
    const response = await callback(new Request(CALLBACK_URL + "?code=valid-code-123&state=" + state, { headers: { Cookie: flowCookie } }));
    assert.equal(exchangeCount, 1);
    assert.equal(response.status, 303);
    assert.match(response.headers.get("location"), /supabase_test=verified/);
    assert.doesNotMatch(response.headers.get("location") + response.headers.getSetCookie().join(" "), /example-access-token|refresh-should-never-be-stored/);
    const verifiedCookie = response.headers.getSetCookie().find((s) => s.startsWith(VERIFIED_COOKIE + "=")).split(";")[0];
    const check = await status(new Request("https://example.com/.netlify/functions/supabase-oauth-status", { headers: { Cookie: verifiedCookie } }));
    const result = await check.json();
    assert.equal(result.configured, true);
    assert.equal(result.verified, true);
    assert.equal(result.tokensStored, false);
    assert.equal(result.installationsCreated, false);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldId === undefined) delete process.env.SUPABASE_OAUTH_CLIENT_ID;
    else process.env.SUPABASE_OAUTH_CLIENT_ID = oldId;
    if (oldSecret === undefined) delete process.env.SUPABASE_OAUTH_CLIENT_SECRET;
    else process.env.SUPABASE_OAUTH_CLIENT_SECRET = oldSecret;
  }
});
