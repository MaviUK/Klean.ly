import { randomBytes, randomUUID } from "node:crypto";
import {
  decryptTokens, encryptTokens, tokenBinding, vaultKey,
} from "./connection-vault.mjs";
import { getPortalDatabase } from "./connection-store.mjs";

// This pilot is NOT a general customer installer. It can only target one
// explicitly allowlisted, single-owner test organisation on staging.
// A unique DB reservation is written BEFORE the external POST and is NEVER
// automatically released or retried, even after unknown network outcomes.
export const PILOT_PROJECT_NAME = "Kleanly Business Staging CRM Pilot";
export const PILOT_REGION_GROUP = "emea";
export const PILOT_CONFIRMATION = "CREATE ONE TEST PROJECT";
export const PILOT_SITE_HOST = "kleanly-business-installer-staging.netlify.app";
export const REF_PATTERN = /^[a-z0-9]{20}$/i;

export class TestProjectError extends Error {
  constructor(code, httpStatus = 409) {
    super(code);
    this.name = "TestProjectError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function pilotSettings(env = process.env) {
  const ownerEmail = env.KLEANLY_PILOT_OWNER_EMAIL;
  const organizationName = env.KLEANLY_PILOT_ORGANIZATION_NAME;
  const allowlistConfigured = typeof ownerEmail === "string" &&
    ownerEmail.includes("@") && ownerEmail.length <= 254 &&
    typeof organizationName === "string" && organizationName.length >= 3 &&
    organizationName.length <= 160;
  return {
    allowlistConfigured,
    ownerEmail: allowlistConfigured ? ownerEmail.trim().toLowerCase() : "",
    organizationName: allowlistConfigured ? organizationName.trim() : "",
    enabled: env.KLEANLY_TEST_PROJECT_CREATION_ENABLED === "true",
  };
}

export function isPilotTarget(current, settings) {
  return !!(settings?.allowlistConfigured &&
    current?.connection_status === "connected" &&
    typeof current.email === "string" &&
    current.email.toLowerCase() === settings.ownerEmail &&
    current.organization_name === settings.organizationName &&
    typeof current.organization_id === "string" &&
    current.organization_id.length > 0 && current.organization_id.length <= 128 &&
    typeof current.organization_slug === "string" &&
    /^[a-z0-9][a-z0-9_-]{0,127}$/.test(current.organization_slug) &&
    typeof current.user_id === "string" && current.user_id.length > 0 &&
    typeof current.connection_id === "string" && current.connection_id.length > 0
  );
}

export function isStagingHost(request) {
  try {
    return new URL(request.url).hostname === PILOT_SITE_HOST &&
      new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

export function eligibleForPilot(capacity) {
  // Deliberately require exactly the previously observed single test project,
  // not merely any account that appears under its Free Plan quota.
  // Other owner/admin projects may still be invisible to this OAuth grant.
  return capacity?.freePlanConfirmed === true &&
    capacity?.appearsWithinFreeLimit === true &&
    capacity?.freeCapacityGuaranteed === false &&
    capacity.visibleAccountProjects === 1 &&
    capacity.thisOrganizationProjects === 1 &&
    capacity.allowedToCreateProject === false &&
    capacity.projectCreated === false &&
    capacity.chargesApproved === false;
}

export function testProjectRequestBody(organizationSlug, dbPassword) {
  if (typeof organizationSlug !== "string" ||
      !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(organizationSlug) ||
      typeof dbPassword !== "string" || dbPassword.length < 40 ||
      dbPassword.length > 128) {
    throw new TestProjectError("invalid_provider_request");
  }
  // Never send desired_instance_size or any paid add-ons. The provider will
  // select a region within EMEA. Exact data residency is not promised.
  return {
    name: PILOT_PROJECT_NAME,
    organization_slug: organizationSlug,
    db_pass: dbPassword,
    region_selection: { type: "smartGroup", code: PILOT_REGION_GROUP },
  };
}

export function projectPasswordBinding(current, requestId) {
  return JSON.stringify([
    "kleanly:test-project-db-password:v1",
    current.user_id, current.organization_id, requestId,
  ]);
}

export async function readPilotRecord(current, db = null) {
  const database = db ?? await getPortalDatabase();
  const result = await database.pool.query(
    "SELECT request_id, project_name, status, project_ref, failure_code, " +
    "approved_at, submitted_at, provisioned_at FROM portal_test_project_creations " +
    "WHERE user_id = $1 AND organization_id = $2 LIMIT 1",
    [current.user_id, current.organization_id]
  );
  return result.rows[0] ?? null;
}

export function publicPilotRecord(record) {
  if (!record) return null;
  return {
    status: record.status,
    projectName: record.project_name,
    projectRef: typeof record.project_ref === "string" && REF_PATTERN.test(record.project_ref)
      ? record.project_ref : null,
    requiresManualReview: ["reserved", "submitted", "unknown"].includes(record.status),
    mayRetryAutomatically: false,
  };
}

export async function loadVerifiedGrant(current, db = null, key = vaultKey()) {
  if (!key) throw new TestProjectError("secure_storage_unavailable", 503);
  const database = db ?? await getPortalDatabase();
  const result = await database.pool.query(
    "SELECT encrypted_tokens FROM portal_connections WHERE connection_id = $1 " +
    "AND user_id = $2 AND organization_id = $3 AND status = 'connected' LIMIT 1",
    [current.connection_id, current.user_id, current.organization_id]
  );
  if (result.rows.length !== 1) throw new TestProjectError("connection_unavailable", 409);
  let tokens;
  try {
    tokens = decryptTokens(
      result.rows[0].encrypted_tokens,
      tokenBinding(current.connection_id, current.user_id, current.organization_id), key
    );
  } catch {
    throw new TestProjectError("connection_unavailable", 409);
  }
  if (typeof tokens?.accessToken !== "string" || tokens.accessToken.length < 8) {
    throw new TestProjectError("connection_unavailable", 409);
  }
  return tokens.accessToken;
}

export async function reservePilotProject(current, {
  db = null, key = vaultKey(), password = randomBytes(36).toString("base64url"),
  requestId = randomUUID(),
} = {}) {
  if (!key || !isPilotTarget(current, pilotSettings())) {
    throw new TestProjectError("pilot_owner_not_allowed", 403);
  }
  const database = db ?? await getPortalDatabase();
  const sealed = encryptTokens(
    { dbPassword: password }, projectPasswordBinding(current, requestId), key
  );
  const inserted = await database.pool.query(
    "INSERT INTO portal_test_project_creations " +
    "(request_id, user_id, connection_id, organization_id, organization_slug, " +
    "project_name, region_group, encrypted_db_password, status) " +
    "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'reserved') " +
    "ON CONFLICT DO NOTHING RETURNING request_id",
    [requestId, current.user_id, current.connection_id,
      current.organization_id, current.organization_slug, PILOT_PROJECT_NAME,
      PILOT_REGION_GROUP, sealed]
  );
  return {
    created: inserted.rows.length === 1,
    requestId: inserted.rows.length === 1 ? requestId : null,
    // Never reveal the randomly generated database password in a response.
    password: inserted.rows.length === 1 ? password : null,
  };
}

export async function markPilotSubmitted(current, requestId, db = null) {
  const database = db ?? await getPortalDatabase();
  const result = await database.pool.query(
    "UPDATE portal_test_project_creations SET status = 'submitted', " +
    "submitted_at = now(), updated_at = now() " +
    "WHERE request_id = $1 AND user_id = $2 AND organization_id = $3 " +
    "AND status = 'reserved' RETURNING request_id",
    [requestId, current.user_id, current.organization_id]
  );
  return result.rows.length === 1;
}

export async function markPilotCompleted(current, requestId, status, projectRef, failureCode, db = null) {
  if (!["created", "unknown", "rejected"].includes(status) ||
      (status === "created" && (!projectRef || !REF_PATTERN.test(projectRef)))) {
    throw new TestProjectError("invalid_ledger_update", 503);
  }
  const database = db ?? await getPortalDatabase();
  const result = await database.pool.query(
    "UPDATE portal_test_project_creations SET status = $1, project_ref = $2, " +
    "failure_code = $3, provisioned_at = CASE WHEN $1 = 'created' THEN now() " +
    "ELSE provisioned_at END, updated_at = now() " +
    "WHERE request_id = $4 AND user_id = $5 AND organization_id = $6 " +
    "AND status = 'submitted' RETURNING request_id",
    [status, projectRef || null, failureCode || null, requestId,
      current.user_id, current.organization_id]
  );
  return result.rows.length === 1;
}

export function normalizeProjectResponse(body) {
  const ref = body?.ref || body?.id || body?.project_ref;
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      typeof ref !== "string" || !REF_PATTERN.test(ref)) {
    throw new TestProjectError("provider_response_unverified", 503);
  }
  return ref;
}

export async function submitPilotProject(accessToken, current, password, {
  fetchFn = fetch, timeoutMs = 30000,
} = {}) {
  const body = testProjectRequestBody(current.organization_slug, password);
  let response;
  try {
    response = await fetchFn("https://api.supabase.com/v1/projects", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + accessToken,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // A timeout does NOT prove that Supabase rejected the project. Fail closed.
    throw new TestProjectError("provider_result_unknown", 503);
  }
  if (response.status !== 201) {
    // Do not automatically reissue POST for ANY provider result, including
    // rate limits or 5xx, because the creation may have succeeded.
    throw new TestProjectError(
      response.status === 401 || response.status === 403
        ? "provider_permission_denied"
        : response.status === 402 || response.status === 409
          ? "provider_quota_or_billing"
          : "provider_result_unknown",
      503
    );
  }
  try {
    return normalizeProjectResponse(await response.json());
  } catch {
    throw new TestProjectError("provider_response_unverified", 503);
  }
}
