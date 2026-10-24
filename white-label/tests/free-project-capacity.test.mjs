import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  assessFreeProjectCapacity, readFreeProjectCapacity,
  createFreeProjectCapacityHandler, CapacityCheckError,
} from "../netlify/functions/free-project-capacity.mjs";
import { encryptTokens, tokenBinding } from "../netlify/functions/_lib/connection-vault.mjs";

const site = "https://kleanly-business-installer-staging.netlify.app";
const session = Object.freeze({
  user_id: "verified-owner-id",
  connection_id: "2cba3889-f6e8-46aa-b707-a28b6a5f0007",
  organization_id: "org-test-123",
  organization_slug: "kleanly-test-org",
  organization_name: "kleanly test database",
  connection_status: "connected",
  csrf_token: "fake-csrf-token",
});
const accountProjects = [
  { id: "p1", organization_id: session.organization_id, status: "ACTIVE_HEALTHY" },
];
function request(headers = {}, method = "POST") {
  return new Request(site + "/.netlify/functions/free-project-capacity", {
    method, headers: {
      Origin: site,
      "Sec-Fetch-Site": "same-origin",
      "X-CSRF-Token": session.csrf_token,
      ...headers,
    },
  });
}
async function withSecurePortal(testFn) {
  const keys = ["KLEANLY_PERMANENT_OAUTH_ENABLED", "KLEANLY_OAUTH_ENCRYPTION_KEY"];
  const previous = keys.map(name => process.env[name]);
  process.env.KLEANLY_PERMANENT_OAUTH_ENABLED = "true";
  process.env.KLEANLY_OAUTH_ENCRYPTION_KEY = randomBytes(32).toString("base64url");
  try { return await testFn(); }
  finally { keys.forEach((name, i) => {
    if (previous[i] === undefined) delete process.env[name];
    else process.env[name] = previous[i];
  }); }
}

test("free plan with one visible project is a candidate, never an approval or creation", () => {
  const result = assessFreeProjectCapacity(
    { id: session.organization_id, plan: "free" },
    accountProjects, session
  );
  assert.equal(result.freePlanConfirmed, true);
  assert.equal(result.visibleAccountProjects, 1);
  assert.equal(result.thisOrganizationProjects, 1);
  assert.equal(result.appearsWithinFreeLimit, true);
  assert.equal(result.freeCapacityGuaranteed, false);
  assert.equal(result.allowedToCreateProject, false);
  assert.equal(result.projectCreated, false);
  assert.equal(result.chargesApproved, false);
  assert.equal(result.requiresExplicitApproval, true);
});

test("organization mismatches, missing org ids and malformed projects fail closed", () => {
  assert.throws(() => assessFreeProjectCapacity(
    { id: "other-org", plan: "free" }, accountProjects, session
  ), (e) => e instanceof CapacityCheckError && e.code === "response_invalid");
  assert.throws(() => assessFreeProjectCapacity(
    { id: session.organization_id, plan: "free" }, [{id:"p1"}], session
  ), (e) => e.code === "response_invalid");
  assert.throws(() => assessFreeProjectCapacity(
    { id: session.organization_id, plan: "free" }, {projects:accountProjects}, session
  ), (e) => e.code === "response_invalid");
});

test("paid orgs and accounts already with two visible projects cannot proceed", () => {
  const paid = assessFreeProjectCapacity(
    {id:session.organization_id,plan:"pro"}, accountProjects,session
  );
  assert.equal(paid.appearsWithinFreeLimit,false);
  assert.equal(paid.allowedToCreateProject,false);
  const two = assessFreeProjectCapacity(
    {id:session.organization_id,plan:"free"},
    [...accountProjects,{id:"p2",organization_id:"another-org",status:"ACTIVE_HEALTHY"}],
    session
  );
  assert.equal(two.visibleAccountProjects,2);
  assert.equal(two.thisOrganizationProjects,1);
  assert.equal(two.appearsWithinFreeLimit,false);
  assert.equal(two.allowedToCreateProject,false);
});

test("uses only session-verified provider identity and sends GET requests with server-only token", async () => {
  const key=randomBytes(32), secret="encrypted-test-only-supabase-access-token";
  const encrypted = encryptTokens({accessToken:secret},
    tokenBinding(session.connection_id, session.user_id,session.organization_id),key);
  let dbReads=0, fetchCalls=[];
  const result=await readFreeProjectCapacity(session,{
    db:{pool:{query:async(sql,params)=>{
      dbReads++;
      assert.match(sql,/SELECT encrypted_tokens FROM portal_connections/);
      assert.deepEqual(params,[session.connection_id,session.user_id,session.organization_id]);
      return {rows:[{encrypted_tokens:encrypted}]};
    }}},
    key,fetchFn:async(url,options)=>{
      fetchCalls.push(url);
      assert.equal(options.method,"GET");
      assert.equal(options.headers.Authorization,"Bearer "+secret);
      assert.equal(options.headers.Accept,"application/json");
      if(url.endsWith("/organizations/kleanly-test-org")) {
        return Response.json({id:session.organization_id,name:"kleanly test database",plan:"free"});
      }
      if(url.endsWith("/projects")) return Response.json(accountProjects);
      throw new Error("Unexpected Supabase endpoint");
    }
  });
  assert.equal(dbReads,1);
  assert.deepEqual(fetchCalls,[
    "https://api.supabase.com/v1/organizations/kleanly-test-org",
    "https://api.supabase.com/v1/projects",
  ]);
  assert.equal(result.appearsWithinFreeLimit,true);
  assert.doesNotMatch(JSON.stringify(result),/encrypted-test-only|accessToken|connection_id/);
});

test("provider permissions are categorised without leaking responses", async () => {
  const key=randomBytes(32);
  const encrypted=encryptTokens({accessToken:"test-access-token-of-supabase"},
    tokenBinding(session.connection_id,session.user_id,session.organization_id),key);
  const db={pool:{query:async()=>({rows:[{encrypted_tokens:encrypted}]})}};
  for(const denied of [
    {path:"organizations",code:"organization_denied"},
    {path:"projects",code:"projects_denied"},
  ]) {
    await assert.rejects(()=>readFreeProjectCapacity(session,{
      db,key,fetchFn:async(url)=>url.includes(denied.path)
        ? new Response("not permitted", {status:403})
        : Response.json({id:session.organization_id,plan:"free"}),
    }), e => e instanceof CapacityCheckError && e.code===denied.code);
  }
});

test("only authenticated CSRF-bound preflight success permits read-only capacity call", async () => {
  await withSecurePortal(async()=>{
    let readinessCalls=0, capacityCalls=0;
    const handler=createFreeProjectCapacityHandler({
      getSession:async()=>session,
      checkReadiness:async()=>{
        readinessCalls++;
        return Response.json({
          readyForCostReview:true,supabaseVerified:true,netlifyVerified:true,
          readyToInstall:false,installationsCreated:false,
        });
      },
      readCapacity:async()=>{
        capacityCalls++;
        return assessFreeProjectCapacity(
          {id:session.organization_id,plan:"free"},accountProjects,session
        );
      },
    });
    const response=await handler(request());
    assert.equal(response.status,200);
    const data=await response.json();
    assert.equal(data.freePlanConfirmed,true);
    assert.equal(data.allowedToCreateProject,false);
    assert.equal(readinessCalls,1);
    assert.equal(capacityCalls,1);
    assert.equal((await handler(request({Origin:"https://attacker.invalid"}))).status,403);
    assert.equal((await handler(request({"X-CSRF-Token":"wrong"}))).status,403);
    assert.equal((await handler(request({}, "GET"))).status,405);
    assert.equal(readinessCalls,1);
    assert.equal(capacityCalls,1);
    const anonymous=createFreeProjectCapacityHandler({
      getSession:async()=>null,
      checkReadiness:async()=>{throw Error("Should not check");},
    });
    assert.equal((await anonymous(request())).status,401);
  });
});

test("failed provider preflight prevents capacity check",async()=>{
  await withSecurePortal(async()=>{
    const handler=createFreeProjectCapacityHandler({
      getSession:async()=>session,
      checkReadiness:async()=>new Response(JSON.stringify({error:"internal private value"}),{status:409}),
      readCapacity:async()=>{throw Error("Must not read provider credentials");},
    });
    const response=await handler(request());
    assert.equal(response.status,409);
    const data=await response.json();
    assert.equal(data.allowedToCreateProject,false);
    assert.doesNotMatch(JSON.stringify(data),/private value|credentials/);
  });
});
