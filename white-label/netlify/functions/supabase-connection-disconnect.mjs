import {
  constantTimeEqual, requireSameOrigin, safeStatusResponse, permanentMode,
} from "./_lib/connection-vault.mjs";
import {
  currentPortalSession, deletePortalConnection, erasePortalSessionCookie,
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
    await deletePortalConnection(current);
    // Deletes the encrypted grant and all portal sessions for this connection.
    // Supabase's own app consent remains until revoked in Supabase Dashboard.
    const response = safeStatusResponse({
      disconnected: true,
      note: "Local credentials and sessions deleted. You can also revoke the app in Supabase.",
    });
    response.headers.append("Set-Cookie", erasePortalSessionCookie());
    return response;
  } catch {
    return safeStatusResponse({ error: "Unable to disconnect. Retry later." }, 503);
  }
}
