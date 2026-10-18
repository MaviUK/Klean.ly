import { constantTimeEqual, permanentMode, requireSameOrigin, safeStatusResponse } from "./_lib/connection-vault.mjs";
import { currentPortalSession } from "./_lib/connection-store.mjs";
import { disconnectNetlifyConnection } from "./_lib/netlify-connection-store.mjs";

export default async function handler(request) {
  if (request.method !== "POST") return safeStatusResponse({ error: "Method not allowed" }, 405);
  if (!requireSameOrigin(request)) return safeStatusResponse({ error: "Cross-origin request denied" }, 403);
  if (permanentMode() !== "permanent") return safeStatusResponse({ error: "Connection not enabled" }, 503);
  try {
    const current = await currentPortalSession(request);
    if (!current) return safeStatusResponse({ error: "Sign in with Supabase first" }, 401);
    if (!constantTimeEqual(request.headers.get("x-csrf-token"), current.csrf_token)) {
      return safeStatusResponse({ error: "Session verification failed" }, 403);
    }
    const removed = await disconnectNetlifyConnection(current);
    return safeStatusResponse({
      disconnected: removed,
      note: "Installer erased its saved Netlify token. You may also revoke the app in Netlify.",
    });
  } catch {
    return safeStatusResponse({ error: "Unable to disconnect Netlify. Retry later." }, 503);
  }
}
