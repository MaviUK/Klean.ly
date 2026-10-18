import {
  NETLIFY_SITE, NETLIFY_FLOW_COOKIE,
  netlifyConfig, readCookie, verifyNetlifyFlow, netlifyWizardRedirect,
  exchangeNetlifyCode, fetchNetlifyProfile,
} from "./_lib/netlify-oauth.mjs";
import { permanentMode, vaultKey } from "./_lib/connection-vault.mjs";
import { currentPortalSession } from "./_lib/connection-store.mjs";
import { saveNetlifyGrant } from "./_lib/netlify-connection-store.mjs";

// Dependency injection exists only for unit tests. Tests never write to a
// staging/production database, even if the test runner has live DB variables.
export function createNetlifyCallback({
  getSession = currentPortalSession,
  exchange = exchangeNetlifyCode,
  getProfile = fetchNetlifyProfile,
  persist = saveNetlifyGrant,
} = {}) {
  return async function handler(request) {
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    const url = new URL(request.url);
    if (url.origin !== NETLIFY_SITE) return netlifyWizardRedirect("configuration_required");
    const cfg = netlifyConfig();
    if (!cfg.ready || permanentMode() !== "permanent") return netlifyWizardRedirect("configuration_required");
    if (url.searchParams.has("error")) return netlifyWizardRedirect("denied");
    const code = url.searchParams.get("code");
    if (!code || code.length < 5 || code.length > 4096) return netlifyWizardRedirect("invalid_response");
    try {
      const current = await getSession(request);
      if (!current || !verifyNetlifyFlow(
        readCookie(request.headers.get("cookie"), NETLIFY_FLOW_COOKIE),
        url.searchParams.get("state"), current.session_hash, vaultKey()
      )) return netlifyWizardRedirect("expired_or_invalid");
      let token;
      try {
        token = await exchange(code, cfg);
      } catch {
        return netlifyWizardRedirect("exchange_failed");
      }
      let profile;
      try {
        profile = await getProfile(token);
      } catch {
        return netlifyWizardRedirect("identity_unavailable");
      }
      try {
        await persist(current, profile, token);
        return netlifyWizardRedirect("connected");
      } catch (error) {
        if (error?.message === "Different Netlify account must be disconnected first") {
          return netlifyWizardRedirect("account_conflict");
        }
        return netlifyWizardRedirect("storage_unavailable");
      }
    } catch {
      return netlifyWizardRedirect("storage_unavailable");
    }
  };
}
export default createNetlifyCallback();
export const config = {
  rateLimit: { action: "rate_limit", aggregateBy: "ip", windowSize: 60, windowLimit: 30 },
};
