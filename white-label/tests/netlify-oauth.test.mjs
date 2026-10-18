import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  NETLIFY_SITE, NETLIFY_CALLBACK, NETLIFY_EXCHANGE, NETLIFY_PROFILE,
  NETLIFY_FLOW_COOKIE, netlifyConfig, startNetlifyFlow, verifyNetlifyFlow,
  netlifyAuthorizationUrl, exchangeNetlifyCode, fetchNetlifyProfile, NetlifyAccessDenied,
} from "../netlify/functions/_lib/netlify-oauth.mjs";
import { netlifyTokenBinding } from "../netlify/functions/_lib/netlify-connection-store.mjs";
import { encryptTokens, decryptTokens } from "../netlify/functions/_lib/connection-vault.mjs";
import { createNetlifyStart } from "../netlify/functions/netlify-oauth-start.mjs";
import { createNetlifyCallback } from "../netlify/functions/netlify-oauth-callback.mjs";
import { createNetlifyStatus } from "../netlify/functions/netlify-oauth-status.mjs";

const key = randomBytes(32);
const session = { user_id: "supabase-owner-a", session_hash: "a".repeat(64), csrf_token: "csrf-test" };
const clientId = "test-netlify-client-id-1234567890123";
const secret = "test-client-secret-do-not-use-ever";

function withTestConfiguration(fn) {
  const keys = ["NETLIFY_OAUTH_CLIENT_ID", "NETLIFY_OAUTH_CLIENT_SECRET",
    "KLEANLY_OAUTH_ENCRYPTION_KEY", "KLEANLY_PERMANENT_OAUTH_ENABLED"];
  const originals = keys.map(key => process.env[key]);
  process.env.NETLIFY_OAUTH_CLIENT_ID = clientId;
  process.env.NETLIFY_OAUTH_CLIENT_SECRET = secret;
  process.env.KLEANLY_OAUTH_ENCRYPTION_KEY = key.toString("base64url");
  process.env.KLEANLY_PERMANENT_OAUTH_ENABLED = "true";
  return Promise.resolve().then(fn).finally(() => {
    keys.forEach((name, i) => {
      if (originals[i] === undefined) delete process.env[name];
      else process.env[name] = originals[i];
    });
  });
}

test("Netlify OAuth state has entropy, expiry and binds to this portal session", () => {
  const now = 1_800_000_000_000;
  const flow = startNetlifyFlow(session.session_hash, key, now);
  assert.match(flow.state, /^[\w-]{43}$/);
  assert.equal(verifyNetlifyFlow(flow.cookieValue, flow.state, session.session_hash, key, now + 1000), true);
  assert.equal(verifyNetlifyFlow(flow.cookieValue, flow.state, "b".repeat(64), key, now + 1000), false);
  assert.equal(verifyNetlifyFlow(flow.cookieValue, "b".repeat(43), session.session_hash, key, now + 1000), false);
  assert.equal(verifyNetlifyFlow(flow.cookieValue, flow.state, session.session_hash, randomBytes(32), now + 1000), false);
  assert.equal(verifyNetlifyFlow(flow.cookieValue, flow.state, session.session_hash, key, now + 601000), false);
  const url = new URL(netlifyAuthorizationUrl(clientId, flow.state));
  assert.equal(url.origin, "https://app.netlify.com");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("state"), flow.state);
  assert.equal(url.searchParams.get("redirect_uri"), NETLIFY_CALLBACK);
});

test("Netlify config never needs a secret in the browser", () => {
  assert.equal(netlifyConfig(() => "").ready, false);
  assert.equal(netlifyConfig(name => name.endsWith("_CLIENT_ID") ? clientId : secret).ready, true);
});

test("Netlify code exchange is server-side and validates token response", async () => {
  const token = await exchangeNetlifyCode("code-example-xyz", {clientId,clientSecret:secret}, async (url, opts) => {
    assert.equal(url, NETLIFY_EXCHANGE);
    assert.equal(opts.method, "POST");
    const body = new URLSearchParams(opts.body);
    assert.equal(body.get("client_id"), clientId);
    assert.equal(body.get("client_secret"), secret);
    assert.equal(body.get("redirect_uri"), NETLIFY_CALLBACK);
    assert.equal(body.get("grant_type"), "authorization_code");
    return Response.json({ access_token: "provider-token-should-be-private" });
  });
  assert.equal(token, "provider-token-should-be-private");
  await assert.rejects(() => exchangeNetlifyCode("code", {clientId,clientSecret:secret},
    async () => Response.json({ token: "unsupported" })));
});

test("Netlify identity comes only from Netlify /user, never from email input", async () => {
  const got = await fetchNetlifyProfile("private-oauth-token", async (url, opts) => {
    assert.equal(url, NETLIFY_PROFILE);
    assert.equal(opts.headers.Authorization, "Bearer private-oauth-token");
    return Response.json({ id: "netlify-user-123", email: "other-account@example.org" });
  });
  assert.deepEqual(got, { netlifyUserId: "netlify-user-123", email: "other-account@example.org" });
  await assert.rejects(() => fetchNetlifyProfile("private-oauth-token",
    async () => new Response("", {status: 401})), NetlifyAccessDenied);
  await assert.rejects(() => fetchNetlifyProfile("private-oauth-token",
    async () => Response.json({email: "anonymous@example.org"})));
});

test("Netlify and Supabase grant encryption bindings are different", () => {
  const binding = netlifyTokenBinding(session.user_id, "netlify-user-123");
  const sealed = encryptTokens({accessToken:"private-oauth-token"}, binding, key);
  assert.doesNotMatch(sealed, /private-oauth-token/);
  assert.deepEqual(decryptTokens(sealed, binding, key), {accessToken:"private-oauth-token"});
  assert.throws(() => decryptTokens(sealed, netlifyTokenBinding("other-user", "netlify-user-123"), key));
  assert.throws(() => decryptTokens(sealed, netlifyTokenBinding(session.user_id, "other-account"), key));
});

test("staging flow rejects missing portal session and bad state before token exchange", async () => {
  await withTestConfiguration(async () => {
    const start = createNetlifyStart({getSession: async () => session});
    const res = await start(new Request(NETLIFY_SITE + "/.netlify/functions/netlify-oauth-start"));
    assert.equal(res.status, 302);
    assert.match(res.headers.get("location"), /^https:\/\/app\.netlify\.com\/authorize/);
    const state = new URL(res.headers.get("location")).searchParams.get("state");
    const cookie = res.headers.getSetCookie().find(x => x.startsWith(NETLIFY_FLOW_COOKIE + "=")).split(";")[0];
    assert.match(res.headers.getSetCookie().join(" "), /HttpOnly; Secure; SameSite=Lax/);
    let exchanges = 0, writes = 0;
    const cb = createNetlifyCallback({
      getSession: async () => session,
      exchange: async () => { exchanges++; return "private-oauth-token"; },
      getProfile: async () => ({netlifyUserId:"netlify-user-123",email:"test@example.org"}),
      persist: async () => { writes++; },
    });
    const bad = await cb(new Request(NETLIFY_CALLBACK + "?code=correct-code&state=wrong", {
      headers: { Cookie: cookie },
    }));
    assert.equal(bad.status, 303);
    assert.match(bad.headers.get("location"), /expired_or_invalid/);
    assert.equal(exchanges, 0);
    const good = await cb(new Request(NETLIFY_CALLBACK + "?code=correct-code&state=" + state, {
      headers: { Cookie: cookie },
    }));
    assert.equal(good.status, 303);
    assert.match(good.headers.get("location"), /netlify_result=connected/);
    assert.equal(exchanges, 1);
    assert.equal(writes, 1);
    assert.doesNotMatch(good.headers.get("location") + good.headers.getSetCookie().join(" "),
      /private-oauth-token|test@example.org|correct-code/);
    const noLogin = await createNetlifyStart({getSession: async () => null})(
      new Request(NETLIFY_SITE + "/.netlify/functions/netlify-oauth-start"));
    assert.match(noLogin.headers.get("location"), /signin_required/);
    const differentLogin = await createNetlifyCallback({
      getSession: async () => ({...session,session_hash:"b".repeat(64)}),
      exchange: async () => {throw new Error("Must not exchange");},
    })(new Request(NETLIFY_CALLBACK + "?code=correct-code&state=" + state,{headers:{Cookie:cookie}}));
    assert.match(differentLogin.headers.get("location"), /expired_or_invalid/);
  });
});

test("Netlify status cannot claim connection from arbitrary query params", async () => {
  await withTestConfiguration(async () => {
    const handler = createNetlifyStatus({
      getSession: async () => session,
      getConnection: async () => null,
    });
    const status = await handler(new Request(NETLIFY_SITE + "?netlify_result=connected"));
    const body = await status.json();
    assert.equal(body.connected, false);
    assert.equal(body.configured, true);
    assert.equal(body.installationsCreated, false);
    assert.equal(body.identity, null);
  });
});
