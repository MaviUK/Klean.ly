import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import start from "../netlify/functions/supabase-oauth-start.mjs";
import callback from "../netlify/functions/supabase-oauth-callback.mjs";
import {
  CALLBACK_URL, FLOW_COOKIE, TOKEN_URL,
} from "../netlify/functions/_lib/supabase-oauth.mjs";
import { MANAGEMENT_BASE } from "../netlify/functions/_lib/connection-vault.mjs";

test("Supabase OAuth callback reports safe, specific diagnostics without persisting credentials", async () => {
  const previous = {};
  const vars = {
    SUPABASE_OAUTH_CLIENT_ID: "7f3c6a9f-2063-4424-bacf-24a71b0c8321",
    SUPABASE_OAUTH_CLIENT_SECRET: "fake_oauth_secret_123456789",
    KLEANLY_PERMANENT_OAUTH_ENABLED: "true",
    KLEANLY_OAUTH_ENCRYPTION_KEY: randomBytes(32).toString("base64url"),
  };
  for (const key of Object.keys(vars)) {
    previous[key] = process.env[key];
    process.env[key] = vars[key];
  }
  const originalFetch = globalThis.fetch;
  const secretToken = "never_share_oauth_access_token_12345";
  const refreshToken = "never_share_oauth_refresh_token_54321";
  const cleanProfile = { gotrue_id: "some-test-user-id", primary_email: "test@example.invalid" };
  const cleanOrg = { id: "organisation-test-01", slug: "orgtest", name: "Test organisation" };
  const fixtures = [
    { title: "OAuth token missing refresh credential", kind: "token_invalid",
      expected: "token_response_invalid" },
    { title: "profile missing provider user ID", kind: "profile_missing_id",
      expected: "profile_identity_invalid" },
    { title: "profile OAuth scope forbidden", kind: "profile_forbidden",
      expected: "profile_forbidden" },
    { title: "profile fetch rate limited", kind: "profile_limited",
      expected: "profile_rate_limited" },
    { title: "profile API unavailable", kind: "profile_unavailable",
      expected: "profile_unavailable" },
    { title: "organisation list missing", kind: "org_missing_list",
      expected: "organisations_response_invalid" },
    { title: "no accessible organisations", kind: "org_empty",
      expected: "organisations_empty" },
    { title: "multiple organisations fail closed", kind: "org_many",
      expected: "organisations_multiple" },
    { title: "invalid org ID", kind: "org_invalid_id",
      expected: "organisations_id_invalid" },
    { title: "organisation scope forbidden", kind: "org_forbidden",
      expected: "organisations_forbidden" },
    { title: "organisation API unavailable", kind: "org_unavailable",
      expected: "organisations_unavailable" },
  ];
  try {
    for (const fixture of fixtures) {
      const flow = await start(new Request("https://kleanly-business-installer-staging.netlify.app/.netlify/functions/supabase-oauth-start"));
      assert.equal(flow.status, 302);
      const state = new URL(flow.headers.get("Location")).searchParams.get("state");
      const savedCookie = flow.headers.getSetCookie().find(value =>
        value.startsWith(FLOW_COOKIE + "=")).split(";")[0];
      globalThis.fetch = async (url, options) => {
        if (url === TOKEN_URL) {
          assert.equal(options.method, "POST");
          return Response.json({
            access_token: secretToken, token_type: "Bearer",
            ...(fixture.kind === "token_invalid" ? {} : { refresh_token: refreshToken }),
            expires_in: 3600,
          });
        }
        assert.equal(options.headers.Authorization, "Bearer " + secretToken);
        if (url === MANAGEMENT_BASE + "/profile") {
          if (fixture.kind === "profile_forbidden") return new Response(null, { status: 403 });
          if (fixture.kind === "profile_limited") return new Response(null, { status: 429 });
          if (fixture.kind === "profile_unavailable") return new Response(null, { status: 503 });
          if (fixture.kind === "profile_missing_id") return Response.json({ primary_email: "test@example.invalid" });
          return Response.json(cleanProfile);
        }
        if (url === MANAGEMENT_BASE + "/organizations") {
          if (fixture.kind === "org_forbidden") return new Response(null, { status: 403 });
          if (fixture.kind === "org_unavailable") return new Response(null, { status: 503 });
          if (fixture.kind === "org_missing_list") return Response.json({ data: [] });
          if (fixture.kind === "org_empty") return Response.json([]);
          if (fixture.kind === "org_many") return Response.json([cleanOrg, { id: "different-org", name: "Different" }]);
          if (fixture.kind === "org_invalid_id") return Response.json([{ name: "Missing id" }]);
          return Response.json([cleanOrg]);
        }
        throw new Error("Unexpected URL in OAuth test");
      };
      const response = await callback(new Request(CALLBACK_URL + "?" +
        new URLSearchParams({ code: "unit-test-oauth-code", state }), {
          headers: { Cookie: savedCookie },
        }));
      assert.equal(response.status, 303, fixture.title);
      assert.equal(new URL(response.headers.get("Location")).searchParams.get("supabase_test"),
        fixture.expected, fixture.title);
      const publicResponse = response.headers.get("Location") + response.headers.getSetCookie().join("");
      assert(!publicResponse.includes(secretToken) && !publicResponse.includes(refreshToken));
    }
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(vars)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
