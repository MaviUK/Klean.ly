import {
  constantTimeEqual, permanentMode, requireSameOrigin, safeStatusResponse,
} from "./_lib/connection-vault.mjs";
import { currentPortalSession } from "./_lib/connection-store.mjs";
import {
  isStagingHost, isPilotTarget, pilotSettings, PILOT_PROJECT_NAME,
  readPilotRecord, loadVerifiedGrant, REF_PATTERN,
} from "./_lib/test-project-pilot.mjs";
import {
  readCrmSchemaAttempt,
} from "./_lib/crm-schema-pilot.mjs";
import {
  fetchPilotProject, inspectProjectDetails,
} from "./crm-database-review.mjs";

// Read-only readiness for the separate CRM's FIRST owner account.
// Not an invitation endpoint: no Auth administrative keys, user creation,
// email delivery or owner-claim writes are performed or exposed.
const FIELDS = [
  "owner_profiles", "team_members", "schema_versions", "crm_tables", "rls_tables",
];
export const OWNER_READINESS_SQL = [
  "select",
  "(select count(*) from public.business_profile) as owner_profiles,",
  "(select count(*) from public.team_members) as team_members,",
  "(select count(*) from kleanly_internal.schema_versions where version = 1) as schema_versions,",
  "(select count(*) from pg_catalog.pg_class c",
  "join pg_catalog.pg_namespace n on n.oid = c.relnamespace",
  "where n.nspname = 'public' and c.relkind = 'r' and c.relname in",
  "('business_profile','team_members','customers','rounds','customer_services',",
  "'jobs','payments','message_log')) as crm_tables,",
  "(select count(*) from pg_catalog.pg_class c",
  "join pg_catalog.pg_namespace n on n.oid = c.relnamespace",
  "where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity",
  "and c.relname in ('business_profile','team_members','customers','rounds',",
  "'customer_services','jobs','payments','message_log')) as rls_tables",
].join(" ");

function getRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.result)) return payload.result;
  if (Array.isArray(payload?.data)) return payload.data;
  return null;
}

export function parseOwnerReadiness(payload) {
  const rows = getRows(payload);
  if (!rows || rows.length !== 1 || !rows[0] || typeof rows[0] !== "object") {
    throw new Error("invalid_owner_readiness");
  }
  const result = {};
  for (const field of FIELDS) {
    const value = rows[0][field];
    if (!/^(0|[1-9][0-9]*)$/.test(String(value)) ||
        !Number.isSafeInteger(Number(value))) {
      throw new Error("invalid_owner_readiness");
    }
    result[field] = Number(value);
  }
  // Never return any existing user's email, UUID, tokens, or profile contents.
  return {
    ownerConfigured: result.owner_profiles > 0,
    staffConfigured: result.team_members > 0,
    schemaVersionConfirmed: result.schema_versions === 1,
    eightTablesConfirmed: result.crm_tables === 8,
    eightRlsConfirmed: result.rls_tables === 8,
    ownerRecordCount: result.owner_profiles,
    staffRecordCount: result.team_members,
  };
}

export async function inspectOwnerTables(ref, token, fetchFn = fetch) {
  if (!REF_PATTERN.test(ref) || typeof token !== "string" || token.length < 8) {
    throw new Error("invalid_project_access");
  }
  const response = await fetchFn(
    "https://api.supabase.com/v1/projects/" + ref + "/database/query", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: OWNER_READINESS_SQL, read_only: true }),
      signal: AbortSignal.timeout(15000),
    }
  );
  if (response.status === 401 || response.status === 403) {
    return { permitted: false, reason: "query_permission_required" };
  }
  if (!response.ok) throw new Error("owner_readiness_unavailable");
  return { permitted: true, ...parseOwnerReadiness(await response.json()) };
}

function errorStatus(error, status = 409) {
  return safeStatusResponse({
    mode: "staging_owner_login_readiness",
    error, projectVerified: false, ownerInvitationEnabled: false,
    ownerCreated: false, emailSent: false, writeAttempted: false,
  }, status);
}

export function createOwnerLoginReadinessHandler({
  getSession = currentPortalSession,
  getMode = permanentMode,
  getSettings = pilotSettings,
  getProjectRecord = readPilotRecord,
  getSchemaAttempt = readCrmSchemaAttempt,
  getGrant = loadVerifiedGrant,
  getProject = fetchPilotProject,
  checkTables = inspectOwnerTables,
} = {}) {
  return async function handler(request) {
    if (request.method !== "POST") return errorStatus("Method not allowed", 405);
    if (!requireSameOrigin(request) || !isStagingHost(request)) {
      return errorStatus("Staging access only", 403);
    }
    if (getMode() !== "permanent") {
      return errorStatus("The secure installer is not available", 503);
    }
    let current;
    try { current = await getSession(request); }
    catch { return errorStatus("Unable to check the secure session", 503); }
    if (!current) return errorStatus("Reconnect the test Supabase account", 401);
    if (!constantTimeEqual(request.headers.get("x-csrf-token"), current.csrf_token)) {
      return errorStatus("Session verification failed", 403);
    }
    if (!isPilotTarget(current, getSettings())) {
      return errorStatus("Only the approved staging owner can check this installation", 403);
    }

    // Never trust browser-supplied project refs, owner emails or user IDs.
    // Only the immutable one-project ledger and applied-schema ledger are used.
    let record, schemaAttempt;
    try {
      record = await getProjectRecord(current);
      schemaAttempt = await getSchemaAttempt(current);
    } catch {
      return errorStatus("The pilot installation record is unavailable", 503);
    }
    if (record?.status !== "created" ||
        record?.project_name !== PILOT_PROJECT_NAME ||
        typeof record?.project_ref !== "string" ||
        !REF_PATTERN.test(record.project_ref) ||
        schemaAttempt?.status !== "applied" ||
        schemaAttempt?.project_ref !== record.project_ref ||
        schemaAttempt?.blueprint_version !== 1) {
      return errorStatus("A verified completed CRM installation is required first");
    }
    let token, projectData;
    try {
      token = await getGrant(current);
      projectData = await getProject(record.project_ref, token);
    } catch {
      return errorStatus("Supabase could not verify the test project", 503);
    }
    const details = inspectProjectDetails(projectData, record, current.organization_id);
    if (!details || !details.healthy || details.region !== "eu-central-1") {
      return errorStatus("The test database identity, health or region does not match");
    }

    let inspection;
    try { inspection = await checkTables(record.project_ref, token); }
    catch { return errorStatus("The read-only owner check could not be completed", 503); }
    if (!inspection?.permitted) {
      return safeStatusResponse({
        mode: "staging_owner_login_readiness",
        status: "database_permission_required",
        projectVerified: true, schemaVerified: false,
        projectName: PILOT_PROJECT_NAME, region: details.region,
        ownerInvitationEnabled: false,
        ownerCreated: false, emailSent: false, writeAttempted: false,
        note: "Supabase did not permit the read-only owner record inspection.",
      });
    }

    if (typeof inspection.ownerConfigured !== "boolean" ||
        typeof inspection.staffConfigured !== "boolean" ||
        typeof inspection.eightTablesConfirmed !== "boolean" ||
        typeof inspection.eightRlsConfirmed !== "boolean" ||
        typeof inspection.schemaVersionConfirmed !== "boolean") {
      return errorStatus("Database inspection returned an incomplete result", 503);
    }
    const schemaHealthy = inspection.eightTablesConfirmed &&
      inspection.eightRlsConfirmed && inspection.schemaVersionConfirmed;
    const emptyOwner = !inspection.ownerConfigured && !inspection.staffConfigured;
    const state = !schemaHealthy ? "schema_security_review_required" :
      emptyOwner ? "owner_setup_can_be_prepared" : "owner_already_present";
    return safeStatusResponse({
      mode: "staging_owner_login_readiness",
      state, projectVerified: true,
      projectName: PILOT_PROJECT_NAME, projectRef: record.project_ref,
      region: details.region,
      schemaVerified: schemaHealthy,
      eightTablesConfirmed: inspection.eightTablesConfirmed,
      eightRlsConfirmed: inspection.eightRlsConfirmed,
      ownerConfigured: inspection.ownerConfigured,
      staffConfigured: inspection.staffConfigured,
      readyForInvitationDevelopment: schemaHealthy && emptyOwner,
      ownerInvitationEnabled: false,
      ownerCreated: false, emailSent: false, writeAttempted: false,
      needsOwnerEmailSelection: emptyOwner,
      needsBusinessSiteAndAuthRedirect: emptyOwner,
      note: emptyOwner
        ? "Read-only check: owner login is not yet configured. Owner email and the dedicated CRM website's authentication redirect must be agreed before any invitation is enabled."
        : "Read-only check: a business owner or team member already exists. Review before sending invitations.",
    });
  };
}

export default createOwnerLoginReadinessHandler();
export const config = {
  rateLimit: { action: "rate_limit", aggregateBy: "ip", windowSize: 60, windowLimit: 10 },
};
