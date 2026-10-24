import {
  constantTimeEqual, permanentMode, requireSameOrigin, safeStatusResponse,
} from "./_lib/connection-vault.mjs";
import { currentPortalSession } from "./_lib/connection-store.mjs";
import {
  PILOT_PROJECT_NAME, REF_PATTERN, isPilotTarget, isStagingHost,
  pilotSettings, readPilotRecord, loadVerifiedGrant,
} from "./_lib/test-project-pilot.mjs";
import { createProvisioningPreflight } from "./provisioning-preflight.mjs";

// READ ONLY. A single Supabase Management API query with read_only:true
// checks whether this one separately-approved test project is clean.
// No schema, project, account, payment or website is created or modified.
const API_BASE = "https://api.supabase.com/v1/projects/";
export const SCHEMA_PROBE = [
  "select",
  "(to_regclass('public.cleaners') is not null) as directory_cleaners,",
  "(to_regclass('public.business_customers') is not null) as directory_business_customers,",
  "(to_regclass('public.business_profile') is not null) as business_profile,",
  "(to_regclass('public.team_members') is not null) as team_members,",
  "(to_regclass('public.customers') is not null) as customers,",
  "(to_regclass('public.rounds') is not null) as rounds,",
  "(to_regclass('public.customer_services') is not null) as customer_services,",
  "(to_regclass('public.jobs') is not null) as jobs,",
  "(to_regclass('public.payments') is not null) as payments,",
  "(to_regclass('public.message_log') is not null) as message_log,",
  "(to_regclass('kleanly_internal.schema_versions') is not null) as schema_versions",
].join(" ");

const PROBE_FIELDS = [
  "directory_cleaners", "directory_business_customers", "business_profile",
  "team_members", "customers", "rounds", "customer_services", "jobs",
  "payments", "message_log", "schema_versions",
];

export function interpretSchemaProbe(payload) {
  const rows = Array.isArray(payload) ? payload
    : Array.isArray(payload?.result) ? payload.result
      : Array.isArray(payload?.data) ? payload.data : null;
  if (!rows || rows.length !== 1 || !rows[0] || typeof rows[0] !== "object" ||
      !PROBE_FIELDS.every(field => typeof rows[0][field] === "boolean")) {
    throw new Error("invalid_sql_probe");
  }
  const record = rows[0];
  const directoryTablesPresent = record.directory_cleaners ||
    record.directory_business_customers;
  const existingCrmTables = PROBE_FIELDS.filter(field =>
    !["directory_cleaners", "directory_business_customers"].includes(field) &&
    record[field]).length;
  return {
    directoryTablesPresent,
    existingCrmTables,
    emptyForCrm: !directoryTablesPresent && existingCrmTables === 0,
  };
}

export function validatePilotProjectRecord(record) {
  return record?.status === "created" &&
    record?.project_name === PILOT_PROJECT_NAME &&
    typeof record.project_ref === "string" &&
    REF_PATTERN.test(record.project_ref);
}

export function inspectProjectDetails(project, record, organizationId) {
  const id = project?.ref ?? project?.id;
  if (id !== record.project_ref || project.name !== PILOT_PROJECT_NAME ||
      project.organization_id !== organizationId) {
    return null;
  }
  return {
    region: typeof project.region === "string" && /^[a-z0-9-]{2,40}$/.test(project.region)
      ? project.region : null,
    healthy: project.status === "ACTIVE_HEALTHY",
  };
}

export async function fetchPilotProject(ref, token, fetchFn = fetch) {
  const response = await fetchFn(API_BASE + ref, {
    method: "GET",
    headers: { Authorization: "Bearer " + token, Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error("project_metadata_unavailable");
  return response.json();
}

export async function probePilotSchema(ref, token, fetchFn = fetch) {
  const response = await fetchFn(API_BASE + ref + "/database/query", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: SCHEMA_PROBE, read_only: true }),
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 401 || response.status === 403) {
    return { permitted: false, unavailable: "permissions_required" };
  }
  if (!response.ok) {
    return { permitted: false, unavailable: "query_unavailable" };
  }
  return { permitted: true, schema: interpretSchemaProbe(await response.json()) };
}

function safeFailure(message, status = 409) {
  return safeStatusResponse({
    error: message, mode: "read_only_staging_crm_review",
    projectVerified: false, schemaVerified: false, installationEnabled: false,
    schemaInstalled: false, writeAttempted: false,
  }, status);
}

export function createCrmDatabaseReviewHandler({
  getSession = currentPortalSession,
  getSettings = pilotSettings,
  getMode = permanentMode,
  checkReadiness = createProvisioningPreflight(),
  readRecord = readPilotRecord,
  getGrant = loadVerifiedGrant,
  getProject = fetchPilotProject,
  checkSchema = probePilotSchema,
} = {}) {
  return async function handler(request) {
    if (request.method !== "POST") return safeFailure("Method not allowed", 405);
    if (!requireSameOrigin(request) || !isStagingHost(request)) {
      return safeFailure("Staging access only", 403);
    }
    if (getMode() !== "permanent") {
      return safeFailure("Secure test installer is unavailable", 503);
    }
    let current;
    try { current = await getSession(request); }
    catch { return safeFailure("Secure account session could not be checked", 503); }
    if (!current) return safeFailure("Reconnect your test Supabase account", 401);
    if (!constantTimeEqual(request.headers.get("x-csrf-token"), current.csrf_token)) {
      return safeFailure("Session verification failed", 403);
    }
    if (!isPilotTarget(current, getSettings())) {
      return safeFailure("Only the verified test organisation may review this database", 403);
    }

    // Rely on the existing refreshed grants, identity checks and account
    // inventory. Never accept a project ref or organisation from the browser.
    let preflight;
    try {
      const response = await checkReadiness(request);
      if (!response?.ok) return safeFailure("Recheck the connected Supabase and Netlify accounts");
      preflight = await response.json();
    } catch {
      return safeFailure("Infrastructure readiness could not be confirmed", 503);
    }
    if (preflight.supabaseVerified !== true ||
        preflight.netlifyVerified !== true ||
        preflight.organizationName !== current.organization_name ||
        !Number.isSafeInteger(preflight.observedProjectCount) ||
        preflight.observedProjectCount < 1) {
      return safeFailure("Provider ownership checks are incomplete");
    }

    let record;
    try { record = await readRecord(current); }
    catch { return safeFailure("The secure project record is unavailable", 503); }
    if (!validatePilotProjectRecord(record)) {
      return safeFailure("The completed staging project record could not be verified");
    }

    let token, metadata;
    try {
      token = await getGrant(current);
      metadata = await getProject(record.project_ref, token);
    } catch {
      return safeFailure("Supabase could not verify the created project", 503);
    }
    const project = inspectProjectDetails(metadata, record, current.organization_id);
    if (!project) return safeFailure("The Supabase project identity does not match this test installation", 409);
    if (!project.healthy || !project.region) {
      return safeStatusResponse({
        mode: "read_only_staging_crm_review",
        projectVerified: true,
        schemaVerified: false,
        state: "project_not_ready",
        projectName: PILOT_PROJECT_NAME,
        projectRef: record.project_ref,
        region: project.region,
        installationEnabled: false, schemaInstalled: false, writeAttempted: false,
        note: "Wait until Supabase reports a healthy project before proceeding.",
      });
    }

    let probe;
    try { probe = await checkSchema(record.project_ref, token); }
    catch { return safeFailure("The read-only database check returned an invalid response", 503); }
    if (!probe?.permitted) {
      return safeStatusResponse({
        mode: "read_only_staging_crm_review",
        state: probe?.unavailable === "permissions_required"
          ? "database_permission_required" : "database_check_unavailable",
        projectVerified: true, schemaVerified: false,
        projectName: PILOT_PROJECT_NAME, projectRef: record.project_ref, region: project.region,
        installationEnabled: false, schemaInstalled: false, writeAttempted: false,
        note: probe?.unavailable === "permissions_required"
          ? "Supabase did not grant database query access to the installer OAuth connection."
          : "The Supabase database inspection is temporarily unavailable.",
      });
    }
    const result = probe.schema;
    if (!result || typeof result.directoryTablesPresent !== "boolean" ||
        !Number.isSafeInteger(result.existingCrmTables) ||
        typeof result.emptyForCrm !== "boolean") {
      return safeFailure("Database check result was incomplete", 503);
    }
    const state = result.directoryTablesPresent ? "directory_tables_blocked"
      : result.emptyForCrm ? "schema_ready_for_approval" : "existing_schema_needs_review";
    return safeStatusResponse({
      mode: "read_only_staging_crm_review", state,
      projectVerified: true, schemaVerified: true,
      projectName: PILOT_PROJECT_NAME,
      projectRef: record.project_ref, region: project.region,
      directoryTablesPresent: result.directoryTablesPresent,
      existingCrmTables: result.existingCrmTables,
      readyForSeparateApproval: state === "schema_ready_for_approval",
      installationEnabled: false, schemaInstalled: false, writeAttempted: false,
      note: "Read-only check only. A separate approval will be required before installing CRM tables.",
    });
  };
}

export default createCrmDatabaseReviewHandler();

export const config = {
  rateLimit: { action: "rate_limit", aggregateBy: "ip", windowSize: 60, windowLimit: 10 },
};
