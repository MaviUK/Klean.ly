import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  parseProjectPage, readOrganizationProjectInventory, createProvisioningPreflight,
} from "../netlify/functions/provisioning-preflight.mjs";
import {
  encryptTokens, tokenBinding,
} from "../netlify/functions/_lib/connection-vault.mjs";

const origin = "https://kleanly-business-installer-staging.netlify.app";
const session = {
  session_hash: "a".repeat(64), csrf_token: "csrf-value-for-tests",
  user_id: "verified-owner", connection_id: "connection-a",
  organization_id: "org-a", organization_slug: "my-test-org",
  organization_name: "Test company", connection_status: "connected",
};

function withEnv(fn) {
  const names = ["KLEANLY_PERMANENT_OAUTH_ENABLED", "KLEANLY_OAUTH_ENCRYPTION_KEY"];
  const prev = names.map(name => process.env[name]);
  process.env.KLEANLY_PERMANENT_OAUTH_ENABLED = "true";
  process.env.KLEANLY_OAUTH_ENCRYPTION_KEY = randomBytes(32).toString("base64url");
  return Promise.resolve().then(fn).finally(() => {
    names.forEach((key, i) => {
      if (prev[i] === undefined) delete process.env[key];
      else process.env[key] = prev[i];
    });
  });
}
function request({ originHeader = origin, csrf = session.csrf_token, method = "POST" } = {}) {
  return new Request(origin + "/.netlify/functions/provisioning-preflight", {
    method,
    headers: {
      Origin: originHeader, "Sec-Fetch-Site": "same-origin",
      "X-CSRF-Token": csrf,
    },
  });
}

test("project inventory accepts known JSON shapes and never assumes spare free quota", () => {
  assert.deepEqual(parseProjectPage([{id:"p1"}]),
    {observedProjectCount:1,mayHaveMore:false});
  assert.deepEqual(parseProjectPage({projects:[{id:"p1"},{id:"p2"}]}),
    {observedProjectCount:2,mayHaveMore:false});
  assert.deepEqual(parseProjectPage({data:[]}),
    {observedProjectCount:0,mayHaveMore:false});
  assert.deepEqual(parseProjectPage(Array.from({length:100},()=>({id:"p"}))),
    {observedProjectCount:100,mayHaveMore:true});
  assert.throws(()=>parseProjectPage({unrecognised:[]}));
  assert.throws(()=>parseProjectPage([{id:"p"},null]));
  assert.throws(()=>parseProjectPage(Array.from({length:101},()=>({id:"p"}))));
});

test("inventory uses only cookie-bound org and decrypts server-side; never sends credentials to browser", async () => {
  const key = randomBytes(32);
  const token = "private-oauth-access-token-123456789";
  const sealed = encryptTokens({accessToken:token},
    tokenBinding(session.connection_id,session.user_id,session.organization_id),key);
  let queries=0,requests=0;
  const db={pool:{query:async (sql,params)=>{
    queries++;
    assert.match(sql,/SELECT encrypted_tokens FROM portal_connections/);
    assert.deepEqual(params,[session.connection_id,session.user_id,session.organization_id]);
    return {rows:[{encrypted_tokens:sealed}]};
  }}};
  const inventory=await readOrganizationProjectInventory(session,{
    db,key,fetchFn:async (url,options)=>{
      requests++;
      assert.equal(url,"https://api.supabase.com/v1/organizations/my-test-org/projects?limit=100&offset=0");
      assert.equal(options.method,"GET");
      assert.equal(options.headers.Authorization,"Bearer "+token);
      return Response.json({projects:[{id:"project-1"}]});
    },
  });
  assert.equal(queries,1);
  assert.equal(requests,1);
  assert.deepEqual(inventory,{observedProjectCount:1,mayHaveMore:false});
  await assert.rejects(() => readOrganizationProjectInventory(session, {
    db, key, fetchFn: async () => new Response("Forbidden", {status:403}),
  }), error => error.code === "projects_permission_denied");
  await assert.rejects(() => readOrganizationProjectInventory(session, {
    db, key, fetchFn: async () => Response.json({unknown: "shape"}),
  }), error => error.code === "projects_response_invalid");
  await assert.rejects(()=>readOrganizationProjectInventory({
    ...session,organization_slug:"../../other-organization"
  },{db,key,fetchFn:async()=>{throw Error("Must never fetch bad slug");}}));
});

test("preflight rejects CSRF failure, cross-origin requests and missing portal login", async () => {
  await withEnv(async ()=>{
    let providerCalls=0;
    const handler=createProvisioningPreflight({
      getSession:async ()=>session,
      checkSupabase:async ()=>{providerCalls++;return {state:"connected"};},
      checkNetlify:async ()=>{providerCalls++;return {state:"connected"};},
      getProjects:async ()=>{providerCalls++;return {observedProjectCount:1,mayHaveMore:false};},
    });
    assert.equal((await handler(request({csrf:"wrong"}))).status,403);
    assert.equal((await handler(request({originHeader:"https://attacker.example"}))).status,403);
    assert.equal((await handler(request({method:"GET"}))).status,405);
    assert.equal(providerCalls,0);
    const noLogin = createProvisioningPreflight({
      getSession:async()=>null,
      checkSupabase:async()=>{throw Error("Called without login");},
    });
    assert.equal((await noLogin(request())).status,401);
  });
});

test("readiness validates both grants, reports counts and cannot authorize creation or billing",async()=>{
  await withEnv(async()=>{
    const handler=createProvisioningPreflight({
      getSession:async ()=>session,
      checkSupabase:async()=>({state:"connected"}),
      checkNetlify:async()=>({state:"connected"}),
      getProjects:async()=>({observedProjectCount:1,mayHaveMore:false}),
    });
    const response=await handler(request());
    assert.equal(response.status,200);
    const data=await response.json();
    assert.equal(data.supabaseVerified,true);
    assert.equal(data.netlifyVerified,true);
    assert.equal(data.organizationName,session.organization_name);
    assert.equal(data.observedProjectCount,1);
    assert.equal(data.readyForCostReview,true);
    assert.equal(data.readyToInstall,false);
    assert.equal(data.installationsCreated,false);
    assert.equal(data.billingVerified,false);
    assert.equal(data.explicitCostApprovalRequired,true);
    assert.equal(JSON.stringify(data).includes(session.session_hash),false);
    const missingNetlify = createProvisioningPreflight({
      getSession:async()=>session,
      checkSupabase:async()=>({state:"connected"}),
      checkNetlify:async()=>({state:"reauthorisation_required"}),
      getProjects:async()=>{throw Error("Projects must not be listed");},
    });
    assert.equal((await missingNetlify(request())).status,409);
    const brokenInventory=createProvisioningPreflight({
      getSession:async()=>session,
      checkSupabase:async()=>({state:"connected"}),
      checkNetlify:async()=>({state:"connected"}),
      getProjects:async()=>{throw Error("Unexpected provider response");},
    });
    const error=await brokenInventory(request());
    assert.equal(error.status,503);
    const body=await error.json();
    assert.equal(body.installationsCreated,false);
    assert.equal(body.code,"projects_lookup_failed");
    assert.doesNotMatch(JSON.stringify(body),/private-oauth-access-token|csrf-value-for-tests/);
    const deniedProjects=createProvisioningPreflight({
      getSession:async()=>session,
      checkSupabase:async()=>({state:"connected"}),
      checkNetlify:async()=>({state:"connected"}),
      getProjects:async()=>{const e=new Error("Access rejected");e.name="ProvisioningPreflightError";e.code="projects_permission_denied";throw e;},
    });
    // Do not trust arbitrary error names; only the class from the server is whitelisted.
    assert.equal((await (await deniedProjects(request())).json()).code, "projects_lookup_failed");
    const brokenSupabase=createProvisioningPreflight({
      getSession:async()=>session,
      checkSupabase:async()=>{throw Error("Bearer SHOULD_NOT_LEAK");},
      checkNetlify:async()=>({state:"connected"}),
      getProjects:async()=>{throw Error("Should never list projects");},
    });
    const rejected=await brokenSupabase(request());
    assert.equal(rejected.status,503);
    const rejectedPayload=await rejected.json();
    assert.equal(rejectedPayload.code,"supabase_validation_failed");
    assert.doesNotMatch(JSON.stringify(rejectedPayload),/Bearer SHOULD_NOT_LEAK/);
  });
});
