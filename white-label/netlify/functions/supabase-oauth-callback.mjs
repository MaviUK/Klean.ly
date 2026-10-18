import {
  CALLBACK_URL, TOKEN_URL, FLOW_COOKIE, VERIFIED_COOKIE,
  readCookie, flowVerifier, oauthConfig, cookieHeader, clearCookie,
  verifiedValue, redirectToWizard, VERIFIED_SECONDS,
} from "./_lib/supabase-oauth.mjs";
import {
  permanentMode, validateProviderTokens, providerJson, vaultKey,
} from "./_lib/connection-vault.mjs";

// Callback is feature-gated: until the private portal DB and vault key are
// configured it preserves the existing, successful verification-only pilot.
// Permanent mode never sets the old 15-minute test verification cookie.
export default async function handler(request) {
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
      [profile, organization] = await Promise.all([
        providerJson("/profile", tokens.accessToken),
        providerJson("/organizations", tokens.accessToken),
      ]);
    } catch {
      // Ambiguous/invalid org, missing stable user ID, or provider error.
      // Discard received tokens, don't open any session or record.
      return redirectToWizard("identity_unavailable", cleanup);
    }

    try {
      const { persistAuthorization, portalSessionCookie } =
        await import("./_lib/connection-store.mjs");
      const portalSession = await persistAuthorization(
        { profile, organization, tokens }, undefined, vaultKey()
      );
      return redirectToWizard("connected", [
        ...cleanup, portalSessionCookie(portalSession),
      ]);
    } catch {
      // No partial "connected" success on database or encryption failures.
      // No credential values, OAuth codes or response bodies are logged.
      return redirectToWizard("storage_unavailable", cleanup);
    }
  } catch {
    return redirectToWizard("exchange_failed", cleanup);
  }
}

export const config = {
  rateLimit: { action: "rate_limit", aggregateBy: "ip", windowSize: 60, windowLimit: 30 },
};
