import { createHash } from "node:crypto";
import {
  constantTimeEqual, permanentMode, requireSameOrigin, safeStatusResponse,
} from "./_lib/connection-vault.mjs";
import { currentPortalSession } from "./_lib/connection-store.mjs";
import {
  isPilotTarget, isStagingHost, pilotSettings, readPilotRecord, REF_PATTERN,
} from "./_lib/test-project-pilot.mjs";
import { readCrmSchemaAttempt } from "./_lib/crm-schema-pilot.mjs";
import {
  readCrmSiteAttempt, CRM_SITE_OWNER_EMAIL,
} from "./_lib/crm-site-pilot.mjs";
import { verifyCrmDeployLedgers } from "./crm-deployment-readiness.mjs";
import { PILOT_PROJECT_NAME } from "./_lib/test-project-pilot.mjs";
import { CRM_SITE_TEAM_SLUG } from "./_lib/crm-site-pilot.mjs";
import { PILOT_CRM_SITE_NAME } from "./crm-site-proposal.mjs";

// Read-only, staging-only. The supplied *publishable* key is NEVER persisted,
// logged, reflected in a response, used for Auth admin, or placed in a build.
// Supabase API gateway itself confirms whether it belongs to this project.
// This is the current, UNDEPLOYED runtime source pin, not the source of truth
// for the installer-created project. The original immutable project/site/schema
// ledgers must agree before any test-key check. A mismatching pin blocks release.
const RUNTIME_SOURCE_PIN = "nlupgjwcyivepzgqffss";
const TEST_NETLIFY_SITE_ID = "c4632a28-a4b0-4e77-a54e-7a8bf05a8882";
const PUBLISHABLE = /^sb_publishable_[A-Za-z0-9_-]{16,200}$/;

// Only safe, fixed-value diagnostics, available after the authenticated
// test account, same-origin and CSRF checks have passed. Never expose raw
// ledger rows, user IDs, project metadata or credentials.
export function diagnosePilotLedgerMismatch(current,site,project,schema) {
  if(!site) return "site_record_missing";
  if(!project) return "database_record_missing";
  if(!schema) return "schema_record_missing";
  if(site.status!=="created") return "site_not_created";
  if(site.site_name!==PILOT_CRM_SITE_NAME) return "site_name_mismatch";
  if(site.site_id!==TEST_NETLIFY_SITE_ID) return "site_id_mismatch";
  if(site.netlify_team_slug!==CRM_SITE_TEAM_SLUG) return "site_team_mismatch";
  if(site.user_id!==current?.user_id ||
     site.organization_id!==current?.organization_id) return "site_owner_binding_mismatch";
  if(project.status!=="created") return "database_not_created";
  if(project.project_name!==PILOT_PROJECT_NAME) return "database_name_mismatch";
  if(!REF_PATTERN.test(project.project_ref || "")) return "database_reference_invalid";
  if(site.supabase_project_ref!==project.project_ref) return "site_database_reference_mismatch";
  if(schema.status!=="applied") return "schema_not_applied";
  if(schema.project_ref!==project.project_ref) return "schema_database_reference_mismatch";
  if(schema.blueprint_version!==1) return "schema_version_mismatch";
  if(!verifyCrmDeployLedgers(current,site,project,schema)){
    return "linked_records_mismatch";
  }
  return null;
}

function failure(message, status=409, diagnosticCode=null) {
  return safeStatusResponse({
    mode: "read_only_crm_publishable_key_review",
    error:message,
    ...(diagnosticCode?{diagnosticCode}:{}),
    publishableKeyVerified:false,
    keyPersisted:false, websiteDeployed:false,
    ownerCreated:false, emailSent:false, databaseModified:false,
  },status);
}
export function validatePilotPublishableKey(key) {
  // No trim/normalisation: a key with hidden whitespace must be rejected.
  if (typeof key!=="string" || !PUBLISHABLE.test(key)) {
    throw new Error("publishable_key_format_required");
  }
  return key;
}
export async function inspectPilotPublishableKey(key, verifiedProjectRef,fetchFn=fetch) {
  validatePilotPublishableKey(key);
  // verifiedProjectRef may only be supplied by the authenticated caller
  // after all three original installer ledgers agree. No user-supplied ref.
  if(!REF_PATTERN.test(verifiedProjectRef || "")) {
    throw new Error("verified_project_reference_required");
  }
  const response=await fetchFn(
    "https://" + verifiedProjectRef + ".supabase.co/auth/v1/settings",{
    method:"GET",cache:"no-store",redirect:"error",credentials:"omit",
    headers:{
      apikey:key,Accept:"application/json",
    },
    signal:AbortSignal.timeout(15000),
  });
  if (response.status===401||response.status===403) {
    throw new Error("publishable_key_not_accepted");
  }
  if (!response.ok) throw new Error("auth_settings_unavailable");
  const payload=await response.json();
  if (!payload || typeof payload!=="object" ||
      typeof payload.disable_signup!=="boolean") {
    throw new Error("public_auth_settings_not_verifiable");
  }
  // Deliberately discard ALL provider fields, including config metadata.
  return Object.freeze({
    keyAccepted:true,
    publicSignupsDisabled:payload.disable_signup,
    // Fingerprint only, never the submitted key.
    fingerprint:createHash("sha256").update(key).digest("hex").slice(0,12),
  });
}

export function createCrmPublishableKeyReviewHandler({
  getMode=permanentMode,
  getSession=currentPortalSession,
  getSettings=pilotSettings,
  getSiteLedger=readCrmSiteAttempt,
  getProjectLedger=readPilotRecord,
  getSchemaLedger=readCrmSchemaAttempt,
  inspectKey=inspectPilotPublishableKey,
}={}) {
  return async function handler(request) {
    if(request.method!=="POST")return failure("Method not allowed",405);
    if(!isStagingHost(request)||!requireSameOrigin(request)) {
      return failure("Staging only",403);
    }
    if(getMode()!=="permanent")return failure("Secure staging portal unavailable",503);
    let current;
    try {current=await getSession(request);}catch{return failure("Secure session unavailable",503);}
    if(!current)return failure("Reconnect your test account",401);
    if(!constantTimeEqual(request.headers.get("x-csrf-token"),current.csrf_token)){
      return failure("Session verification failed",403);
    }
    const settings=getSettings();
    if(!isPilotTarget(current,settings)||
      settings.ownerEmail!==CRM_SITE_OWNER_EMAIL) {
      return failure("Only the approved test account can check its key",403);
    }
    if(!/application\/json(?:\s*;|$)/i.test(request.headers.get("content-type")||"")){
      return failure("Expected JSON request",415);
    }

    let records;
    try {
      records=await Promise.all([
        getSiteLedger(current),getProjectLedger(current),getSchemaLedger(current),
      ]);
    }catch{return failure("Test installation record could not be verified",503);}
    const diagnosticCode=diagnosePilotLedgerMismatch(current,...records);
    if(diagnosticCode!==null){
      return failure("This request does not match the separate test CRM",403,diagnosticCode);
    }
    // The test database project was created by this installer, recorded in a
    // single immutable project ledger, and copied into its site + schema
    // ledgers. Keep that authoritative ref distinct from an unreviewed pin in
    // the not-yet-deployed CRM source.
    const verifiedProjectRef=records[1].project_ref;
    const runtimeSourceMatches=verifiedProjectRef===RUNTIME_SOURCE_PIN;
    let key;
    try {
      const raw=await request.text();
      if(raw.length>512)throw new Error("request_too_large");
      const body=JSON.parse(raw);
      if(!body||typeof body!=="object"||Array.isArray(body)||
         Object.keys(body).length!==1){
        throw new Error("unexpected_input");
      }
      // This is a separate read-only access check. No key is needed and
      // no Supabase Auth endpoint is contacted.
      if(body.action==="preflight" && Object.keys(body)[0]==="action"){
        return safeStatusResponse({
          mode:"read_only_crm_publishable_key_review",
          state:runtimeSourceMatches
            ? "staging_access_verified"
            : "runtime_reference_review_required",
          pilotAccessVerified:true,
          verifiedProjectRef,
          runtimeSourceProjectRef:RUNTIME_SOURCE_PIN,
          runtimeSourceMatches,
          publishableKeyVerified:false,
          keyPersisted:false,websiteDeployed:false,
          deploymentApproved:false,
          ownerCreated:false,emailSent:false,databaseModified:false,
          note:runtimeSourceMatches
            ? "The original website, project and schema records agree. The runtime source pin also matches. No changes were made."
            : "The original website, project and schema records agree with each other, but the UNDEPLOYED CRM runtime is pinned to another project. Source review is required before deployment; no key is needed.",
        });
      }
      if(!Object.hasOwn(body,"publishableKey"))throw new Error("unexpected_input");
      key=validatePilotPublishableKey(body.publishableKey);
    }catch{return failure("Enter only a Supabase publishable key",400);}
    if(!runtimeSourceMatches) {
      return failure("The undeployed CRM source project reference requires review",409,
        "runtime_reference_mismatch");
    }
    try {
      const check=await inspectKey(key,verifiedProjectRef);
      if(check?.keyAccepted!==true ||
         typeof check.publicSignupsDisabled!=="boolean"||
         typeof check.fingerprint!=="string"||
         !/^[a-f0-9]{12}$/.test(check.fingerprint)){
        throw new Error("incomplete_key_review");
      }
      return safeStatusResponse({
        mode:"read_only_crm_publishable_key_review",
        state:check.publicSignupsDisabled?"publishable_key_verified":"signup_security_review_required",
        publishableKeyVerified:true,
        publicSignupsDisabled:check.publicSignupsDisabled,
        fingerprint:check.fingerprint,
        verifiedProjectRef,
        runtimeSourceMatches:true,
        keyPersisted:false,
        deploymentApproved:false,websiteDeployed:false,
        ownerCreated:false,emailSent:false,databaseModified:false,
        note:check.publicSignupsDisabled
          ? "The dedicated test project accepts this publishable key. No key was stored. Separate owner and deployment approvals are still required."
          : "The key is recognised, but public sign-ups must be disabled before the test CRM can be approved.",
      });
    }catch{
      return failure("The dedicated test Supabase could not verify this publishable key",422);
    }
  };
}
export default createCrmPublishableKeyReviewHandler();
export const config={
  rateLimit:{action:"rate_limit",aggregateBy:"ip",windowSize:60,windowLimit:8},
};
