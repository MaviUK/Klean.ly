import { oauthConfig, TOKEN_URL } from "./_lib/supabase-oauth.mjs";
import {
  constantTimeEqual, providerJson, requireSameOrigin, safeStatusResponse,
  permanentMode,
} from "./_lib/connection-vault.mjs";
import {
  currentPortalSession, inspectConnectedGrant,
} from "./_lib/connection-store.mjs";

export default async function handler(request) {
  if (request.method !== "POST") return safeStatusResponse({ error: "Method not allowed" }, 405);
  if (!requireSameOrigin(request)) return safeStatusResponse({ error: "Cross-origin request denied" }, 403);
  if (permanentMode() !== "permanent") return safeStatusResponse({ error: "Permanent connection not enabled" }, 503);
  try {
    const current = await currentPortalSession(request);
    if (!current) return safeStatusResponse({ error: "Sign in with Supabase first" }, 401);
    if (!constantTimeEqual(request.headers.get("x-csrf-token"), current.csrf_token)) {
      return safeStatusResponse({ error: "Session verification failed" }, 403);
    }
    const health = await inspectConnectedGrant(current, {
      oauthConfig, tokenUrl: TOKEN_URL, providerJson,
    });
    return safeStatusResponse(health);
  } catch {
    return safeStatusResponse({
      state: "temporarily_unavailable", error: "Could not check Supabase right now. Try later.",
    }, 503);
  }
}
export const config = {
  rateLimit: { action: "rate_limit", aggregateBy: "ip", windowSize: 60, windowLimit: 20 },
};
