import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { CRM_FOUNDATION_SQL } from "../blueprint/foundation-v1-bundled.mjs";
import {
  CRM_INSTALL_CONFIRMATION, CRM_BLUEPRINT_SHA256, CRM_INSTALL_KEY,
  validateFoundationSql, schemaInstallEnabled, publicCrmSchemaAttempt,
  reserveCrmSchemaAttempt, markCrmSchemaSubmitted, finishCrmSchemaAttempt,
  applyCrmFoundationSql, verifyCrmSchemaApplied, validateSchemaVerification,
  CrmSchemaPilotError,
} from "../netlify/functions/_lib/crm-schema-pilot.mjs";
import { createCrmSchemaApprovalHandler } from "../netlify/functions/crm-schema-approval.mjs";
import { createCrmSchemaInstallHandler } from "../netlify/functions/crm-schema-install.mjs";
import { pilotSettings, PILOT_PROJECT_NAME } from "../netlify/functions/_lib/test-project-pilot.mjs";

const origin = "https://kleanly-business-installer-staging.netlify.app";
const ref = "abcdefghijklmnopqrst";
const current = {
  user_id: "pilot-owner", connection_id: "test-connection",
  connection_status: "connected", email: "pilot@example.test",
  organization_id: "pilot-org", organization_name: "pilot company",
  organization_slug: "pilot-org", csrf_token: "test-csrf",
};
const settings = pilotSettings({
  KLEANLY_PILOT_OWNER_EMAIL: current.email,
  KLEANLY_PILOT_ORGANIZATION_NAME: current.organization_name,
});
const projectRecord = {
  status: "created", project_name: PILOT_PROJECT_NAME,
  project_ref: ref,
};
const review = {
  mode: "read_only_staging_crm_review",
  state: "schema_ready_for_approval", projectVerified: true,
  schemaVerified: true, readyForSeparateApproval: true,
  directoryTablesPresent: false, existingCrmTables: 0,
  installationEnabled: false, schemaInstalled: false,
  writeAttempted: false, projectRef: ref,
  projectName: PILOT_PROJECT_NAME, region: "eu-central-1",
};
const createBody = {
  confirmation: CRM_INSTALL_CONFIRMATION,
  acknowledgeSchemaChanges: true,
};
function request(body, url = origin + "/.netlify/functions/crm-schema-install", headers = {}, method = "POST") {
  return new Request(url, {
    method,
    headers: {
      Origin: origin,
      "Sec-Fetch-Site": "same-origin",
      "X-CSRF-Token": current.csrf_token,
      "Content-Type": "application/json", ...headers,
    },
    body: method === "POST" && body !== undefined ? JSON.stringify(body) : undefined,
  });
}
function approvedHandler(overrides = {}) {
  return createCrmSchemaApprovalHandler({
    getSession: async () => current,
    getMode: () => "permanent",
    getSettings: () => settings,
    isEnabled: () => false,
    getProjectRecord: async () => projectRecord,
    getSchemaAttempt: async () => null,
    reviewDatabase: async () => Response.json(review),
    ...overrides,
  });
}
function writeHandler(overrides = {}) {
  return createCrmSchemaInstallHandler({
    getMode: () => "permanent",
    isEnabled: () => true,
    getSettings: () => settings,
    getSession: async () => current,
    reviewDatabase: async () => Response.json(review),
    getProjectRecord: async () => projectRecord,
    getSchemaAttempt: async () => null,
    getGrant: async () => "test-access-token",
    reserve: async () => ({ reserved: true, requestId: "one-attempt" }),
    lockSubmission: async () => true,
    applySql: async () => true,
    verifySql: async () => true,
    finish: async () => true,
    ...overrides,
  });
}

test("canonical SQL is bundled exactly, does not target Klean.ly directory and requires owner RLS", () => {
  const original = readFileSync(new URL("../blueprint/0001_foundation.sql", import.meta.url), "utf8");
  assert.equal(CRM_FOUNDATION_SQL, original);
  assert.equal(validateFoundationSql(), original);
  assert.equal(CRM_BLUEPRINT_SHA256, createHash("sha256").update(original).digest("hex"));
  assert.equal(CRM_INSTALL_KEY, "pilot-crm-v1");
  assert.match(original, /begin;/i);
  assert.match(original, /commit;/i);
  assert.match(original, /owner_user_id = \(select auth\.uid\(\)\)/);
  assert.match(original, /kleanly_internal\.schema_versions/);
  assert.throws(() => validateFoundationSql("DROP TABLE public.cleaners"), /blueprint_invalid/);
  const migration = readFileSync(new URL(
    "../netlify/database/migrations/20261018173000_portal_test_crm_schema_installs.sql", import.meta.url
  ), "utf8");
  assert.match(migration, /DROP CONSTRAINT IF EXISTS portal_test_project_creations_connection_id_fkey/);
  assert.match(migration, /DROP CONSTRAINT IF EXISTS portal_test_project_creations_user_id_fkey/);
  assert.match(migration, /UNIQUE \(install_key\)/);
  assert.doesNotMatch(migration, /ON DELETE CASCADE/i);
});

test("one-time schema settings default locked and ledger public view hides sensitive fields", () => {
  assert.equal(schemaInstallEnabled({}), false);
  assert.equal(schemaInstallEnabled({KLEANLY_TEST_CRM_SCHEMA_INSTALL_ENABLED:"false"}), false);
  assert.equal(schemaInstallEnabled({KLEANLY_TEST_CRM_SCHEMA_INSTALL_ENABLED:"true"}), true);
  assert.deepEqual(publicCrmSchemaAttempt({
    status: "submitted", project_ref: ref, blueprint_version: 1,
    failure_code: "secret", request_id: "private", user_id: "private",
  }), {
    status: "submitted", projectRef: ref, blueprintVersion: 1,
    mayRetryAutomatically: false, needsManualReview: true,
  });
});

test("read-only proposal stays locked, shows only the approved staging project", async () => {
  const response = await approvedHandler()(request(undefined,
    origin + "/.netlify/functions/crm-schema-approval"));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.projectRef, ref);
  assert.equal(data.region, "eu-central-1");
  assert.equal(data.publicTables.length, 8);
  assert.equal(data.installationLocked, true);
  assert.equal(data.installationUnlocked, false);
  assert.equal(data.schemaInstalled, false);
  assert.equal(data.writeAttempted, false);
  assert.equal(data.confirmationPhrase, CRM_INSTALL_CONFIRMATION);
  const enabled = await approvedHandler({isEnabled:() => true})(request(undefined,
    origin + "/.netlify/functions/crm-schema-approval"));
  assert.equal((await enabled.json()).installationUnlocked, true);
});

test("completed or uncertain CRM schema ledger prevents a second approval", async () => {
  for (const status of ["applied","submitted","unknown","rejected","reserved"]) {
    let reviewed = 0;
    const handler = approvedHandler({
      isEnabled: () => true,
      getSchemaAttempt: async () => ({
        status, project_ref: ref, blueprint_version: 1,
      }),
      reviewDatabase: async () => { reviewed++; throw Error("do not review"); },
    });
    const response = await handler(request(undefined,
      origin + "/.netlify/functions/crm-schema-approval"));
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.installationUnlocked, false);
    assert.equal(data.existingAttempt.status, status);
    assert.equal(data.schemaInstalled, status === "applied");
    assert.equal(reviewed, 0);
  }
});

test("approval never bypasses wrong owner, CSRF, origin or project identity", async () => {
  let databaseCalls=0;
  const approval = approvedHandler({
    reviewDatabase: async()=> { databaseCalls++; return Response.json(review); },
  });
  assert.equal((await approval(request(undefined, "https://klean.ly/.netlify/functions/crm-schema-approval"))).status, 403);
  assert.equal((await approval(request(undefined, origin+"/.netlify/functions/crm-schema-approval", {"X-CSRF-Token":"bad"}))).status, 403);
  assert.equal((await approval(request(undefined, origin+"/.netlify/functions/crm-schema-approval", {Origin:"https://elsewhere.test"}))).status, 403);
  const other = approvedHandler({getSession: async()=>({...current,email:"someone-else@example.test"})});
  assert.equal((await other(request())).status, 403);
  const wrongProject = approvedHandler({getProjectRecord:async()=>({...projectRecord,project_ref:"00000000000000000000"})});
  assert.equal((await wrongProject(request())).status, 409);
  const wrongRegion = approvedHandler({reviewDatabase:async()=>Response.json({...review,region:"us-east-1"})});
  assert.equal((await wrongRegion(request())).status, 409);
  assert.equal(databaseCalls, 0);
});

test("locked install endpoint performs no provider, DB or grant calls at all", async () => {
  let calls=0;
  const handler = writeHandler({
    isEnabled: () => false,
    getSession: async () => {calls++; throw Error("must not run");},
    reserve: async () => {calls++; throw Error("must not run");},
    applySql: async () => {calls++; throw Error("must not run");},
  });
  const response = await handler(request(createBody));
  assert.equal(response.status, 423);
  assert.equal((await response.json()).automaticRetryAllowed, false);
  assert.equal(calls,0);
});

test("write endpoint rejects invalid approvals, foreign sites, and wrong owner before any reservation", async () => {
  let writes=0;
  const handler=writeHandler({ reserve: async()=>{writes++;return {reserved:true,requestId:"x"};}});
  for (const input of [
    {confirmation:"no",acknowledgeSchemaChanges:true},
    {confirmation:CRM_INSTALL_CONFIRMATION,acknowledgeSchemaChanges:false},
    {confirmation:CRM_INSTALL_CONFIRMATION,acknowledgeSchemaChanges:true,projectRef:ref},
    {},
  ]) {
    assert.equal((await handler(request(input))).status, 400);
  }
  assert.equal((await handler(request(createBody,"https://klean.ly/.netlify/functions/crm-schema-install"))).status,403);
  assert.equal((await handler(request(createBody,undefined,{"X-CSRF-Token":"incorrect"}))).status,403);
  assert.equal((await handler(request(createBody,undefined,{Origin:"https://other.invalid"}))).status,403);
  assert.equal(writes,0);
});

test("fresh read-only readiness or an earlier reservation blocks every provider write", async()=>{
  let writes=0;
  for(const overrides of [
    {reviewDatabase:async()=>Response.json({...review,existingCrmTables:1,state:"existing_schema_needs_review"})},
    {reviewDatabase:async()=>Response.json({...review,region:"ap-southeast-1"})},
    {getProjectRecord:async()=>({...projectRecord,project_ref:"00000000000000000000"})},
    {getSchemaAttempt:async()=>({status:"unknown",project_ref:ref})},
    {reserve:async()=>({reserved:false,requestId:null})},
    {lockSubmission:async()=>false},
  ]) {
    const h=writeHandler({
      applySql:async()=>{writes++;throw Error("must not run");},
      ...overrides,
    });
    const response=await h(request(createBody));
    assert.equal(response.ok,false);
    assert.equal((await response.json()).automaticRetryAllowed,false);
  }
  assert.equal(writes,0);
});

test("successful single schema request requires verified 8-table RLS and records completion", async()=>{
  const events=[];
  const handler=writeHandler({
    reserve:async(currentRecord,target)=>{events.push(["reserve",target]);return {reserved:true,requestId:"req-one"};},
    lockSubmission:async(user,target,id)=>{events.push(["submitted",target,id]);return true;},
    applySql:async(target,token)=>{events.push(["apply",target,token]);return true;},
    verifySql:async(target,token)=>{events.push(["verify",target,token]);return true;},
    finish:async(user,target,id,status,reason)=>{events.push(["finish",status,reason]);return true;},
  });
  const response=await handler(request(createBody));
  assert.equal(response.status,201);
  const data=await response.json();
  assert.equal(data.schemaInstalled,true);
  assert.equal(data.projectRef,ref);
  assert.equal(data.rowLevelSecurityVerified,true);
  assert.equal(data.ownerCreated,false);
  assert.equal(data.websiteCreated,false);
  assert.deepEqual(events.map(x=>x[0]),["reserve","submitted","apply","verify","finish"]);
  assert.equal(events.filter(x=>x[0]==="apply").length,1);
  assert.equal(events[4][1],"applied");
});

test("provider rejection, timeout and verification uncertainty permanently lock attempts", async()=>{
  for(const kind of ["denied","timeout","verification"]) {
    const finished=[];
    const response=await writeHandler({
      applySql:async()=>{
        if(kind==="denied")throw new CrmSchemaPilotError("provider_permission_denied");
        if(kind==="timeout")throw Error("timed out after DDL");
      },
      verifySql:async()=>kind==="verification"?false:true,
      finish:async(user,target,id,status,reason)=>{finished.push([status,reason]);return true;},
    })(request(createBody));
    assert.equal(response.ok,false);
    assert.equal(finished.length,1);
    assert.equal(finished[0][0],kind==="denied"?"rejected":"unknown");
    assert.equal((await response.json()).automaticRetryAllowed,false);
  }
});

test("database ledger reservation and status transitions use one-shot guarded SQL",async()=>{
  const calls=[];
  const db={pool:{query:async(sql,args)=>{
    calls.push([sql,args]);
    return {rows:[{request_id:"one-id"}]};
  }}};
  assert.deepEqual(await reserveCrmSchemaAttempt(current,ref,{
    db,requestId:"one-id",
  }),{reserved:true,requestId:"one-id"});
  assert.equal(await markCrmSchemaSubmitted(current,ref,"one-id",db),true);
  assert.equal(await finishCrmSchemaAttempt(current,ref,"one-id","applied",null,db),true);
  assert.match(calls[0][0],/ON CONFLICT DO NOTHING/);
  assert.match(calls[1][0],/status = 'reserved'/);
  assert.match(calls[2][0],/status = 'submitted'/);
  assert.equal(calls[0][1][3],ref);
  const conflict={pool:{query:async()=>({rows:[]})}};
  assert.deepEqual(await reserveCrmSchemaAttempt(current,ref,{db:conflict,requestId:"x"}),
    {reserved:false,requestId:null});
});

test("SQL Management API uses bundled SQL only and verifies eight RLS policies",async()=>{
  let calls=0;
  assert.equal(await applyCrmFoundationSql(ref,"some-long-valid-token",{
    fetchFn:async(url,options)=>{
      calls++;
      assert.equal(url,"https://api.supabase.com/v1/projects/"+ref+"/database/query");
      assert.equal(options.method,"POST");
      assert.deepEqual(JSON.parse(options.body),{query:CRM_FOUNDATION_SQL});
      return new Response("[]",{status:201});
    },
  }),true);
  assert.equal(calls,1);
  const verified=await verifyCrmSchemaApplied(ref,"some-long-valid-token",{
    fetchFn:async(url,options)=>{
      calls++;
      assert.equal(JSON.parse(options.body).read_only,true);
      return Response.json([{table_count:"8",rls_count:"8",version_count:"1"}],{status:201});
    },
  });
  assert.equal(verified,true);
  assert.equal(calls,2);
  assert.equal(validateSchemaVerification([{table_count:8,rls_count:7,version_count:1}]),false);
  assert.equal(validateSchemaVerification([]),false);
});
