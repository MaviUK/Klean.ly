import { netlifyConfig } from "./_lib/netlify-oauth.mjs";
import { permanentMode, safeStatusResponse } from "./_lib/connection-vault.mjs";
import { currentPortalSession } from "./_lib/connection-store.mjs";
import { getNetlifyConnection } from "./_lib/netlify-connection-store.mjs";

export function createNetlifyStatus({
  getSession = currentPortalSession, getConnection = getNetlifyConnection,
} = {}) {
  return async function handler(request) {
    if (request.method !== "GET") return safeStatusResponse({ error: "Method not allowed" }, 405);
    const configured = netlifyConfig().ready && permanentMode() === "permanent";
    if (!configured) return safeStatusResponse({
      configured: false, connected: false, installationsCreated: false,
    });
    try {
      const current = await getSession(request);
      if (!current) return safeStatusResponse({
        configured: true, authenticated: false, connected: false, installationsCreated: false,
      });
      const connection = await getConnection(current);
      return safeStatusResponse({
        configured: true, authenticated: true, connected: !!connection,
        installationsCreated: false,
        identity: connection ? {
          id: connection.netlify_user_id, email: connection.netlify_email,
        } : null,
        connection: connection ? {
          status: connection.status, connectedAt: connection.connected_at,
          lastCheckedAt: connection.health_checked_at,
        } : null,
      });
    } catch {
      return safeStatusResponse({
        configured: false, connected: false,
        error: "The secure Netlify connection service is temporarily unavailable.",
      }, 503);
    }
  };
}
export default createNetlifyStatus();
