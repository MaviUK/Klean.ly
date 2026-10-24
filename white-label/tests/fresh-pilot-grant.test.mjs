import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadFreshPilotGrant } from "../netlify/functions/_lib/fresh-pilot-grant.mjs";

const current = {
  user_id: "pilot-user", connection_id: "pilot-connection",
  organization_id: "pilot-org", connection_status: "connected",
};

test("stale access token is refreshed before the owner check reads it", async () => {
  const calls = [];
  let token = "expired-oauth-token";
  const fresh = await loadFreshPilotGrant(current, {
    checkHealth: async (identity, options) => {
      calls.push("health");
      assert.equal(identity, current);
      assert.equal(options.tokenUrl, "https://api.supabase.com/v1/oauth/token");
      assert.equal(typeof options.oauthConfig, "function");
      assert.equal(typeof options.providerJson, "function");
      token = "valid-rotated-oauth-token";
      return { state: "connected" };
    },
    readGrant: async () => { calls.push("read"); return token; },
  });
  assert.equal(fresh, "valid-rotated-oauth-token");
  assert.deepEqual(calls, ["health", "read"]);
});

test("a valid token is read after the cached connected state", async () => {
  const token = await loadFreshPilotGrant(current, {
    checkHealth: async () => ({ state: "connected", cached: true }),
    readGrant: async () => "valid-existing-token",
  });
  assert.equal(token, "valid-existing-token");
});

test("revoked or unavailable grant fails closed before any stale token is read", async () => {
  for (const state of ["reauthorisation_required", "temporarily_unavailable", undefined]) {
    let read = false;
    await assert.rejects(loadFreshPilotGrant(current, {
      checkHealth: async () => ({ state }),
      readGrant: async () => { read = true; return "not-safe-to-use"; },
    }));
    assert.equal(read, false);
  }
  for (const invalid of [null, {}, {...current, connection_status:"revoked"},
    {...current, connection_id: null}]) {
    let called = false;
    await assert.rejects(loadFreshPilotGrant(invalid, {
      checkHealth: async () => { called = true; return {state:"connected"}; },
    }));
    assert.equal(called, false);
  }
});

test("malformed credentials and health errors cannot be used", async () => {
  for (const invalid of ["", "short", null, {}, "X".repeat(8193)]) {
    await assert.rejects(loadFreshPilotGrant(current, {
      checkHealth: async () => ({ state: "connected" }),
      readGrant: async () => invalid,
    }));
  }
  await assert.rejects(loadFreshPilotGrant(current, {
    checkHealth: async () => { throw new Error("provider-unavailable"); },
    readGrant: async () => { throw new Error("must not be called"); },
  }));
});

test("both staging owner endpoints use the fresh grant loader", () => {
  for (const filename of [
    "../netlify/functions/owner-login-readiness.mjs",
    "../netlify/functions/crm-owner-auth-review.mjs",
  ]) {
    const code = readFileSync(new URL(filename, import.meta.url), "utf8");
    assert.match(code, /getGrant = loadFreshPilotGrant/);
  }
  const code = readFileSync(
    new URL("../netlify/functions/_lib/fresh-pilot-grant.mjs", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(code, /inviteUserByEmail|auth\.admin|createUser\(/);
  assert.doesNotMatch(code, /service_role|SUPABASE_SERVICE_ROLE_KEY/i);
});
