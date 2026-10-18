import {
  CALLBACK_URL, TOKEN_URL, FLOW_COOKIE, VERIFIED_COOKIE,
  readCookie, flowVerifier, oauthConfig, cookieHeader, clearCookie,
  verifiedValue, redirectToWizard, VERIFIED_SECONDS,
} from "./_lib/supabase-oauth.mjs";
import {
  permanentMode, validateProviderTokens, providerJson, vaultKey,
  SupabaseResponseError, SupabaseApiError, SupabaseGrantRejected,
  organizationMembersPath,
} from "./_lib/connection-vault.mjs";

// The only diagnostic emitted to logs or the browser is a fixed, non-sensitive
// category. Never log the provider body, token, OAuth code, state or org IDs.
function failedVerification(code, cleanup) {
  console.warn("[Klean.ly Business Supabase OAuth] " + code);
  return redirectToWizard(code, cleanup);
}

function lookupFailure(stage, error) {
  if (error instanceof SupabaseResponseError) return error.code;
  if (error instanceof SupabaseGrantRejected) return stage + "_forbidden";
  if (error instanceof SupabaseApiError && error.status === 429) return stage + "_rate_limited";
  return stage + "_unavailable";
}

// This is the *only* implementation that can write to the portal database.
// The callback factory below accepts a different persistence function in unit
// tests, so even a Netlify build with a live DB URL cannot write test records.
async function persistVerifiedGrant(details) {
  const { persistAuthorization, portalSessionCookie } =
    await import("./_lib/connection-store.mjs");
  const portalSession = await persistAuthorization(details, undefined, vaultKey());
  return portalSessionCookie(portalSession);
}

// Callback is feature-gated: until the private portal DB and vault key are
// configured it preserves the existing, successful verification-only pilot.
// Permanent mode never sets the old 15-minute test verification cookie.
// Dependency injection is code-only; callers cannot select it using an HTTP request.
export function createOAuthCallback({ persistGrant = persistVerifiedGrant } = {}) {
  return async function handler(request) {
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const params = new URL(request.url).searchParams;
  const cleanup = [clearCookie(FLOW_COOKIE), clearCookie(VERIFIED_COOKIE)];
  if (params.has("error")) return redirectToWizard("denied", cleanup);

  const code = params.get("code");
  if (typeof code !== "string" || code.length < 5 || code.length > 4096) {
    return redirectToWizard("invalid_response", cleanup);
  }
  const verifier = flowVerifier(readCookie(request.headers.get("cookie"), FLOW_COOKIE), params.get("state"));
  if (!verifier) return redirectToWizard("expired_or_invalid", cleanup);

  const { ready, clientId, clientSecret } = oauthConfig();
  const mode = permanentMode();
  if (!ready || mode === "configuration-required") {
    return redirectToWizard("configuration_required", cleanup);
  }

  try {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(clientId + ":" + clientSecret).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: CALLBACK_URL,
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return redirectToWizard("exchange_failed", cleanup);
    const raw = await response.json();
    if (typeof raw?.access_token !== "string" || raw.access_token.length < 8) {
      return redirectToWizard("exchange_failed", cleanup);
    }

    if (mode === "verification-only") {
      // Existing pilot: no access/refresh tokens are stored.
      return redirectToWizard("verified", [
        clearCookie(FLOW_COOKIE),
        cookieHeader(VERIFIED_COOKIE, verifiedValue(clientSecret), VERIFIED_SECONDS),
      ]);
    }

    // OAuth identity IS the portal sign-in proof: read only the token owner's
    // profile and the single Supabase organisation consented in OAuth.
    // Never trust company/user IDs passed in URL parameters or browser storage.
    let tokens, profile, organization;
    try {
      tokens = validateProviderTokens(raw);
    } catch {
      return failedVerification("token_response_invalid", cleanup);
    }
    // Query concurrently to stay within the Netlify Function time budget.
    // Promise.allSettled lets us identify exactly which validation failed.
    const results = await Promise.allSettled([
      providerJson("/profile", tokens.accessToken),
      providerJson("/organizations", tokens.accessToken),
    ]);
    if (results[1].status === "rejected") {
      return failedVerification(lookupFailure("organisations", results[1].reason), cleanup);
    }
    organization = results[1].value;

    if (results[0].status === "fulfilled") {
      profile = results[0].value;
    } else {
      const profileFailure = results[0].reason;
      // Management API /profile is not OAuth-scoped. Only a 403 may use the
      // narrowly permitted organisation-membership fallback. A 401 (revoked
      // or invalid access token) must never be treated as identity proof.
      if (!(profileFailure instanceof SupabaseGrantRejected && profileFailure.status === 403)) {
        return failedVerification(lookupFailure("profile", profileFailure), cleanup);
      }
      try {
        const memberPath = organizationMembersPath(organization);
        profile = await providerJson(memberPath, tokens.accessToken);
      } catch (error) {
        return failedVerification(lookupFailure("members", error), cleanup);
      }
    }

    try {
      const sessionCookie = await persistGrant({ profile, organization, tokens });
      return redirectToWizard("connected", [...cleanup, sessionCookie]);
    } catch {
      // No partial "connected" success on database or encryption failures.
      // No credential values, OAuth codes or response bodies are logged.
      return redirectToWizard("storage_unavailable", cleanup);
    }
  } catch {
    return redirectToWizard("exchange_failed", cleanup);
  }
  };
}

// The Netlify Function always uses the real, server-side implementation.
export default createOAuthCallback();

export const config = {
  rateLimit: { action: "rate_limit", aggregateBy: "ip", windowSize: 60, windowLimit: 30 },
};
