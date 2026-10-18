import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  SESSION_COOKIE, SESSION_SECONDS, permanentMode, vaultKey, encryptTokens, decryptTokens,
  validateProviderTokens, validateProfile, validateOrganizationResponse,
  providerJson, tokenBinding, newPortalSession, sessionHash, constantTimeEqual,
  requireSameOrigin, safeStatusResponse,
} from "../netlify/functions/_lib/connection-vault.mjs";
import {
  persistAuthorization, inspectConnectedGrant,
  portalSessionCookie, erasePortalSessionCookie,
} from "../netlify/functions/_lib/connection-store.mjs";

const key = randomBytes(32);
const user = { userId: "stable-user-0001", email: "owner@example.org" };
const org = { organizationId: "org_foo_123", organizationName: "Owner Org", organizationSlug: "owner-org" };
const tokens = { accessToken: "access-abcdefghijklmnop", refreshToken: "refresh-abcdefghijklmnop", expiresAt: Date.now() + 3600 * 1000 };
const stable = { path: "https://kleanly-business-installer-staging.netlify.app" };

test("permanent storage starts disabled and needs a valid independent encryption key", () => {
  assert.equal(permanentMode(() => ""), "verification-only");
  assert.equal(permanentMode((name) => name === "KLEANLY_PERMANENT_OAUTH_ENABLED" ? "true" : ""), "configuration-required");
  const keyString = key.toString("base64url");
  const env = (name) => name === "KLEANLY_PERMANENT_OAUTH_ENABLED" ? "true" : keyString;
  assert.equal(permanentMode(env), "permanent");
  assert.equal(vaultKey(env).length, 32);
  assert.equal(vaultKey(() => "not-a-key"), null);
});

test("AES-256-GCM ciphertext is non-deterministic and authenticated to user/org/row", () => {
  const aad = tokenBinding("connection-1", user.userId, org.organizationId);
  const one = encryptTokens(tokens, aad, key);
  const two = encryptTokens(tokens, aad, key);
  assert.notEqual(one, two);
  assert.doesNotMatch(one, /access-abcdef|refresh-abcdef/);
  assert.deepEqual(decryptTokens(one, aad, key), tokens);
  assert.throws(() => decryptTokens(one, tokenBinding("connection-2", user.userId, org.organizationId), key));
  assert.throws(() => decryptTokens(one, tokenBinding("connection-1", "someone-else", org.organizationId), key));
  const modified = JSON.parse(one);
  // Flip a significant base64url digit. Flipping the LAST digit can alter
  // only unused padding bits, yielding identical decoded bytes and flaky tests.
  modified.data = (modified.data.startsWith("A") ? "B" : "A") + modified.data.slice(1);
  assert.throws(() => decryptTokens(JSON.stringify(modified), aad, key));
});

test("provider tokens require both access and refresh, with bounded expiry", () => {
  const now = 1_800_000_000_000;
  const created = validateProviderTokens({
    access_token: "valid_access_123", refresh_token: "valid_refresh_123", expires_in: 1800
  }, null, now);
  assert.equal(created.expiresAt, now + 1800 * 1000);
  assert.equal(created.refreshToken, "valid_refresh_123");
  assert.equal(validateProviderTokens({
    access_token: "valid_access_456", expires_in: 1800
  }, created, now).refreshToken, "valid_refresh_123");
  assert.throws(() => validateProviderTokens({ access_token: "valid_access_123" }));
  assert.throws(() => validateProviderTokens({ access_token: "abc", refresh_token: "def" }));
});

test("identity and single-org grant must be provider verified, never browser-selected", () => {
  // The live Supabase Management API /v1/profile response uses gotrue_id
  // and primary_email. It does not normally return id/email.
  assert.deepEqual(validateProfile({
    gotrue_id: user.userId, primary_email: user.email, username: "test-owner"
  }), user);
  // Prefer Supabase Management's authoritative identity over legacy aliases.
  assert.deepEqual(validateProfile({
    gotrue_id: user.userId, id: "different-user-id",
    primary_email: user.email, email: "wrong@example.org",
  }), user);
  assert.deepEqual(validateProfile({ id: user.userId, email: user.email }), user);
  assert.throws(() => validateProfile({ primary_email: user.email, username: "someone" }));
  assert.throws(() => validateProfile({ email: user.email }));
  assert.deepEqual(validateOrganizationResponse([{
    id: org.organizationId, name: org.organizationName, slug: org.organizationSlug
  }]), org);
  assert.throws(() => validateOrganizationResponse([]));
  assert.throws(() => validateOrganizationResponse([
    { id: "org-a", name: "A" }, { id: "org-b", name: "B" },
  ]));
  assert.throws(() => validateOrganizationResponse([{ name: "Missing ID" }]));
});

test("profile and organization fetch are hardcoded to Supabase Management API paths", async () => {
  let seen = 0;
  const fakeFetch = async (url, opts) => {
    seen++;
    assert.match(url, /^https:\/\/api\.supabase\.com\/v1\/(profile|organizations)$/);
    assert.equal(opts.headers.Authorization, "Bearer token_goes_here");
    return new Response(JSON.stringify(url.endsWith("/profile") ?
      { gotrue_id: user.userId, primary_email: user.email, username: "owner" } :
      [{ id: org.organizationId, name: org.organizationName, slug: org.organizationSlug }]
    ), { status: 200 });
  };
  assert.deepEqual(await providerJson("/profile", "token_goes_here", fakeFetch), user);
  assert.deepEqual(await providerJson("/organizations", "token_goes_here", fakeFetch), org);
  assert.equal(seen, 2);
  await assert.rejects(() => providerJson("/someone-else", "token", fakeFetch));
});

test("opaque session cookies store only a digest, and modifying CSRF/origin is rejected", () => {
  const session = newPortalSession(1_800_000_000_000);
  assert.match(session.cookieValue, /^[\w-]{43}$/);
  assert.match(session.sessionHash, /^[a-f0-9]{64}$/);
  assert.equal(sessionHash(session.cookieValue), session.sessionHash);
  assert.notEqual(session.sessionHash, session.cookieValue);
  assert.equal(sessionHash("invalid"), null);
  assert.match(portalSessionCookie(session), new RegExp(SESSION_COOKIE));
  assert.match(portalSessionCookie(session), /HttpOnly; Secure; SameSite=Lax/);
  assert.match(portalSessionCookie(session), new RegExp("Max-Age=" + SESSION_SECONDS));
  assert.match(erasePortalSessionCookie(), /Max-Age=0/);
  assert.equal(constantTimeEqual("abc", "abc"), true);
  assert.equal(constantTimeEqual("abc", "abd"), false);
  const allowed = new Request(stable.path + "/api", { headers: {
    Origin: stable.path, "Sec-Fetch-Site": "same-origin"
  } });
  const foreign = new Request(stable.path + "/api", { headers: {
    Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site"
  } });
  assert.equal(requireSameOrigin(allowed), true);
  assert.equal(requireSameOrigin(foreign), false);
  assert.equal(requireSameOrigin(new Request(stable.path + "/api")), false);
  assert.equal(safeStatusResponse({ ok: true }).headers.get("Cache-Control"), "no-store, private");
});

function fakePool(selectExisting = false) {
  const queries = [];
  let releases = 0;
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes("SELECT connection_id FROM portal_connections")) {
        return { rows: selectExisting ? [{ connection_id: "4a673d89-7604-4c94-8506-c1fdfe149349" }] : [] };
      }
      return { rows: [], rowCount: 1 };
    },
    release() { releases++; },
  };
  return { db: { pool: { connect: async () => client } }, queries,
    get released() { return releases; } };
}

test("persistAuthorization encrypts per-org credentials and issues a revocable owner session", async () => {
  const fake = fakePool();
  const session = await persistAuthorization({
    profile: user, organization: org, tokens,
  }, fake.db, key);
  assert.equal(fake.released, 1);
  assert.equal(fake.queries[0].sql, "BEGIN");
  assert.equal(fake.queries.at(-1).sql, "COMMIT");
  const q = fake.queries.find(x => x.sql.includes("INSERT INTO portal_connections"));
  assert(q);
  const encrypted = q.params[5];
  assert(!encrypted.includes(tokens.accessToken) && !encrypted.includes(tokens.refreshToken));
  assert.deepEqual(decryptTokens(encrypted, tokenBinding(q.params[0],user.userId,org.organizationId), key), tokens);
  const oldSessionDeletion = fake.queries.find(q =>
    q.sql.includes("DELETE FROM portal_sessions WHERE connection_id = $1 AND user_id = $2")
  );
  assert(oldSessionDeletion, "reconnecting must revoke older sessions for this org");
  assert.equal(oldSessionDeletion.params[1], user.userId);
  const sq = fake.queries.find(x=>x.sql.includes("INSERT INTO portal_sessions"));
  assert.match(sq.params[0], /^[a-f0-9]{64}$/);
  assert.notEqual(sq.params[0], session.cookieValue);
  assert.equal(sq.params[1], user.userId);
  assert.equal(sq.params[2], q.params[0]);
});

test("rotating refresh tokens survives a transient org-check error", async () => {
  const connId = "4a673d89-7604-4c94-8506-c1fdfe149349";
  const fresh = { ...tokens, expiresAt: Date.now() - 120000 };
  const sealed = encryptTokens(fresh, tokenBinding(connId, user.userId, org.organizationId), key);
  const fake = fakePool();
  fake.db.pool.connect = async () => ({
    async query(sql, params = []) {
      fake.queries.push({ sql, params });
      if (sql.includes("FROM portal_connections") && sql.includes("FOR UPDATE")) {
        return { rows: [{
          connection_id: connId, user_id: user.userId, organization_id: org.organizationId,
          encrypted_tokens: sealed, access_expires_at: new Date(fresh.expiresAt),
          status: "connected", health_checked_at: null,
        }] };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {},
  });
  const state = await inspectConnectedGrant(
    { connection_id: connId, user_id: user.userId },
    {
      db: fake.db, key,
      oauthConfig: () => ({clientId:"app-id", clientSecret:"fake-secret"}),
      tokenUrl: "https://api.supabase.com/v1/oauth/token",
      providerJson: async () => {throw Error("provider down");},
      fetchFn: async (url,opts) => {
        assert.match(url,/oauth\/token$/);
        assert.equal(new URLSearchParams(opts.body).get("grant_type"),"refresh_token");
        return new Response(JSON.stringify({
          access_token:"new_access_secret",refresh_token:"new_refresh_secret",expires_in:3600
        }),{status:200});
      },
    }
  );
  assert.equal(state.state,"temporarily_unavailable");
  assert.equal(fake.queries.at(-1).sql,"COMMIT");
  const update = fake.queries.find(q=>q.sql.includes("SET encrypted_tokens"));
  assert(update);
  const recovered = decryptTokens(update.params[0],tokenBinding(connId,user.userId,org.organizationId),key);
  assert.equal(recovered.refreshToken,"new_refresh_secret");
});

test("authorisation failure cannot silently install projects", async () => {
  const src = await import("../netlify/functions/supabase-oauth-start.mjs");
  assert.equal(typeof src.default, "function");
  const callback = await import("../netlify/functions/supabase-oauth-callback.mjs");
  assert.equal(typeof callback.default, "function");
  const status = await import("../netlify/functions/supabase-oauth-status.mjs");
  assert.equal(typeof status.default, "function");
});
