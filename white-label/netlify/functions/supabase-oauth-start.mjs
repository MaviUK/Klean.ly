import { newFlow, authorizationUrl, cookieHeader, clearCookie, redirectToWizard, oauthConfig, FLOW_COOKIE, VERIFIED_COOKIE, FLOW_SECONDS } from "./_lib/supabase-oauth.mjs";

// Starts a browser-only authorisation *test*. No application tokens are stored.
export default async function handler(request) {
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const { ready, clientId } = oauthConfig();
  if (!ready) return redirectToWizard("configuration_required");
  const flow = newFlow();
  const headers = new Headers({
    Location: authorizationUrl(clientId, flow),
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  headers.append("Set-Cookie", cookieHeader(FLOW_COOKIE, flow.cookieValue, FLOW_SECONDS));
  headers.append("Set-Cookie", clearCookie(VERIFIED_COOKIE));
  return new Response(null, { status: 302, headers });
}
