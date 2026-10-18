import { createHash, randomUUID } from "node:crypto";
import { getPortalDatabase } from "./connection-store.mjs";
import { PILOT_PROJECT_NAME, REF_PATTERN } from "./test-project-pilot.mjs";
import { CRM_FOUNDATION_SQL } from "../../../blueprint/foundation-v1-bundled.mjs";

// Staging-only, one-shot CRM schema pilot. The actual user-facing installation
// remains locked by KLEANLY_TEST_CRM_SCHEMA_INSTALL_ENABLED (OFF by default).
// No browser input can determine the SQL or Supabase project target.
export const CRM_INSTALL_KEY = "pilot-crm-v1";
export const CRM_INSTALL_CONFIRMATION = "INSTALL CRM SCHEMA V1";
export const CRM_BLUEPRINT_SHA256 = createHash("sha256")
  .update(CRM_FOUNDATION_SQL, "utf8").digest("hex");
const API_BASE = "https://api.supabase.com/v1/projects/";

export class CrmSchemaPilotError extends Error {
  constructor(code) { super(code); this.name = "CrmSchemaPilotError"; this.code = code; }
}

export function schemaInstallEnabled(env = process.env) {
  return env.KLEANLY_TEST_CRM_SCHEMA_INSTALL_ENABLED === "true";
}

export function validateFoundationSql(sql = CRM_FOUNDATION_SQL) {
  if (sql !== CRM_FOUNDATION_SQL ||
      !sql.startsWith("-- Klean.ly Business: dedicated single-company database blueprint v1") ||
      !/\bbegin\s*;/i.test(sql) || !/\bcommit\s*;\s*$/i.test(sql) ||
      !sql.includes("Dedicated database required: this database has the Klean.ly directory cleaners table.") ||
      !sql.includes("kleanly_internal.schema_versions") ||
      !sql.includes("alter table public.business_profile enable row level security") ||
      !sql.includes("foreach target in array") ||
      /\bdrop\s+table\b/i.test(sql)) {
    throw new CrmSchemaPilotError("blueprint_invalid");
  }
  return sql;
}

export async function readCrmSchemaAttempt(current, db = null) {
  const database = db ?? await getPortalDatabase();
  const result = await database.pool.query(
    "SELECT request_id, project_ref, blueprint_version, status, failure_code, " +
    "approved_at, submitted_at, applied_at FROM portal_test_crm_schema_installs " +
    "WHERE user_id = $1 AND organization_id = $2 AND install_key = $3 LIMIT 1",
    [current.user_id, current.organization_id, CRM_INSTALL_KEY]
  );
  return result.rows[0] ?? null;
}

export function publicCrmSchemaAttempt(record) {
  if (!record) return null;
  return {
    status: record.status,
    projectRef: typeof record.project_ref === "string" && REF_PATTERN.test(record.project_ref)
      ? record.project_ref : null,
    blueprintVersion: record.blueprint_version === 1 ? 1 : null,
    mayRetryAutomatically: false,
    needsManualReview: ["reserved","submitted","unknown"].includes(record.status),
  };
}

export async function reserveCrmSchemaAttempt(current, ref, {
  db = null, requestId = randomUUID(), blueprintSha256 = CRM_BLUEPRINT_SHA256,
} = {}) {
  if (!REF_PATTERN.test(ref) ||
      !/^[0-9a-f]{64}$/.test(blueprintSha256)) {
    throw new CrmSchemaPilotError("invalid_reservation");
  }
  const database = db ?? await getPortalDatabase();
  const result = await database.pool.query(
    "INSERT INTO portal_test_crm_schema_installs " +
    "(request_id, user_id, organization_id, project_ref, blueprint_sha256, status) " +
    "VALUES ($1,$2,$3,$4,$5,'reserved') " +
    "ON CONFLICT DO NOTHING RETURNING request_id",
    [requestId, current.user_id, current.organization_id, ref, blueprintSha256]
  );
  return { reserved: result.rows.length === 1, requestId: result.rows.length === 1 ? requestId : null };
}

export async function markCrmSchemaSubmitted(current, ref, requestId, db = null) {
  const database = db ?? await getPortalDatabase();
  const result = await database.pool.query(
    "UPDATE portal_test_crm_schema_installs SET status = 'submitted', " +
    "submitted_at = now(), updated_at = now() WHERE request_id = $1 " +
    "AND user_id = $2 AND organization_id = $3 AND project_ref = $4 " +
    "AND status = 'reserved' RETURNING request_id",
    [requestId, current.user_id, current.organization_id, ref]
  );
  return result.rows.length === 1;
}

export async function finishCrmSchemaAttempt(current, ref, requestId, status, failureCode = null, db = null) {
  if (!["applied","unknown","rejected"].includes(status)) {
    throw new CrmSchemaPilotError("invalid_ledger_status");
  }
  const database = db ?? await getPortalDatabase();
  const result = await database.pool.query(
    "UPDATE portal_test_crm_schema_installs SET status = $1, failure_code = $2, " +
    "applied_at = CASE WHEN $1 = 'applied' THEN now() ELSE applied_at END, " +
    "updated_at = now() WHERE request_id = $3 AND user_id = $4 " +
    "AND organization_id = $5 AND project_ref = $6 AND status = 'submitted' " +
    "RETURNING request_id",
    [status, failureCode, requestId, current.user_id, current.organization_id, ref]
  );
  return result.rows.length === 1;
}

export function parseSqlRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.result)) return payload.result;
  if (payload && Array.isArray(payload.data)) return payload.data;
  return null;
}

// Sends exactly the committed version-1 schema to the ledger-verified project.
// No paid add-ons, credentials, or owner account are sent to Supabase.
export async function applyCrmFoundationSql(ref, accessToken, {
  fetchFn = fetch, timeoutMs = 25000,
} = {}) {
  if (!REF_PATTERN.test(ref) || typeof accessToken !== "string" || accessToken.length < 8) {
    throw new CrmSchemaPilotError("invalid_provider_request");
  }
  const sql = validateFoundationSql();
  let response;
  try {
    response = await fetchFn(API_BASE + ref + "/database/query", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + accessToken,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: sql }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new CrmSchemaPilotError("provider_outcome_unknown");
  }
  if (!response.ok) {
    throw new CrmSchemaPilotError(
      response.status === 401 || response.status === 403
        ? "provider_permission_denied" : "provider_outcome_unknown"
    );
  }
  return true;
}

export const CRM_SCHEMA_VERIFY_SQL = [
  "select",
  "(select count(*) from pg_catalog.pg_class c",
  "join pg_catalog.pg_namespace n on n.oid=c.relnamespace",
  "where n.nspname='public' and c.relkind='r'",
  "and c.relname in ('business_profile','team_members','customers','rounds',",
  "'customer_services','jobs','payments','message_log')) as table_count,",
  "(select count(*) from pg_catalog.pg_class c",
  "join pg_catalog.pg_namespace n on n.oid=c.relnamespace",
  "where n.nspname='public' and c.relkind='r' and c.relrowsecurity",
  "and c.relname in ('business_profile','team_members','customers','rounds',",
  "'customer_services','jobs','payments','message_log')) as rls_count,",
  "(select count(*) from kleanly_internal.schema_versions where version=1) as version_count",
].join(" ");

export function validateSchemaVerification(payload) {
  const rows = parseSqlRows(payload);
  if (!rows || rows.length !== 1 || !rows[0]) return false;
  const { table_count, rls_count, version_count } = rows[0];
  return Number(table_count) === 8 && Number(rls_count) === 8 &&
    Number(version_count) === 1;
}

export async function verifyCrmSchemaApplied(ref, accessToken, {
  fetchFn = fetch, timeoutMs = 15000,
} = {}) {
  if (!REF_PATTERN.test(ref)) return false;
  const response = await fetchFn(API_BASE + ref + "/database/query", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + accessToken,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: CRM_SCHEMA_VERIFY_SQL, read_only: true }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) return false;
  return validateSchemaVerification(await response.json());
}
