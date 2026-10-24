// Parse and validate only invite links belonging to the dedicated CRM pilot.
// This module NEVER exchanges or consumes an invitation during a GET or page load.
// The browser caller must erase URL credentials with history.replaceState first.
const PILOT_ORIGIN = "https://kleanly-business-crm-pilot.netlify.app";
const HASH = /^[a-fA-F0-9]{32,128}$/;
const BEARER_TOKEN = /^[A-Za-z0-9_.-]{24,8192}$/;
const REFRESH_TOKEN = /^[A-Za-z0-9_.-]{8,2048}$/;

export function parsePilotInviteLink(href) {
  let url;
  try { url = new URL(href); }
  catch { throw new Error("Invalid invitation link"); }

  if (url.origin !== PILOT_ORIGIN ||
      !["/auth/callback", "/auth/callback/"].includes(url.pathname) ||
      url.username || url.password) {
    throw new Error("Invalid invitation destination");
  }
  const query = url.searchParams;
  const fragment = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : "");
  const queryHasCode = query.has("token_hash") || query.has("type");
  const fragmentHasToken = fragment.has("access_token") || fragment.has("refresh_token");
  if (queryHasCode && fragmentHasToken) throw new Error("Ambiguous invitation link");

  // Preferred email template: the link is not consumed by scanners.
  if (queryHasCode) {
    if (query.getAll("token_hash").length !== 1 ||
        query.getAll("type").length !== 1 ||
        query.get("type") !== "invite" || !HASH.test(query.get("token_hash") ?? "")) {
      throw new Error("Invalid invitation link");
    }
    return Object.freeze({ mode: "token_hash", tokenHash: query.get("token_hash") });
  }

  // Backward compatibility for Supabase's default email template. Supabase
  // verifies before redirecting and sends the session in a URL fragment.
  // These values MUST immediately be erased from browser history.
  if (fragmentHasToken) {
    for (const key of ["access_token", "refresh_token", "type", "token_type"]) {
      if (fragment.getAll(key).length !== 1) throw new Error("Invalid invitation link");
    }
    if (fragment.get("type") !== "invite" ||
        fragment.get("token_type")?.toLowerCase() !== "bearer" ||
        !BEARER_TOKEN.test(fragment.get("access_token") ?? "") ||
        !REFRESH_TOKEN.test(fragment.get("refresh_token") ?? "")) {
      throw new Error("Invalid invitation link");
    }
    const expires = Number(fragment.get("expires_in"));
    if (!Number.isSafeInteger(expires) || expires < 1 || expires > 86400) {
      throw new Error("Invalid invitation lifetime");
    }
    return Object.freeze({
      mode: "session",
      accessToken: fragment.get("access_token"),
      refreshToken: fragment.get("refresh_token"),
      expiresIn: expires,
    });
  }
  throw new Error("No valid owner invitation was found");
}
