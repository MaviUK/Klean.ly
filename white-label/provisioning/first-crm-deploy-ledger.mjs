// One irreversible first-deploy reservation in the INSTALLER's database.
// Never import this file in customer-facing CRM static pages.
import {randomUUID} from "node:crypto";
import {getPortalDatabase} from "../netlify/functions/_lib/connection-store.mjs";
import {
  RELEASE_PILOT_SITE_ID,RELEASE_PILOT_SUPABASE,
} from "./prepare-crm-release.mjs";
const REF=new URL(RELEASE_PILOT_SUPABASE).hostname.split(".")[0];
const KEY="pilot-first-crm-app-deploy-v1";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH=/^[a-f0-9]{64}$/;
const PROVIDER_ID=/^[\w:-]{8,128}$/;

function actor(current){
  if(!current?.user_id || !current.organization_id ||
      !/^[\w:-]{1,128}$/.test(current.user_id) ||
      !/^[\w:-]{1,128}$/.test(current.organization_id)) {
    throw new Error("invalid_staging_actor");
  }
}
async function dbQuery(sql,values,db){
  const connection=db??await getPortalDatabase();
  if(typeof connection?.pool?.query!=="function")throw new Error("audit_store_unavailable");
  return connection.pool.query(sql,values);
}
export async function getPilotDeployAttempt(current,db=null){
  actor(current);
  const r=await dbQuery(
    "SELECT request_id,status,deploy_id,supabase_project_ref,netlify_site_id,"+
    "netlify_team_id,netlify_user_id,source_hash,archive_hash,approved_at,submitted_at,ready_at "+
    "FROM portal_test_crm_app_deploys WHERE deploy_key=$1 AND user_id=$2 AND organization_id=$3 LIMIT 1",
    [KEY,current.user_id,current.organization_id],db
  );
  return r.rows[0]??null;
}
export async function reservePilotDeploy(current,{
  projectRef,siteId,teamId,netlifyUserId,sourceHash,archiveHash,
  requestId=randomUUID(),db=null,
}={}){
  actor(current);
  if(projectRef!==REF || siteId!==RELEASE_PILOT_SITE_ID ||
      !PROVIDER_ID.test(teamId||"") || !PROVIDER_ID.test(netlifyUserId||"") ||
      !HASH.test(sourceHash||"") || !HASH.test(archiveHash||"") ||
      !UUID.test(requestId))throw new Error("invalid_pilot_deploy_reservation");
  const r=await dbQuery(
    "INSERT INTO portal_test_crm_app_deploys "+
    "(request_id,user_id,organization_id,supabase_project_ref,netlify_site_id,"+
    "netlify_team_id,netlify_user_id,source_hash,archive_hash,status) "+
    "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'reserved') "+
    "ON CONFLICT DO NOTHING RETURNING request_id",
    [requestId,current.user_id,current.organization_id,REF,
      RELEASE_PILOT_SITE_ID,teamId,netlifyUserId,sourceHash,archiveHash],db
  );
  return r.rows.length===1?{reserved:true,requestId}:{reserved:false,requestId:null};
}
export async function markPilotDeploySubmitted(current,requestId,db=null){
  actor(current);
  if(!UUID.test(requestId||""))throw new Error("invalid_request_id");
  const r=await dbQuery(
    "UPDATE portal_test_crm_app_deploys "+
    "SET status='submitted',submitted_at=now(),updated_at=now() "+
    "WHERE request_id=$1 AND user_id=$2 AND organization_id=$3 "+
    "AND deploy_key=$4 AND status='reserved' RETURNING request_id",
    [requestId,current.user_id,current.organization_id,KEY],db
  );
  return r.rows.length===1;
}
export async function recordPilotDeployId(current,requestId,deployId,db=null){
  actor(current);
  if(!UUID.test(requestId||"") || !PROVIDER_ID.test(deployId||"")) {
    throw new Error("invalid_deploy_id");
  }
  const r=await dbQuery(
    "UPDATE portal_test_crm_app_deploys SET deploy_id=$1,updated_at=now() "+
    "WHERE request_id=$2 AND user_id=$3 AND organization_id=$4 "+
    "AND deploy_key=$5 AND status='submitted' AND deploy_id IS NULL RETURNING request_id",
    [deployId,requestId,current.user_id,current.organization_id,KEY],db
  );
  return r.rows.length===1;
}
export async function finishPilotDeploy(current,requestId,status,{
  deployId=null,reason=null,db=null,
}={}){
  actor(current);
  if(!UUID.test(requestId||"") || !["ready","unknown"].includes(status) ||
      (status==="ready" && !PROVIDER_ID.test(deployId||"")) ||
      (reason!==null && !/^[a-z_]{1,64}$/.test(reason))) {
    throw new Error("invalid_deploy_state");
  }
  const r=await dbQuery(
    "UPDATE portal_test_crm_app_deploys "+
    "SET status=$1,deploy_id=coalesce(deploy_id,$2),failure_code=$3,"+
    "ready_at=case when $1='ready' then now() else ready_at end,updated_at=now() "+
    "WHERE request_id=$4 AND user_id=$5 AND organization_id=$6 "+
    "AND deploy_key=$7 AND status='submitted' "+
    "AND (deploy_id IS NULL OR deploy_id=$2) RETURNING request_id",
    [status,deployId,reason,requestId,current.user_id,current.organization_id,KEY],db
  );
  return r.rows.length===1;
}
export function publicDeployStatus(record){
  if(!record)return {state:"not_attempted",deployId:null,oneTime:true};
  const state=["reserved","submitted","ready","unknown"].includes(record.status)
    ? record.status:"unknown";
  return {state,deployId:PROVIDER_ID.test(record.deploy_id||"")?record.deploy_id:null,
    oneTime:true,automaticRetry:false};
}
