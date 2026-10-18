import { requireSameOrigin, safeStatusResponse } from "./_lib/connection-vault.mjs";
import { PILOT_PROJECT_NAME, isStagingHost, REF_PATTERN } from "./_lib/test-project-pilot.mjs";
import { createCrmDatabaseReviewHandler } from "./crm-database-review.mjs";

// This is a staging-only, read-only proposal for the existing blueprint.
// The confirmation/application endpoint is deliberately NOT provided yet.
// No browser-supplied project ref, owner, SQL, or organization is accepted.
export const CRM_BLUEPRINT_VERSION = 1;
export const CRM_BLUEPRINT_TABLES = Object.freeze([
  { name: "business_profile", purpose: "Company identity and owner" },
  { name: "team_members", purpose: "Worker and administrator memberships" },
  { name: "customers", purpose: "Customer contact details and addresses" },
  { name: "rounds", purpose: "Recurring cleaning rounds" },
  { name: "customer_services", purpose: "Subscribed customer cleaning services" },
  { name: "jobs", purpose: "Scheduled and completed cleans" },
  { name: "payments", purpose: "Payment record and status tracking" },
  { name: "message_log", purpose: "SMS and email delivery records" },
]);

export function verifiedForSchemaProposal(data) {
  return data?.mode === "read_only_staging_crm_review" &&
    data?.state === "schema_ready_for_approval" &&
    data?.projectVerified === true &&
    data?.schemaVerified === true &&
    data?.readyForSeparateApproval === true &&
    data?.directoryTablesPresent === false &&
    data?.existingCrmTables === 0 &&
    data?.installationEnabled === false &&
    data?.schemaInstalled === false &&
    data?.writeAttempted === false &&
    data?.projectName === PILOT_PROJECT_NAME &&
    typeof data?.projectRef === "string" &&
    REF_PATTERN.test(data.projectRef) &&
    typeof data?.region === "string" &&
    /^[a-z0-9-]{2,40}$/.test(data.region);
}

function unavailable(error, status = 409) {
  return safeStatusResponse({
    mode: "read_only_crm_schema_proposal",
    readyForOwnerApproval: false,
    schemaInstallEnabled: false,
    schemaApplied: false,
    writeAttempted: false,
    error,
  }, status);
}

export function createCrmSchemaProposalHandler({
  reviewDatabase = createCrmDatabaseReviewHandler(),
} = {}) {
  return async function handler(request) {
    if (request.method !== "POST") return unavailable("Method not allowed", 405);
    if (!requireSameOrigin(request) || !isStagingHost(request)) {
      return unavailable("Staging access only", 403);
    }
    let report;
    try {
      const response = await reviewDatabase(request);
      if (!response?.ok) {
        return unavailable("The separate CRM database check must pass first");
      }
      report = await response.json();
    } catch {
      return unavailable("The CRM database could not be verified", 503);
    }
    if (!verifiedForSchemaProposal(report)) {
      return unavailable(
        "The project must be healthy, empty, and independently verified before reviewing the CRM schema"
      );
    }

    return safeStatusResponse({
      mode: "read_only_crm_schema_proposal",
      projectName: PILOT_PROJECT_NAME,
      projectRef: report.projectRef,
      region: report.region,
      blueprintVersion: CRM_BLUEPRINT_VERSION,
      publicTables: CRM_BLUEPRINT_TABLES,
      internalTrackingTable: "kleanly_internal.schema_versions",
      rowLevelSecurityIncluded: true,
      ownerBootstrapIncluded: false,
      customerDataCopied: false,
      paidAddonsRequested: false,
      readyForOwnerApproval: true,
      separateOwnerConfirmationRequired: true,
      schemaInstallEnabled: false,
      schemaApplied: false,
      writeAttempted: false,
      note: "Review only. No database objects or accounts were created. " +
        "The one-time schema installer will be implemented and enabled only " +
        "after separate approval. Owner login and CRM app will still require later work.",
    });
  };
}

export default createCrmSchemaProposalHandler();

export const config = {
  rateLimit: { action: "rate_limit", aggregateBy: "ip", windowSize: 60, windowLimit: 10 },
};
