import { createHash } from "node:crypto";
import {
  constantTimeEqual, permanentMode, requireSameOrigin, safeStatusResponse,
} from "./_lib/connection-vault.mjs";
import { currentPortalSession } from "./_lib/connection-store.mjs";
import {
  isPilotTarget, isStagingHost, pilotSettings, readPilotRecord,
} from "./_lib/test-project-pilot.mjs";
import { readCrmSchemaAttempt } from "./_lib/crm-schema-pilot.mjs";
import {
  readCrmSiteAttempt, CRM_SITE_OWNER_EMAIL,
} from "./_lib/crm-site-pilot.mjs";
import { verifyCrmDeployLedgers } from "./crm-deployment-readiness.mjs";

// Read-only, staging-only. The supplied *publishable* key is NEVER persisted,
// logged, reflected in a response, used for Auth admin, or placed in a build.
// Supabase API gateway itself confirms whether it belongs to this project.
const TEST_PROJECT_REF = "nlupgjwcyivepzgqffss";
const TEST_NETLIFY_SITE_ID = "c4632a28-a4b0-4e77-a54e-7a8bf05a8882";
const AUTH_PUBLIC_SETTINGS =
  "https://" + TEST_PROJECT_REF + ".supabase.co/auth/v1/settings";
const PUBLISHABLE = /^sb_publishable_[A-Za-z0-9_-]{16,200}$/;

function failure(message, status=409) {
  return safeStatusResponse({
    mode: "read_only_crm_publishable_key_review",
    error:message,
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
export async function inspectPilotPublishableKey(key,fetchFn=fetch) {
  validatePilotPublishableKey(key);
  const response=await fetchFn(AUTH_PUBLIC_SETTINGS,{
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
    if(!verifyCrmDeployLedgers(current,...records) ||
       records[0].site_id!==TEST_NETLIFY_SITE_ID ||
       records[1].project_ref!==TEST_PROJECT_REF ||
       records[2].project_ref!==TEST_PROJECT_REF) {
      return failure("This request does not match the separate test CRM",403);
    }
    let key;
    try {
      const raw=await request.text();
      if(raw.length>512)throw new Error("request_too_large");
      const body=JSON.parse(raw);
      if(!body||typeof body!=="object"||Array.isArray(body)||
         Object.keys(body).length!==1||!Object.hasOwn(body,"publishableKey")){
        throw new Error("unexpected_input");
      }
      key=validatePilotPublishableKey(body.publishableKey);
    }catch{return failure("Enter only a Supabase publishable key",400);}

    try {
      const check=await inspectKey(key);
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
