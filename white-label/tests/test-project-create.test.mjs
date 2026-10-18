import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createPilotProposalHandler } from "../netlify/functions/test-project-proposal.mjs";
import { createOneTestProjectHandler } from "../netlify/functions/test-project-create.mjs";
import {
  PILOT_PROJECT_NAME, PILOT_CONFIRMATION, pilotSettings, TestProjectError,
} from "../netlify/functions/_lib/test-project-pilot.mjs";

const origin="https://kleanly-business-installer-staging.netlify.app";
const session={
  connection_status:"connected",
  email:"pilot-owner@example.test", user_id:"test-user",
  organization_name:"pilot company org", organization_slug:"test-org",
  organization_id:"test-organization-id",
  connection_id:"75def008-2d02-4c8f-a0c2-e6e6615eb607",
  csrf_token:"csrf-test-secret",
};
const settings=pilotSettings({
  KLEANLY_PILOT_OWNER_EMAIL:"pilot-owner@example.test",
  KLEANLY_PILOT_ORGANIZATION_NAME:"pilot company org",
  KLEANLY_TEST_PROJECT_CREATION_ENABLED:"true",
});
const lockedSettings={...settings,enabled:false};
const eligible={
  freePlanConfirmed:true, appearsWithinFreeLimit:true,freeCapacityGuaranteed:false,
  visibleAccountProjects:1,thisOrganizationProjects:1,
  allowedToCreateProject:false,projectCreated:false,chargesApproved:false,
};
function request(body={
  confirmation:PILOT_CONFIRMATION, acknowledgeProviderCharges:true,
},headers={},method="POST",url=origin+"/.netlify/functions/test-project-create"){
  return new Request(url,{
    method,
    headers:{
      Origin:origin,"Sec-Fetch-Site":"same-origin",
      "X-CSRF-Token":session.csrf_token,
      "Content-Type":"application/json",
      ...headers,
    },
    body: method==="POST"?JSON.stringify(body):undefined,
  });
}
function withEnv(callback){
  const keys=["KLEANLY_PERMANENT_OAUTH_ENABLED","KLEANLY_OAUTH_ENCRYPTION_KEY"];
  const previous=keys.map(x=>process.env[x]);
  process.env.KLEANLY_PERMANENT_OAUTH_ENABLED="true";
  process.env.KLEANLY_OAUTH_ENCRYPTION_KEY=randomBytes(32).toString("base64url");
  return Promise.resolve().then(callback).finally(()=>keys.forEach((k,i)=>{
    if(previous[i]===undefined)delete process.env[k];
    else process.env[k]=previous[i];
  }));
}

test("proposal remains read-only and locked until pilot switch is explicitly enabled",async()=>{
  await withEnv(async()=>{
    let checked=0,lookups=0;
    const handler=createPilotProposalHandler({
      getSession:async()=>session,
      getSettings:()=>lockedSettings,
      checkCapacity:async()=>{
        checked++;return Response.json(eligible);
      },
      readRecord:async()=>{lookups++;return null;},
    });
    const response=await handler(request(undefined,{}, "POST", origin+"/.netlify/functions/test-project-proposal"));
    assert.equal(response.status,200);
    const data=await response.json();
    assert.equal(data.mode,"staging_one_project_pilot");
    assert.equal(data.projectName,PILOT_PROJECT_NAME);
    assert.equal(data.regionGroup,"emea");
    assert.equal(data.visibleProjects,1);
    assert.equal(data.creationEnabled,false);
    assert.equal(data.creationLocked,true);
    assert.equal(data.needsExplicitConfirmation,true);
    assert.equal(data.freeProjectGuaranteed,false);
    assert.equal(data.noPaidAddonsRequested,true);
    assert.equal(data.projectCreated,false);
    assert.equal(checked,1);
    assert.equal(lookups,1);
    assert.equal(JSON.stringify(data).includes(session.csrf_token),false);
  });
});

test("pilot proposal fails closed for any other account or missing CSRF",async()=>{
  await withEnv(async()=>{
    let checks=0;
    const handler=createPilotProposalHandler({
      getSession:async()=>session,
      getSettings:()=>settings,
      checkCapacity:async()=>{checks++;return Response.json(eligible);},
    });
    assert.equal((await handler(request(undefined,{"X-CSRF-Token":"invalid"}))).status,403);
    assert.equal((await handler(request(undefined,{Origin:"https://other.example"}))).status,403);
    assert.equal((await handler(request(undefined,{}, "POST", "https://klean.ly/.netlify/functions/test-project-proposal"))).status,403);
    assert.equal(checks,0);
    const wrongUser=createPilotProposalHandler({
      getSession:async()=>({...session,email:"stranger@other.test"}),
      getSettings:()=>settings,
      checkCapacity:async()=>{throw Error("Must never access providers");},
    });
    assert.equal((await wrongUser(request())).status,403);
  });
});

test("proposal discovers a past reservation and never offers another create",async()=>{
  await withEnv(async()=>{
    const handler=createPilotProposalHandler({
      getSession:async()=>session,
      getSettings:()=>settings,
      checkCapacity:async()=>Response.json(eligible),
      readRecord:async()=>({
        status:"unknown",project_name:PILOT_PROJECT_NAME,
        project_ref:null,request_id:"internal-id",encrypted_db_password:"secret",
      }),
    });
    const response=await handler(request());
    assert.equal(response.status,200);
    const result=await response.json();
    assert.equal(result.creationEnabled,false);
    assert.equal(result.existingAttempt.status,"unknown");
    assert.equal(result.existingAttempt.requiresManualReview,true);
    assert.doesNotMatch(JSON.stringify(result),/internal-id|encrypted_db_password/);
  });
});

test("creation endpoint is locked by default before any session or provider query",async()=>{
  let calls=0;
  const handler=createOneTestProjectHandler({
    getSettings:()=>lockedSettings,
    getSession:async()=>{calls++;return session;},
    getDb:async()=>{calls++;return {};},
    checkCapacity:async()=>{calls++;return Response.json(eligible);},
    submitProject:async()=>{calls++;throw Error("May never POST");},
  });
  const response=await handler(request());
  assert.equal(response.status,423);
  assert.equal(calls,0);
  const data=await response.json();
  assert.equal(data.code,"pilot_locked");
  assert.equal(data.automaticRetryAllowed,false);
});

test("only valid same-origin authenticated explicit consent can pass the write gate",async()=>{
  await withEnv(async()=>{
    let providerCalls=0;
    const handler=createOneTestProjectHandler({
      getSettings:()=>settings,
      getSession:async()=>session,
      checkCapacity:async()=>{providerCalls++;return Response.json(eligible);},
      getDb:async()=>{throw Error("May not access storage");},
    });
    assert.equal((await handler(request(undefined,{"X-CSRF-Token":"invalid"}))).status,403);
    assert.equal((await handler(request(undefined,{Origin:"https://bad.test"}))).status,403);
    assert.equal((await handler(request(undefined,{},"POST","https://klean.ly/.netlify/functions/test-project-create"))).status,403);
    assert.equal((await handler(request(undefined,{},"GET"))).status,405);
    assert.equal((await handler(request({confirmation:"NO", acknowledgeProviderCharges:true}))).status,400);
    assert.equal((await handler(request({confirmation:PILOT_CONFIRMATION, acknowledgeProviderCharges:false}))).status,400);
    assert.equal((await handler(request({...{
      confirmation:PILOT_CONFIRMATION,acknowledgeProviderCharges:true,
    }, organization_slug:"main-directory"}))).status,400);
    assert.equal(providerCalls,0);
  });
});

test("one newly reserved pilot submits once, records success, never returns secrets",async()=>{
  await withEnv(async()=>{
    let capacityCalls=0,dbLookups=0,reserves=0,lockCalls=0,posts=0,updates=0;
    const handler=createOneTestProjectHandler({
      getSettings:()=>settings,
      getSession:async()=>session,
      checkCapacity:async()=>{
        capacityCalls++;return Response.json(eligible);
      },
      getDb:async()=>({name:"injected mock db"}),
      getKey:()=>randomBytes(32),
      readRecord:async()=>{
        dbLookups++;return null;
      },
      getGrant:async()=> "private-oauth-access-token-123456",
      reserve:async()=>{
        reserves++;
        return {created:true,requestId:"test-request-id",
          password:"private-database-password-with-sufficient-entropy-and-length-12345"};
      },
      lockSubmitted:async(currentValue,requestId)=>{
        assert.equal(currentValue.user_id,session.user_id);
        assert.equal(requestId,"test-request-id");
        lockCalls++;return true;
      },
      submitProject:async(accessToken,owner,password)=>{
        posts++;
        assert.equal(accessToken,"private-oauth-access-token-123456");
        assert.equal(owner.organization_id,session.organization_id);
        assert.match(password,/private-database-password/);
        return "abcdefghijklmnopqrst";
      },
      updateStatus:async(owner,requestId,status,ref,failure)=>{
        updates++;
        assert.equal(requestId,"test-request-id");
        assert.equal(status,"created");
        assert.equal(ref,"abcdefghijklmnopqrst");
        assert.equal(failure,null);
        return true;
      },
    });
    const response=await handler(request());
    assert.equal(response.status,201);
    const result=await response.json();
    assert.equal(result.projectCreated,true);
    assert.equal(result.projectRef,"abcdefghijklmnopqrst");
    assert.equal(result.websiteCreated,false);
    assert.equal(result.crmSchemaInstalled,false);
    assert.equal(capacityCalls,1);
    assert.equal(dbLookups,1);
    assert.equal(reserves,1);
    assert.equal(lockCalls,1);
    assert.equal(posts,1);
    assert.equal(updates,1);
    assert.doesNotMatch(JSON.stringify(result),/private-|test-request-id|csrf-test-secret/);
  });
});

test("conflicting ledger reservation, failed or uncertain provider outcomes cannot retry",async()=>{
  await withEnv(async()=>{
    const records=[], posts=[];
    const common={
      getSettings:()=>settings,
      getSession:async()=>session,
      checkCapacity:async()=>Response.json(eligible),
      getDb:async()=>({name:"mock db"}),
      getKey:()=>randomBytes(32),
      readRecord:async()=>null,
      getGrant:async()=> "test-secret-access-token",
      lockSubmitted:async()=>true,
      updateStatus:async(...args)=>{records.push(args);return true;},
      submitProject:async()=>{
        posts.push("POST");
        throw new TestProjectError("provider_result_unknown",503);
      },
    };
    const conflict=createOneTestProjectHandler({
      ...common,reserve:async()=>({created:false}),
    });
    assert.equal((await conflict(request())).status,409);
    assert.equal(posts.length,0);
    const uncertain=createOneTestProjectHandler({
      ...common,reserve:async()=>({created:true,requestId:"r1",password:"strong-password"}),
    });
    const response=await uncertain(request());
    assert.equal(response.status,503);
    const data=await response.json();
    assert.equal(data.creationOutcome,"unverified");
    assert.equal(data.automaticRetryAllowed,false);
    assert.equal(posts.length,1);
    assert.equal(records.length,1);
    assert.equal(records[0][2],"unknown");
    const existing=createOneTestProjectHandler({
      ...common,
      readRecord:async()=>({status:"unknown",project_name:PILOT_PROJECT_NAME}),
      reserve:async()=>{throw Error("no duplicate reservation");},
    });
    assert.equal((await existing(request())).status,409);
    assert.equal(posts.length,1);
  });
});

test("pilot creation refuses two observed projects, paid plan or missing grant",async()=>{
  await withEnv(async()=>{
    for(const altered of [
      {visibleAccountProjects:2},
      {freePlanConfirmed:false},
      {thisOrganizationProjects:0},
    ]) {
      const handler=createOneTestProjectHandler({
        getSettings:()=>settings,
        getSession:async()=>session,
        checkCapacity:async()=>Response.json({...eligible,...altered}),
        getDb:async()=>{throw Error("Should not reach DB");},
      });
      const response=await handler(request());
      assert.equal(response.status,409);
      assert.equal((await response.json()).code,"no_free_capacity");
    }
  });
});
