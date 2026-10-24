import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Central installer staging only: this does not provision or mutate projects.
export const SITE_ORIGIN = "https://kleanly-business-installer-staging.netlify.app";
export const CALLBACK_URL = SITE_ORIGIN + "/.netlify/functions/supabase-oauth-callback";
export const AUTHORIZE_URL = "https://api.supabase.com/v1/oauth/authorize";
export const TOKEN_URL = "https://api.supabase.com/v1/oauth/token";
export const FLOW_COOKIE = "__Host-kleanly_sb_flow";
export const VERIFIED_COOKIE = "__Host-kleanly_sb_verified";
export const FLOW_SECONDS = 600;
export const VERIFIED_SECONDS = 900;

export function environment(name) {
  // Netlify runtime variables are only supplied on the server.
  return globalThis.Netlify?.env?.get(name) ?? process.env[name] ?? "";
}

export function oauthConfig() {
  const clientId = environment("SUPABASE_OAUTH_CLIENT_ID");
  const clientSecret = environment("SUPABASE_OAUTH_CLIENT_SECRET");
  return {
    clientId,
    clientSecret,
    ready: /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(clientId) && clientSecret.length >= 12,
  };
}

export function newFlow(now = Date.now()) {
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const time = Math.floor(now / 1000);
  return { state, verifier, challenge, cookieValue: [state, verifier, time].join(".") };
}

export function authorizationUrl(clientId, flow) {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", CALLBACK_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", flow.state);
  url.searchParams.set("code_challenge", flow.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export function readCookie(header, name) {
  for (const pair of (header ?? "").split(";")) {
    const trim = pair.trim();
    if (trim.startsWith(name + "=")) return trim.slice(name.length + 1);
  }
  return "";
}

export function flowVerifier(cookie, state, now = Date.now()) {
  if (!cookie || !state) return null;
  const parts = cookie.split(".");
  if (parts.length !== 3) return null;
  const [originalState, verifier, issued] = parts;
  if (!/^[\w-]{43}$/.test(originalState) || !/^[\w-]{43}$/.test(verifier)) return null;
  if (!/^\d{10}$/.test(issued)) return null;
  const age = Math.floor(now / 1000) - Number(issued);
  if (age < 0 || age > FLOW_SECONDS) return null;
  const expected = Buffer.from(originalState);
  const provided = Buffer.from(state);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null;
  return verifier;
}

export function cookieHeader(name, value, seconds) {
  // __Host- cookies require Secure, Path=/, and no Domain attribute.
  return name + "=" + value + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + seconds;
}

export function clearCookie(name) {
  return cookieHeader(name, "", 0);
}

export function verifiedValue(secret, now = Date.now()) {
  const expires = Math.floor(now / 1000) + VERIFIED_SECONDS;
  const payload = "supabase-verification-only:" + expires;
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return expires + "." + signature;
}

export function verifiedExpires(cookie, secret, now = Date.now()) {
  const [exp, signature, extra] = (cookie || "").split(".");
  if (extra !== undefined || !/^\d{10}$/.test(exp) || !/^[\w-]{43}$/.test(signature) || !secret) return null;
  const expires = Number(exp);
  if (expires <= Math.floor(now / 1000) || expires > Math.floor(now / 1000) + VERIFIED_SECONDS) return null;
  const expected = verifiedValueAtExpiry(secret, expires);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return expires;
}

function verifiedValueAtExpiry(secret, expires) {
  return createHmac("sha256", secret)
    .update("supabase-verification-only:" + expires).digest("base64url");
}

export function redirectToWizard(code, extraCookies = []) {
  const location = new URL(SITE_ORIGIN);
  location.searchParams.set("supabase_test", code);
  const headers = new Headers({
    Location: location.toString(),
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  for (const cookie of extraCookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}
