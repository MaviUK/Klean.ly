import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  decryptTokens, vaultKey,
} from "../netlify/functions/_lib/connection-vault.mjs";
import {
  PILOT_PROJECT_NAME, PILOT_CONFIRMATION, PILOT_REGION_GROUP,
  pilotSettings, isPilotTarget, isStagingHost, eligibleForPilot,
  testProjectRequestBody, projectPasswordBinding, publicPilotRecord,
  reservePilotProject, markPilotSubmitted, markPilotCompleted,
  submitPilotProject, normalizeProjectResponse, TestProjectError,
} from "../netlify/functions/_lib/test-project-pilot.mjs";

const testEnv = {
  KLEANLY_PILOT_OWNER_EMAIL: "pilot-owner@example.test",
  KLEANLY_PILOT_ORGANIZATION_NAME: "pilot company org",
  KLEANLY_TEST_PROJECT_CREATION_ENABLED: "true",
};
const current = {
  connection_status: "connected",
  user_id: "portal-owner-user-id",
  email: "pilot-owner@example.test",
  connection_id: "7b374f77-b1b8-4543-a38b-3b0189c7abc5",
  organization_id: "test-org-identity",
  organization_slug: "org-staging-123",
  organization_name: "pilot company org",
  csrf_token: "valid-csrf",
};
function capacity() {
  return {
    freePlanConfirmed: true,
    appearsWithinFreeLimit: true,
    freeCapacityGuaranteed: false,
    visibleAccountProjects: 1,
    thisOrganizationProjects: 1,
    allowedToCreateProject: false,
    projectCreated: false,
    chargesApproved: false,
  };
}

test("owner/organisation must match server allowlist, not browser-provided claims", () => {
  const settings = pilotSettings(testEnv);
  assert.equal(settings.enabled, true);
  assert.equal(isPilotTarget(current, settings), true);
  assert.equal(isPilotTarget({...current, email:"someone-else@example.test"}, settings), false);
  assert.equal(isPilotTarget({...current, organization_name:"real live directory"}, settings), false);
  assert.equal(isPilotTarget({...current, connection_status:"expired"}, settings), false);
  assert.equal(pilotSettings({}).allowlistConfigured, false);
  assert.equal(pilotSettings({}).enabled, false);
  assert.equal(isPilotTarget(current, pilotSettings({})), false);
  assert.equal(isStagingHost(new Request("https://kleanly-business-installer-staging.netlify.app/.netlify/functions/test-project-create")), true);
  assert.equal(isStagingHost(new Request("https://klean.ly/.netlify/functions/test-project-create")), false);
});

test("live capacity must be the single observed free-account project", () => {
  assert.equal(eligibleForPilot(capacity()), true);
  for (const changed of [
    {freePlanConfirmed:false}, {appearsWithinFreeLimit:false},
    {freeCapacityGuaranteed:true}, {visibleAccountProjects:2},
    {thisOrganizationProjects:0}, {allowedToCreateProject:true},
    {projectCreated:true}, {chargesApproved:true},
  ]) {
    assert.equal(eligibleForPilot({...capacity(),...changed}),false);
  }
});

test("project creation body is strictly Free-safe with EMEA selection and no premium options", () => {
  const password = randomBytes(36).toString("base64url");
  const request = testProjectRequestBody(current.organization_slug,password);
  assert.deepEqual(Object.keys(request).sort(),
    ["db_pass","name","organization_slug","region_selection"].sort());
  assert.equal(request.db_pass,password);
  assert.equal(request.name,PILOT_PROJECT_NAME);
  assert.equal(request.region_selection.type,"smartGroup");
  assert.equal(request.region_selection.code,PILOT_REGION_GROUP);
  assert.equal("desired_instance_size" in request,false);
  assert.equal("billing_plan" in request,false);
  assert.throws(()=>testProjectRequestBody("../../directory",password));
  assert.throws(()=>testProjectRequestBody(current.organization_slug,"weak"));
  assert.equal(PILOT_CONFIRMATION,"CREATE ONE TEST PROJECT");
});

test("encrypted one-shot reservation never stores raw DB password or permits automatic reuse", async () => {
  const previous=Object.fromEntries(Object.keys(testEnv).map(k=>[k,process.env[k]]));
  Object.assign(process.env,testEnv);
  try {
    const key=randomBytes(32);
    let recordedParams, inserts=0;
    const db={pool:{query:async(sql,params)=>{
      assert.match(sql,/INSERT INTO portal_test_project_creations/);
      assert.match(sql,/ON CONFLICT DO NOTHING/);
      recordedParams=params;
      inserts++;
      return {rows: inserts===1?[{request_id:params[0]}]:[]};
    }}};
    const requestId="a7f3b731-95ee-4a4c-a1ce-0f61f3c289b4";
    const password=randomBytes(36).toString("base64url");
    const first=await reservePilotProject(current,{db,key,requestId,password});
    assert.equal(first.created,true);
    const sealed=recordedParams[7];
    assert.equal(typeof sealed,"string");
    assert.equal(sealed.includes(password),false);
    const decrypted=decryptTokens(sealed,projectPasswordBinding(current,requestId),key);
    assert.equal(decrypted.dbPassword,password);
    assert.throws(()=>decryptTokens(sealed,projectPasswordBinding({
      ...current,user_id:"other-user"
    },requestId),key));
    const replay=await reservePilotProject(current,{db,key,requestId,password});
    assert.equal(replay.created,false);
    assert.equal(replay.password,null);
  } finally {
    for(const [key,value] of Object.entries(previous)) {
      if(value === undefined) delete process.env[key];
      else process.env[key]=value;
    }
  }
});

test("ledger state transitions require a matching unique submitted reservation",async()=>{
  const calls=[];
  const db={pool:{query:async(sql,params)=>{
    calls.push({sql,params});
    return {rows:[{request_id:params.includes("submitted")?"submitted":"r1"}]};
  }}};
  assert.equal(await markPilotSubmitted(current,"r1",db),true);
  assert.equal(await markPilotCompleted(current,"r1","created","abcdefghijklmnopqrst",null,db),true);
  assert.equal(await markPilotCompleted(current,"r1","unknown",null,"provider_result_unknown",db),true);
  assert.throws(()=>markPilotCompleted(current,"r1","created",null,null,db));
  assert.match(calls[0].sql,/status = 'reserved'/);
  assert.match(calls[1].sql,/status = 'submitted'/);
});

test("provider POST is exactly once, uses server token and never includes paid add-ons",async()=>{
  let posts=0;
  const privatePassword=randomBytes(36).toString("base64url");
  const response=await submitPilotProject("private-access-token-12345678",
    current,privatePassword,{fetchFn:async(url,options)=>{
      posts++;
      assert.equal(url,"https://api.supabase.com/v1/projects");
      assert.equal(options.method,"POST");
      assert.equal(options.headers.Authorization,"Bearer private-access-token-12345678");
      const body=JSON.parse(options.body);
      assert.deepEqual(body,testProjectRequestBody(current.organization_slug,privatePassword));
      assert.equal(body.organization_slug,current.organization_slug);
      return Response.json({id:"abcdefghijklmnopqrst"}, {status:201});
    }});
  assert.equal(response,"abcdefghijklmnopqrst");
  assert.equal(posts,1);
  assert.throws(()=>normalizeProjectResponse({ref:"unverified"}));
  const noRetry=await assert.rejects(()=>submitPilotProject("private-access-token-12345678",
    current,privatePassword,{fetchFn:async()=>new Response("Quota reached",{status:402})}),
    (e)=>e instanceof TestProjectError && e.code==="provider_quota_or_billing"
  );
  assert.equal(noRetry,undefined);
  await assert.rejects(()=>submitPilotProject("private-access-token-12345678",
    current,privatePassword,{fetchFn:async()=>{throw new Error("connection lost");}}),
    (e)=>e.code==="provider_result_unknown"
  );
});

test("public record never exposes encrypted password, OAuth token or internal request ID",()=>{
  const record=publicPilotRecord({
    status:"unknown",project_name:PILOT_PROJECT_NAME,
    project_ref:null, encrypted_db_password:"encrypted",
    request_id:"secret-internal-request",
  });
  assert.equal(record.requiresManualReview,true);
  assert.equal(record.mayRetryAutomatically,false);
  assert.equal(record.projectRef,null);
  assert.doesNotMatch(JSON.stringify(record),/encrypted|secret-internal-request/);
});
