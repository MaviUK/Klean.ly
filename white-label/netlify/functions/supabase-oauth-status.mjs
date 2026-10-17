import { VERIFIED_COOKIE, readCookie, verifiedExpires, oauthConfig } from "./_lib/supabase-oauth.mjs";

export default async function handler(request) {
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const { ready, clientSecret } = oauthConfig();
  const until = ready ? verifiedExpires(
    readCookie(request.headers.get("cookie"), VERIFIED_COOKIE), clientSecret
  ) : null;
  return new Response(JSON.stringify({
    configured: ready,
    verified: until !== null,
    verifiedUntil: until ? new Date(until * 1000).toISOString() : null,
    mode: "verification-only",
    tokensStored: false,
    installationsCreated: false,
  }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, private",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
