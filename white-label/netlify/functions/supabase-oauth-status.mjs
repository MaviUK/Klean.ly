import {
  VERIFIED_COOKIE, readCookie, verifiedExpires, oauthConfig,
} from "./_lib/supabase-oauth.mjs";
import {
  permanentMode, SESSION_COOKIE, sessionHash, safeStatusResponse,
} from "./_lib/connection-vault.mjs";

export default async function handler(request) {
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });

  const { ready, clientSecret } = oauthConfig();
  const mode = permanentMode();
  if (!ready || mode === "configuration-required") {
    return safeStatusResponse({
      configured: false, mode: "configuration-required",
      verified: false, connected: false, tokensStored: false, installationsCreated: false,
    });
  }

  if (mode === "verification-only") {
    const until = verifiedExpires(
      readCookie(request.headers.get("cookie"), VERIFIED_COOKIE), clientSecret
    );
    return safeStatusResponse({
      configured: true, mode: "verification-only",
      verified: until !== null, verifiedUntil: until ? new Date(until * 1000).toISOString() : null,
      connected: false, tokensStored: false, installationsCreated: false,
    });
  }

  try {
    const { currentPortalSession } = await import("./_lib/connection-store.mjs");
    const session = await currentPortalSession(request);
    if (!session) {
      return safeStatusResponse({
        configured: true, mode: "permanent", connected: false,
        verified: false, tokensStored: false, installationsCreated: false,
      });
    }
    return safeStatusResponse({
      configured: true, mode: "permanent", connected: true,
      verified: false, tokensStored: true, installationsCreated: false,
      identity: { email: session.email },
      organization: {
        id: session.organization_id, name: session.organization_name,
        slug: session.organization_slug,
      },
      connection: {
        status: session.connection_status, connectedAt: session.connected_at,
        accessExpiresAt: session.access_expires_at,
        lastCheckedAt: session.health_checked_at,
      },
      csrfToken: session.csrf_token,
      // No encrypted credentials, tokens or session identifiers leave the server.
    });
  } catch {
    return safeStatusResponse({
      configured: false, mode: "service-unavailable",
      connected: false, installationsCreated: false,
      error: "The private connection database is temporarily unavailable.",
    }, 503);
  }
}
