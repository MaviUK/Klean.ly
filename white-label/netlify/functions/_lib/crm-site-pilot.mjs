import { randomUUID } from "node:crypto";
import { getPortalDatabase } from "./connection-store.mjs";
import { REF_PATTERN } from "./test-project-pilot.mjs";
import {
  NETLIFY_API, PILOT_CRM_SITE_NAME, PILOT_CRM_SITE_URL,
} from "../crm-site-proposal.mjs";

// Every user, tenant, and reconnect shares ONE irreversible reservation.
// No automatic retry even if the Netlify response is lost after site creation.
// The actual create endpoint is disabled until the owner separately approves
// setting the staging-only Functions environment variable.
export const CRM_SITE_KEY = "pilot-crm-site-v1";
export const CRM_SITE_CONFIRMATION = "CREATE ONE CRM WEBSITE";
export const CRM_SITE_TEAM_SLUG = "kleanlytest";
export const CRM_SITE_OWNER_EMAIL = "kleanlytest@gerball.co.uk";
export const NETLIFY_SITE_ID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export class CrmSitePilotError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.name = "CrmSitePilotError";
  }
}

export function crmSiteCreationEnabled(env = process.env) {
  return env.KLEANLY_TEST_CRM_SITE_CREATION_ENABLED === "true";
}

export async function readCrmSiteAttempt(current, db = null) {
  const database = db ?? await getPortalDatabase();
  const result = await database.pool.query(
    "SELECT request_id, user_id, organization_id, supabase_project_ref, " +
    "netlify_user_id, netlify_team_id, netlify_team_slug, site_name, site_id, " +
    "status, failure_code, approved_at, submitted_at, created_at " +
    "FROM portal_test_crm_site_creations " +
    "WHERE site_key = $1 LIMIT 1",
    [CRM_SITE_KEY]
  );
  return result.rows[0] ?? null;
}

export function publicCrmSiteAttempt(record) {
  if (!record) return null;
  return {
    status: record.status,
    siteName: record.site_name === PILOT_CRM_SITE_NAME ? record.site_name : null,
    siteId: typeof record.site_id === "string" &&
      NETLIFY_SITE_ID_PATTERN.test(record.site_id) ? record.site_id : null,
    mayRetryAutomatically: false,
    requiresManualReview: ["reserved", "submitted", "unknown"].includes(record.status),
  };
}

export async function reserveCrmSiteAttempt(current, projectRef, netlifyUserId, teamId, {
  db = null, requestId = randomUUID(),
} = {}) {
  if (!current?.user_id || !current.organization_id ||
      !REF_PATTERN.test(projectRef) ||
      typeof netlifyUserId !== "string" || !/^[\w:-]{1,128}$/.test(netlifyUserId) ||
      typeof teamId !== "string" || !/^[\w:-]{1,128}$/.test(teamId)) {
    throw new CrmSitePilotError("invalid_reservation");
  }
  const database = db ?? await getPortalDatabase();
  const inserted = await database.pool.query(
    "INSERT INTO portal_test_crm_site_creations " +
    "(request_id, user_id, organization_id, supabase_project_ref, " +
    "netlify_user_id, netlify_team_id, status) " +
    "VALUES ($1,$2,$3,$4,$5,$6,'reserved') " +
    "ON CONFLICT DO NOTHING RETURNING request_id",
    [requestId, current.user_id, current.organization_id, projectRef,
      netlifyUserId, teamId]
  );
  const reserved = inserted.rows.length === 1;
  return { reserved, requestId: reserved ? requestId : null };
}

export async function markCrmSiteSubmitted(current, requestId, db = null) {
  const database = db ?? await getPortalDatabase();
  const result = await database.pool.query(
    "UPDATE portal_test_crm_site_creations SET status = 'submitted', " +
    "submitted_at = now(), updated_at = now() " +
    "WHERE request_id = $1 AND user_id = $2 AND organization_id = $3 " +
    "AND site_key = $4 AND status = 'reserved' RETURNING request_id",
    [requestId, current.user_id, current.organization_id, CRM_SITE_KEY]
  );
  return result.rows.length === 1;
}

export async function finishCrmSiteAttempt(current, requestId, status,
  siteId = null, failureCode = null, db = null) {
  if (!["created","unknown","rejected"].includes(status) ||
      (status === "created" && !NETLIFY_SITE_ID_PATTERN.test(siteId || ""))) {
    throw new CrmSitePilotError("invalid_final_status");
  }
  const database = db ?? await getPortalDatabase();
  const result = await database.pool.query(
    "UPDATE portal_test_crm_site_creations SET status = $1, site_id = $2, " +
    "failure_code = $3, created_at = CASE WHEN $1 = 'created' THEN now() " +
    "ELSE created_at END, updated_at = now() " +
    "WHERE request_id = $4 AND user_id = $5 AND organization_id = $6 " +
    "AND site_key = $7 AND status = 'submitted' RETURNING request_id",
    [status, siteId, failureCode, requestId, current.user_id,
      current.organization_id, CRM_SITE_KEY]
  );
  return result.rows.length === 1;
}

export function normalizeCrmSiteData(body, expectedTeamId) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      !NETLIFY_SITE_ID_PATTERN.test(body.id || "") ||
      body.name !== PILOT_CRM_SITE_NAME ||
      body.account_id !== expectedTeamId ||
      (body.account_slug !== undefined &&
        body.account_slug !== CRM_SITE_TEAM_SLUG) ||
      (body.custom_domain !== undefined && body.custom_domain !== null &&
        body.custom_domain !== "")) {
    throw new CrmSitePilotError("site_provider_identity_unverified");
  }
  return { id: body.id, name: PILOT_CRM_SITE_NAME,
    accountId: expectedTeamId, url: PILOT_CRM_SITE_URL };
}

export async function createOneCrmNetlifySite(accessToken, expectedTeamId, {
  fetchFn = fetch, timeoutMs = 25000,
} = {}) {
  if (typeof accessToken !== "string" || accessToken.length < 8 ||
      accessToken.length > 8192 ||
      typeof expectedTeamId !== "string" || !/^[\w:-]{1,128}$/.test(expectedTeamId)) {
    throw new CrmSitePilotError("netlify_grant_unavailable");
  }
  // Team-scoped, never POST /sites (which defaults to the user's personal team).
  // NO custom domain, repo, deployment, addons, upgraded plan or password.
  let response;
  try {
    response = await fetchFn(NETLIFY_API + "/" + CRM_SITE_TEAM_SLUG + "/sites", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + accessToken,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: PILOT_CRM_SITE_NAME }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new CrmSitePilotError("provider_outcome_unknown");
  }
  if (response.status !== 201) {
    throw new CrmSitePilotError(
      [401,403].includes(response.status) ? "provider_permission_denied" :
        response.status === 409 ? "site_name_unavailable" :
        "provider_outcome_unknown"
    );
  }
  let payload;
  try { payload = await response.json(); }
  catch { throw new CrmSitePilotError("provider_outcome_unknown"); }
  return normalizeCrmSiteData(payload, expectedTeamId);
}

export async function verifyCreatedCrmSite(accessToken, siteId, expectedTeamId, {
  fetchFn = fetch, timeoutMs = 15000,
} = {}) {
  if (!NETLIFY_SITE_ID_PATTERN.test(siteId || "")) return false;
  const response = await fetchFn(NETLIFY_API + "/sites/" + siteId, {
    method: "GET",
    headers: { Authorization: "Bearer " + accessToken, Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) return false;
  try { return normalizeCrmSiteData(await response.json(), expectedTeamId).id === siteId; }
  catch { return false; }
}
