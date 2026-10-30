import {
  netlifyConfig, startNetlifyFlow, netlifyAuthorizationUrl,
  netlifyFlowCookie, netlifyWizardRedirect, NETLIFY_SITE,
} from "./_lib/netlify-oauth.mjs";
import { permanentMode, vaultKey } from "./_lib/connection-vault.mjs";
import { currentPortalSession } from "./_lib/connection-store.mjs";

export function createNetlifyStart({ getSession = currentPortalSession } = {}) {
  return async function handler(request) {
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    if (new URL(request.url).origin !== NETLIFY_SITE) return netlifyWizardRedirect("configuration_required");
    const cfg = netlifyConfig();
    if (!cfg.ready || permanentMode() !== "permanent") return netlifyWizardRedirect("configuration_required");
    try {
      const session = await getSession(request);
      if (!session) return netlifyWizardRedirect("signin_required");
      const flow = startNetlifyFlow(session.session_hash, vaultKey());
      const headers = new Headers({
        Location: netlifyAuthorizationUrl(cfg.clientId, flow.state),
        "Cache-Control": "no-store, private",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      });
      headers.append("Set-Cookie", netlifyFlowCookie(flow.cookieValue));
      return new Response(null, { status: 302, headers });
    } catch {
      return netlifyWizardRedirect("storage_unavailable");
    }
  };
}
export default createNetlifyStart();
export const config = {
  rateLimit: { action: "rate_limit", aggregateBy: "ip", windowSize: 60, windowLimit: 20 },
};
