import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { environment, readCookie, cookieHeader, clearCookie } from "./supabase-oauth.mjs";

export const NETLIFY_SITE = "https://kleanly-business-installer-staging.netlify.app";
export const NETLIFY_CALLBACK = NETLIFY_SITE + "/.netlify/functions/netlify-oauth-callback";
export const NETLIFY_AUTHORIZE = "https://app.netlify.com/authorize";
export const NETLIFY_EXCHANGE = "https://api.netlify.com/oauth/token";
export const NETLIFY_PROFILE = "https://api.netlify.com/api/v1/user";
export const NETLIFY_FLOW_COOKIE = "__Host-kleanly_nl_flow";
export const NETLIFY_FLOW_SECONDS = 600;

export function netlifyConfig(env = environment) {
  const clientId = env("NETLIFY_OAUTH_CLIENT_ID");
  const clientSecret = env("NETLIFY_OAUTH_CLIENT_SECRET");
  return {
    clientId, clientSecret,
    ready: typeof clientId === "string" && /^[\w-]{20,128}$/.test(clientId) &&
      typeof clientSecret === "string" && clientSecret.length >= 16 && clientSecret.length <= 512,
  };
}

function signFlow(state, issued, sessionDigest, key) {
  return createHmac("sha256", key)
    .update(["kleanly:netlify-oauth:v1", state, issued, sessionDigest].join(":"))
    .digest("base64url");
}

export function startNetlifyFlow(sessionDigest, key, now = Date.now()) {
  if (!/^[a-f0-9]{64}$/.test(sessionDigest) || !Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error("Authenticated portal session required");
  }
  const state = randomBytes(32).toString("base64url");
  const issued = String(Math.floor(now / 1000));
  return { state, cookieValue: [state, issued, signFlow(state, issued, sessionDigest, key)].join(".") };
}

export function verifyNetlifyFlow(cookie, state, sessionDigest, key, now = Date.now()) {
  if (!cookie || !state || !key || !sessionDigest) return false;
  const parts = cookie.split(".");
  if (parts.length !== 3) return false;
  const [expectedState, issued, signature] = parts;
  if (!/^[\w-]{43}$/.test(expectedState) || !/^[\w-]{43}$/.test(state) ||
      !/^\d{10}$/.test(issued) || !/^[\w-]{43}$/.test(signature)) return false;
  const age = Math.floor(now / 1000) - Number(issued);
  if (age < 0 || age > NETLIFY_FLOW_SECONDS) return false;
  if (!/^[a-f0-9]{64}$/.test(sessionDigest) || !Buffer.isBuffer(key) || key.length !== 32) return false;
  const a = Buffer.from(signature), b = Buffer.from(signFlow(expectedState, issued, sessionDigest, key));
  const x = Buffer.from(expectedState), y = Buffer.from(state);
  return a.length === b.length && timingSafeEqual(a, b) &&
    x.length === y.length && timingSafeEqual(x, y);
}

export function netlifyAuthorizationUrl(clientId, state) {
  const url = new URL(NETLIFY_AUTHORIZE);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", NETLIFY_CALLBACK);
  url.searchParams.set("state", state);
  return url.toString();
}

export function netlifyFlowCookie(value) {
  return cookieHeader(NETLIFY_FLOW_COOKIE, value, NETLIFY_FLOW_SECONDS);
}
export function clearNetlifyFlowCookie() { return clearCookie(NETLIFY_FLOW_COOKIE); }
export function netlifyWizardRedirect(result) {
  const url = new URL(NETLIFY_SITE);
  url.searchParams.set("netlify_result", result);
  const headers = new Headers({
    Location: url.toString(),
    "Cache-Control": "no-store, private",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  headers.append("Set-Cookie", clearNetlifyFlowCookie());
  return new Response(null, { status: 303, headers });
}

export async function exchangeNetlifyCode(code, config = netlifyConfig(), fetchFn = fetch) {
  const response = await fetchFn(NETLIFY_EXCHANGE, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code,
      client_id: config.clientId, client_secret: config.clientSecret,
      redirect_uri: NETLIFY_CALLBACK,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error("Netlify code exchange rejected");
  const json = await response.json();
  const token = json?.access_token;
  if (typeof token !== "string" || token.length < 8 || token.length > 8192) {
    throw new Error("Netlify did not return a usable access token");
  }
  return token;
}

export class NetlifyAccessDenied extends Error {
  constructor() { super("Netlify grant is invalid or revoked"); this.name = "NetlifyAccessDenied"; }
}
export async function fetchNetlifyProfile(token, fetchFn = fetch) {
  if (typeof token !== "string" || token.length < 8 || token.length > 8192) {
    throw new Error("Invalid Netlify token");
  }
  const response = await fetchFn(NETLIFY_PROFILE, {
    headers: { Authorization: "Bearer " + token, Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if ([401, 403].includes(response.status)) throw new NetlifyAccessDenied();
  if (!response.ok) throw new Error("Netlify profile temporarily unavailable");
  const data = await response.json();
  const id = data?.id;
  if (typeof id !== "string" || !/^[\w:-]{1,128}$/.test(id)) {
    throw new Error("Netlify profile identity invalid");
  }
  const email = typeof data?.email === "string" && data.email.length <= 254 ? data.email : null;
  return { netlifyUserId: id, email };
}

// Netlify OAuth supplies a bearer grant without a guaranteed refresh token.
// Connecting does not create PATs, hosting sites or deployments.
export { readCookie };
