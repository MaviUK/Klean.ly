import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { environment } from "./supabase-oauth.mjs";

// This separate control plane is deliberately disabled until its DB and
// encryption key are available. OAuth's existing verification-only path
// remains active in the meantime.
export const SESSION_COOKIE = "__Host-kleanly_portal_session";
export const SESSION_SECONDS = 7 * 24 * 3600;
export const MANAGEMENT_BASE = "https://api.supabase.com/v1";
export const ALLOWED_TOKEN_BYTES = 12000;

// Fail closed but distinguish provider response problems without emitting
// provider payloads, emails, authorization codes or OAuth tokens.
export class SupabaseResponseError extends Error {
  constructor(code) { super("Supabase response could not be verified"); this.name = "SupabaseResponseError"; this.code = code; }
}
export class SupabaseApiError extends Error {
  constructor(status) { super("Supabase Management API returned an unsuccessful status"); this.name = "SupabaseApiError"; this.status = status; }
}

export function vaultKey(env = environment) {
  const raw = env("KLEANLY_OAUTH_ENCRYPTION_KEY");
  if (typeof raw !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return null;
  const key = Buffer.from(raw, "base64url");
  return key.length === 32 ? key : null;
}

export function permanentMode(env = environment) {
  if (env("KLEANLY_PERMANENT_OAUTH_ENABLED") !== "true") return "verification-only";
  return vaultKey(env) ? "permanent" : "configuration-required";
}

export function encryptTokens(tokens, binding, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("Encryption key unavailable");
  const plain = Buffer.from(JSON.stringify(tokens), "utf8");
  if (plain.length > ALLOWED_TOKEN_BYTES) throw new Error("Provider token payload too large");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(binding));
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return JSON.stringify({
    v: 1,
    iv: iv.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
    data: ciphertext.toString("base64url"),
  });
}

export function decryptTokens(sealed, binding, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("Encryption key unavailable");
  const envelope = JSON.parse(sealed);
  if (envelope.v !== 1) throw new Error("Unsupported token envelope version");
  for (const prop of ["iv", "authTag", "data"]) {
    if (typeof envelope[prop] !== "string" || envelope[prop].length > ALLOWED_TOKEN_BYTES * 2) {
      throw new Error("Malformed encrypted token envelope");
    }
  }
  const iv = Buffer.from(envelope.iv, "base64url");
  const tag = Buffer.from(envelope.authTag, "base64url");
  if (iv.length !== 12 || tag.length !== 16) throw new Error("Malformed encrypted token envelope");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(binding));
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([
    decipher.update(Buffer.from(envelope.data, "base64url")), decipher.final()
  ]);
  if (plain.length > ALLOWED_TOKEN_BYTES) throw new Error("Provider token payload too large");
  return JSON.parse(plain.toString("utf8"));
}

export function tokenBinding(connectionId, userId, organizationId) {
  return JSON.stringify(["kleanly:portal:v1", connectionId, userId, organizationId]);
}

export function validateProviderTokens(data, previous = null, now = Date.now()) {
  const accessToken = data?.access_token;
  const refreshToken = data?.refresh_token || previous?.refreshToken;
  if (typeof accessToken !== "string" || accessToken.length < 8 || accessToken.length > 8192 ||
      typeof refreshToken !== "string" || refreshToken.length < 8 || refreshToken.length > 8192) {
    throw new Error("Provider did not return complete OAuth tokens");
  }
  const seconds = Number(data?.expires_in);
  const duration = Number.isFinite(seconds) && seconds >= 60 && seconds <= 86400
    ? Math.floor(seconds) : 3600;
  return { accessToken, refreshToken, expiresAt: now + duration * 1000 };
}

export function validateProfile(data) {
  // Supabase Management API GET /v1/profile returns gotrue_id and
  // primary_email, not the id/email names used by Supabase Auth clients.
  // The stable provider user ID is authoritative for portal ownership.
  const userId = data?.gotrue_id ?? data?.id ?? data?.user_id;
  if (typeof userId !== "string" || !/^[\w:@.-]{1,128}$/.test(userId)) {
    throw new SupabaseResponseError("profile_identity_invalid");
  }
  // Email is display-only and NEVER grants portal or organisation access.
  const suppliedEmail = data?.primary_email ?? data?.email;
  const email = typeof suppliedEmail === "string" && suppliedEmail.length <= 254
    ? suppliedEmail : null;
  return { userId, email };
}

export function validateOrganizationResponse(data) {
  const organizations = Array.isArray(data) ? data : data?.organizations;
  if (!Array.isArray(organizations)) {
    throw new SupabaseResponseError("organisations_response_invalid");
  }
  if (organizations.length === 0) {
    throw new SupabaseResponseError("organisations_empty");
  }
  if (organizations.length !== 1) {
    // Never guess which of several organisations a user intended to authorise.
    throw new SupabaseResponseError("organisations_multiple");
  }
  const organization = organizations[0];
  const id = organization?.id;
  if (typeof id !== "string" || id.length < 1 || id.length > 128 ||
      !/^[\w:-]+$/.test(id)) {
    throw new SupabaseResponseError("organisations_id_invalid");
  }
  const name = typeof organization.name === "string" && organization.name.trim()
    ? organization.name.trim().slice(0,160) : "Supabase organisation";
  const slug = typeof organization.slug === "string" && /^[\w-]{1,128}$/.test(organization.slug)
    ? organization.slug : null;
  return { organizationId: id, organizationName: name, organizationSlug: slug };
}

export class SupabaseGrantRejected extends Error {
  constructor(status) {
    super("Supabase authorization was revoked or denied");
    this.name = "SupabaseGrantRejected";
    this.status = status;
  }
}

// OAuth Management API grants do not necessarily allow GET /v1/profile.
// A sole-member organisation can identify the account holder without
// trusting an email, user ID or organisation selection from the browser.
// For teams with several members this proof is ambiguous: fail closed
// until independent portal login and member verification is implemented.
export function organizationMembersPath(organization) {
  const slug = organization?.organizationSlug;
  if (typeof slug !== "string" || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(slug)) {
    throw new SupabaseResponseError("members_slug_unavailable");
  }
  return "/organizations/" + slug + "/members";
}

export function validateSoleOwnerMemberResponse(data) {
  if (!Array.isArray(data)) throw new SupabaseResponseError("members_response_invalid");
  if (data.length !== 1) throw new SupabaseResponseError("members_not_single");
  const member = data[0];
  const userId = member?.user_id;
  if (typeof userId !== "string" || !/^[\w:@.-]{1,128}$/.test(userId)) {
    throw new SupabaseResponseError("members_identity_invalid");
  }
  // A single member could theoretically have a custom role; require a
  // provider-confirmed Owner rather than granting elevated portal rights.
  const role = typeof member.role_name === "string"
    ? member.role_name.toLowerCase().replace(/[\s_-]/g, "") : "";
  if (!["owner", "organizationowner", "organisationowner"].includes(role)) {
    throw new SupabaseResponseError("members_owner_required");
  }
  const email = typeof member.email === "string" && member.email.length <= 254
    ? member.email : null;
  return { userId, email };
}

export async function providerJson(path, accessToken, fetchFn = fetch) {
  const isMemberList = /^\/organizations\/[a-z0-9][a-z0-9_-]{0,127}\/members$/.test(path);
  if (!["/profile", "/organizations"].includes(path) && !isMemberList) {
    throw new Error("Invalid management path");
  }
  const response = await fetchFn(MANAGEMENT_BASE + path, {
    headers: { Authorization: "Bearer " + accessToken, Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if ([401, 403].includes(response.status)) throw new SupabaseGrantRejected(response.status);
  if (!response.ok) throw new SupabaseApiError(response.status);
  const json = await response.json();
  if (path === "/profile") return validateProfile(json);
  if (path === "/organizations") return validateOrganizationResponse(json);
  return validateSoleOwnerMemberResponse(json);
}

export function newPortalSession(now = Date.now()) {
  const value = randomBytes(32).toString("base64url");
  return {
    cookieValue: value,
    sessionHash: createHash("sha256").update(value).digest("hex"),
    csrfToken: randomBytes(32).toString("base64url"),
    expiresAt: new Date(now + SESSION_SECONDS * 1000).toISOString(),
  };
}

export function sessionHash(value) {
  if (typeof value !== "string" || !/^[\w-]{43}$/.test(value)) return null;
  return createHash("sha256").update(value).digest("hex");
}

export function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function requireSameOrigin(request, origin = "https://kleanly-business-installer-staging.netlify.app") {
  const originHeader = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  // Requiring an explicit Origin prevents cross-site form submissions. Real
  // same-origin browser fetch with JSON and custom headers always includes it.
  return originHeader === origin && (!fetchSite || ["same-origin", "none"].includes(fetchSite));
}

export function safeStatusResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, private",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    }
  });
}

export function newConnectionId() { return randomUUID(); }
