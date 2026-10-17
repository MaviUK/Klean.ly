import { CALLBACK_URL, TOKEN_URL, FLOW_COOKIE, VERIFIED_COOKIE,
  readCookie, flowVerifier, oauthConfig, cookieHeader, clearCookie,
  verifiedValue, redirectToWizard, VERIFIED_SECONDS } from "./_lib/supabase-oauth.mjs";

// This is intentionally a NON-PERSISTENT verification step.
// Tokens are exchanged server-side then immediately discarded. No provision,
// project queries, token logging, localStorage or application login occurs.
export default async function handler(request) {
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });

  const params = new URL(request.url).searchParams;
  const cleanup = [clearCookie(FLOW_COOKIE), clearCookie(VERIFIED_COOKIE)];
  if (params.has("error")) return redirectToWizard("denied", cleanup);

  const code = params.get("code");
  const state = params.get("state");
  if (typeof code !== "string" || code.length < 5 || code.length > 4096) {
    return redirectToWizard("invalid_response", cleanup);
  }
  const verifier = flowVerifier(readCookie(request.headers.get("cookie"), FLOW_COOKIE), state);
  if (!verifier) return redirectToWizard("expired_or_invalid", cleanup);

  const { ready, clientId, clientSecret } = oauthConfig();
  if (!ready) return redirectToWizard("configuration_required", cleanup);
  try {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Authorization": "Basic " + Buffer.from(clientId + ":" + clientSecret).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
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
    const tokens = await response.json();
    if (typeof tokens?.access_token !== "string" || tokens.access_token.length < 8) {
      return redirectToWizard("exchange_failed", cleanup);
    }
    // Deliberately discard access_token and refresh_token in this pilot stage.
    // Persist only after portal login, encrypted token vault and user-specific
    // access control have been implemented and reviewed.
    return redirectToWizard("verified", [
      clearCookie(FLOW_COOKIE),
      cookieHeader(VERIFIED_COOKIE, verifiedValue(clientSecret), VERIFIED_SECONDS),
    ]);
  } catch {
    // Never log Supabase responses or request codes/tokens.
    return redirectToWizard("exchange_failed", cleanup);
  }
}
