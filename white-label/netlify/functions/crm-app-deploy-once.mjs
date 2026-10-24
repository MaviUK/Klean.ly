// One independently authorised deploy to the EXISTING CRM pilot site.
// No site creation, paid addons, owner bootstrap, invitation or SMTP.
// Completely separate from the real Klean.ly directory and its databases.
import {createHash} from "node:crypto";
import {constantTimeEqual,permanentMode,requireSameOrigin,safeStatusResponse} from "./_lib/connection-vault.mjs";
import {currentPortalSession} from "./_lib/connection-store.mjs";
import {isPilotTarget,isStagingHost,pilotSettings,readPilotRecord,PILOT_PROJECT_NAME} from "./_lib/test-project-pilot.mjs";
import {readCrmSchemaAttempt} from "./_lib/crm-schema-pilot.mjs";
import {
  readCrmSiteAttempt,CRM_SITE_OWNER_EMAIL,CRM_SITE_TEAM_SLUG,
} from "./_lib/crm-site-pilot.mjs";
import {
  loadVerifiedNetlifyPilotGrant,PILOT_CRM_SITE_NAME,NETLIFY_API,
} from "./crm-site-proposal.mjs";
import {verifyCrmDeployLedgers,inspectCrmDeploymentTarget} from "./crm-deployment-readiness.mjs";
import {inspectPilotPublishableKey,validatePilotPublishableKey} from "./crm-publishable-key-review.mjs";
import {ZIP_CONSENT_PHRASE,buildEmbeddedCrmZip} from "../../provisioning/create-embedded-crm-zip.mjs";
import {RELEASE_PILOT_SITE_ID,RELEASE_PILOT_SUPABASE,RELEASE_PILOT_URL} from "../../provisioning/prepare-crm-release.mjs";
import {
  getPilotDeployAttempt,reservePilotDeploy,markPilotDeploySubmitted,
  recordPilotDeployId,finishPilotDeploy,publicDeployStatus,
} from "../../provisioning/first-crm-deploy-ledger.mjs";

const PROJECT_REF=new URL(RELEASE_PILOT_SUPABASE).hostname.split(".")[0];
const DEPLOY_ID=/^[\w:-]{8,128}$/;
const CONTEXT="staging_exact_first_crm_deploy";
const allowedPostState=new Set(["ready","current","building","uploading","uploaded","processing","preparing","prepared","enqueued"]);
const doneState=new Set(["ready","current"]);
const UNTRUSTED_ERROR="Netlify deployment needs manual review. Do not submit another deployment.";

export function pilotCrmDeployEnabled(env=process.env){
  return env.KLEANLY_TEST_CRM_DEPLOY_ENABLED==="true";
}
function status(state,extra={},code=200){
  return safeStatusResponse({
    mode:CONTEXT,state,targetSite:RELEASE_PILOT_URL,
    projectRef:PROJECT_REF,
    firstDeploymentOnly:true,automaticRetryAllowed:false,
    ownerCreated:false,emailSent:false,customerDataChanged:false,
    ...extra,
  },code);
}
function fail(state,code=409,extra={}){
  return status(state,{error:state,deployAttempted:false,...extra},code);
}
function exactLedgers(current,site,project,schema) {
  return verifyCrmDeployLedgers(current,site,project,schema) &&
    site.site_id===RELEASE_PILOT_SITE_ID &&
    site.netlify_team_slug===CRM_SITE_TEAM_SLUG &&
    site.supabase_project_ref===PROJECT_REF &&
    project.project_name===PILOT_PROJECT_NAME &&
    project.project_ref===PROJECT_REF && schema.project_ref===PROJECT_REF;
}
export async function parseCrmDeployConsent(request){
  if(request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()
     !=="application/json")throw new Error("invalid_content_type");
  const raw=await request.text();
  if(raw.length>700)throw new Error("request_too_large");
  let body;
  try{body=JSON.parse(raw);}catch{throw new Error("invalid_json");}
  const keys=["confirmation","acknowledgeCredits","acknowledgeOneDeploy","publishableKey"];
  if(!body||typeof body!=="object"||Array.isArray(body)||
     Object.keys(body).length!==keys.length ||
     !keys.every(k=>Object.hasOwn(body,k))||
     body.confirmation!==ZIP_CONSENT_PHRASE ||
     body.acknowledgeCredits!==true || body.acknowledgeOneDeploy!==true){
    throw new Error("explicit_deployment_approval_required");
  }
  validatePilotPublishableKey(body.publishableKey);
  return {publishableKey:body.publishableKey};
}
function providerHeaders(accessToken){
  if(typeof accessToken!=="string"||accessToken.length<8||accessToken.length>8192){
    throw new Error("netlify_token_unavailable");
  }
  return {Authorization:"Bearer "+accessToken,Accept:"application/json"};
}

export async function submitExactCrmZip(accessToken,zip,{
  fetchFn=fetch,timeoutMs=25000,
}={}){
  if(!(zip instanceof Uint8Array)||!zip.length||zip.length>3500000){
    throw new Error("deploy_archive_invalid");
  }
  let response;
  try{
    response=await fetchFn(NETLIFY_API+"/sites/"+RELEASE_PILOT_SITE_ID+"/deploys",{
      method:"POST",
      headers:{...providerHeaders(accessToken),"Content-Type":"application/zip"},
      body:zip,
      signal:AbortSignal.timeout(timeoutMs),
    });
  }catch{throw new Error("netlify_deploy_outcome_unknown");}
  // Even a non-2xx response does not prove Netlify didn't start processing.
  if(response.status!==200&&response.status!==201){
    throw new Error("netlify_deploy_outcome_unknown");
  }
  let data;
  try{data=await response.json();}catch{
    throw new Error("netlify_deploy_outcome_unknown");
  }
  if(!DEPLOY_ID.test(data?.id||"") ||
      (data.site_id!==undefined&&data.site_id!==RELEASE_PILOT_SITE_ID) ||
      (data.name!==undefined&&data.name!==PILOT_CRM_SITE_NAME) ||
      (data.state!==undefined&&!allowedPostState.has(data.state))){
    throw new Error("netlify_deploy_outcome_unknown");
  }
  return {deployId:data.id};
}

export async function checkExactCrmDeploy(accessToken,deployId,{
  fetchFn=fetch,timeoutMs=15000,
}={}){
  if(!DEPLOY_ID.test(deployId||""))throw new Error("invalid_deploy_id");
  const response=await fetchFn(
    NETLIFY_API+"/sites/"+RELEASE_PILOT_SITE_ID+"/deploys/"+deployId,{
      method:"GET",headers:providerHeaders(accessToken),
      signal:AbortSignal.timeout(timeoutMs),
    });
  if(!response.ok)throw new Error("netlify_deploy_status_unknown");
  const body=await response.json();
  if(body?.id!==deployId || body.site_id!==RELEASE_PILOT_SITE_ID ||
     (body.name!==undefined&&body.name!==PILOT_CRM_SITE_NAME) ||
     typeof body.state!=="string")throw new Error("wrong_deploy_identity");
  return {ready:doneState.has(body.state),state:body.state,deployId};
}
async function reviewSession(request,getSession,getMode,getSettings){
  if(!isStagingHost(request)||!requireSameOrigin(request))return {error:"staging_only",code:403};
  if(getMode()!=="permanent")return {error:"secure_staging_unavailable",code:503};
  let current;
  try{current=await getSession(request);}catch{return {error:"session_unavailable",code:503};}
  if(!current)return {error:"test_account_not_connected",code:401};
  if(!constantTimeEqual(request.headers.get("x-csrf-token"),current.csrf_token)){
    return {error:"session_verification_failed",code:403};
  }
  if(!isPilotTarget(current,getSettings()) ||
     getSettings().ownerEmail!==CRM_SITE_OWNER_EMAIL){
    return {error:"test_owner_not_authorised",code:403};
  }
  return {current};
}

export function createOneCrmAppDeployHandler({
  isEnabled=pilotCrmDeployEnabled,getMode=permanentMode,
  getSession=currentPortalSession,getSettings=pilotSettings,
  getSite=readCrmSiteAttempt,getProject=readPilotRecord,
  getSchema=readCrmSchemaAttempt,getGrant=loadVerifiedNetlifyPilotGrant,
  inspectSite=inspectCrmDeploymentTarget,
  inspectKey=inspectPilotPublishableKey,
  createZip=buildEmbeddedCrmZip,
  readAttempt=getPilotDeployAttempt,reserve=reservePilotDeploy,
  markSubmitted=markPilotDeploySubmitted,recordId=recordPilotDeployId,
  finish=finishPilotDeploy,
  deployZip=submitExactCrmZip,checkDeploy=checkExactCrmDeploy,
}={}){
  return async function handler(request){
    if(request.method!=="GET"&&request.method!=="POST")return fail("method_not_allowed",405);
    // IsEnabled is a release control separate from the user's one-time
    // explicit consent at point of deployment.
    if(!isEnabled())return fail("deployment_locked",423);
    const checked=await reviewSession(request,getSession,getMode,getSettings);
    if(checked.error)return fail(checked.error,checked.code);
    const current=checked.current;

    // Prefer a same-origin POST for read-only status checks: browsers may
    // legitimately omit the Origin header on GET requests.
    // The status-only query selector never triggers an upload.
    if(request.method==="GET" ||
       (request.method==="POST" && new URL(request.url).searchParams.get("status")==="1")){
      let prior;
      try{prior=await readAttempt(current);}
      catch{return fail("deployment_record_unavailable",503);}
      const summary=publicDeployStatus(prior);
      if(!prior || summary.state==="ready" || summary.state==="unknown" ||
         summary.state==="reserved" || !summary.deployId){
        return status(summary.state,{deployId:summary.deployId,
          canSubmit:!prior,needsManualReview:Boolean(prior&&summary.state!=="ready")});
      }
      try{
        const grant=await getGrant(current);
        if(grant?.netlifyAccountEmail!==CRM_SITE_OWNER_EMAIL ||
           grant?.netlifyUserId!==prior.netlify_user_id){
          return fail("test_netlify_account_changed",403);
        }
        const live=await checkDeploy(grant.accessToken,summary.deployId);
        if(live.ready){
          const saved=await finish(current,prior.request_id,"ready",{deployId:summary.deployId});
          if(!saved)return fail("deployment_record_manual_review",503);
          return status("ready",{deployId:summary.deployId,canSubmit:false});
        }
        return status("submitted",{deployId:summary.deployId,canSubmit:false,
          needsManualReview:!allowedPostState.has(live.state)});
      }catch{return fail("deployment_status_not_confirmed",503);}
    }

    let key;
    try{({publishableKey:key}=await parseCrmDeployConsent(request));}
    catch{return fail("explicit_deployment_approval_required",400);}
    let site,project,schema,grant,inspection;
    try{
      [site,project,schema]=await Promise.all([
        getSite(current),getProject(current),getSchema(current)
      ]);
      if(!exactLedgers(current,site,project,schema))return fail("pilot_records_do_not_match",403);
      const prior=await readAttempt(current);
      if(prior)return fail("one_deploy_already_attempted",409,{
        deployAttempted:true,existing:publicDeployStatus(prior),
      });
      grant=await getGrant(current);
      if(grant?.netlifyAccountEmail!==CRM_SITE_OWNER_EMAIL ||
         grant?.netlifyUserId!==site.netlify_user_id){
        return fail("wrong_test_netlify_owner",403);
      }
      inspection=await inspectSite(grant.accessToken,site);
      if(inspection?.confirmedFreePlan!==true ||
         inspection.siteEmpty!==true ||
         inspection.hasExistingDeploy!==false ||
         inspection.linkedRepository!==false ||
         inspection.readyToPrepareCrmPackage!==true){
        return fail("test_site_is_not_empty_or_free",409);
      }
      const keyResult=await inspectKey(key,project.project_ref);
      if(keyResult?.keyAccepted!==true || keyResult?.publicSignupsDisabled!==true){
        return fail("test_publishable_key_or_auth_not_verified",422);
      }
    }catch{return fail("test_provider_preflight_unavailable",503);}

    let archive;
    try{
      archive=createZip({
        publishableKey:key,
        approval:{
          approvalPhrase:"PREPARE ONE CRM TEST BUILD",
          separateDeploymentApprovalRequired:true,
          siteCreateAllowed:false,emailSendAllowed:false,
        },
      });
      if(archive.siteId!==RELEASE_PILOT_SITE_ID ||
         archive.siteUrl!==RELEASE_PILOT_URL ||
         archive.fileCount!==10 ||
         !/^[a-f0-9]{64}$/.test(archive.sha256||"")||
         !/^[a-f0-9]{64}$/.test(archive.sourceHash||"")||
         !(archive.zip instanceof Uint8Array)){
        return fail("crm_package_not_ready",503);
      }
    }catch{return fail("crm_package_not_ready",503);}

    let reservation;
    try{reservation=await reserve(current,{
      projectRef:project.project_ref,siteId:site.site_id,
      teamId:site.netlify_team_id,netlifyUserId:grant.netlifyUserId,
      sourceHash:archive.sourceHash,archiveHash:archive.sha256,
    });}catch{return fail("deployment_reservation_unavailable",503);}
    if(!reservation?.reserved)return fail("one_deploy_already_attempted",409);
    let submitted;
    try{submitted=await markSubmitted(current,reservation.requestId);}
    catch{return fail("deployment_submission_lock_missing",503);}
    if(!submitted)return fail("deployment_submission_lock_missing",503);

    // THIS IS THE ONLY WRITE TO NETLIFY. Never retry, even if response is
    // lost, status 5xx is returned, or the user refreshes the browser.
    let result;
    try{result=await deployZip(grant.accessToken,archive.zip);}
    catch{
      try{await finish(current,reservation.requestId,"unknown",{reason:"netlify_response_uncertain"});}
      catch{/* one-time unique lock remains even when ledger update fails */}
      return fail("deployment_outcome_unknown_manual_review",503,{deployAttempted:true});
    }

    let idSaved;
    try{idSaved=await recordId(current,reservation.requestId,result.deployId);}
    catch{idSaved=false;}
    if(!idSaved)return fail("deployment_record_manual_review",503,{deployAttempted:true});

    let live;
    try{live=await checkDeploy(grant.accessToken,result.deployId);}
    catch{return status("submitted",{deployId:result.deployId,canSubmit:false,
       deployAttempted:true,needsManualReview:false},202);}
    if(live.ready){
      let final=false;
      try{final=await finish(current,reservation.requestId,"ready",{deployId:result.deployId});}
      catch{/* locked record remains */}
      if(!final)return fail("deployment_record_manual_review",503,{deployAttempted:true});
      return status("ready",{deployId:result.deployId,deployAttempted:true,
        canSubmit:false,websiteDeployed:true},201);
    }
    return status("submitted",{deployId:result.deployId,
      deployAttempted:true,canSubmit:false,needsManualReview:!allowedPostState.has(live.state)},202);
  };
}
export default createOneCrmAppDeployHandler();
export const config={
  rateLimit:{action:"rate_limit",aggregateBy:"ip",windowSize:60,windowLimit:5},
};
