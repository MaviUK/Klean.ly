import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CRM_SITE_KEY, CRM_SITE_CONFIRMATION, CRM_SITE_TEAM_SLUG,
  CRM_SITE_OWNER_EMAIL, crmSiteCreationEnabled, publicCrmSiteAttempt,
  reserveCrmSiteAttempt, markCrmSiteSubmitted, finishCrmSiteAttempt,
  normalizeCrmSiteData, createOneCrmNetlifySite, verifyCreatedCrmSite,
  CrmSitePilotError,
} from "../netlify/functions/_lib/crm-site-pilot.mjs";
import { createCrmSiteApprovalHandler, verifiedCrmSiteCapacity } from
  "../netlify/functions/crm-site-approval.mjs";
import { createOneCrmSiteHandler, validSiteConsent } from
  "../netlify/functions/crm-site-create.mjs";
import { PILOT_CRM_SITE_NAME, PILOT_CRM_SITE_URL } from
  "../netlify/functions/crm-site-proposal.mjs";
import { PILOT_PROJECT_NAME, pilotSettings } from
  "../netlify/functions/_lib/test-project-pilot.mjs";

const origin = "https://kleanly-business-installer-staging.netlify.app";
const siteId = "c275509f-2fe2-4fb7-a797-39de7f2b22d4";
const ref = "abcdefghijklmnopqrst";
const current = {
  user_id: "pilot-user", connection_id:"pilot-connection",
  connection_status:"connected", email:CRM_SITE_OWNER_EMAIL,
  organization_name:"kleanly test database",
  organization_id:"test-org", organization_slug:"test-org",
  csrf_token:"csrf-private",
};
const settings = pilotSettings({
  KLEANLY_PILOT_OWNER_EMAIL:CRM_SITE_OWNER_EMAIL,
  KLEANLY_PILOT_ORGANIZATION_NAME:current.organization_name,
});
const capacity = {
  mode:"read_only_crm_free_site_capacity", ownerEmail:CRM_SITE_OWNER_EMAIL,
  connectedNetlifyAccount:CRM_SITE_OWNER_EMAIL,
  teamSlug:CRM_SITE_TEAM_SLUG, proposedSiteUrl:PILOT_CRM_SITE_URL,
  confirmedFreePlan:true, sitesInTeam:0,
  capacityAppearsAvailable:true, matchingNameInChosenTeam:false,
  globalNameAvailabilityConfirmed:false,remainingMonthlyCreditsVerified:false,
  providerCostApprovalRequired:true, siteCreated:false,
  deploymentCreated:false, creationEnabled:false,writeAttempted:false,
};
const team={id:"verified-netlify-test-team",name:"kleanlytest's team",
  slug:CRM_SITE_TEAM_SLUG,plan:"Free"};
const info={netlifyAccountEmail:CRM_SITE_OWNER_EMAIL,
  netlifyUserId:"test-user-id",accessToken:"private-test-access-token"};
const project={status:"created",project_name:PILOT_PROJECT_NAME,project_ref:ref};
const schema={status:"applied",project_ref:ref,blueprint_version:1};
const consent={confirmation:CRM_SITE_CONFIRMATION,acknowledgeFreeCredits:true,
  acknowledgeSingleEmptySite:true};
function request(body, path="crm-site-create", url=origin+"/.netlify/functions/"+path, headers={}, method="POST"){
  return new Request(url,{method,headers:{
    Origin:origin,"Sec-Fetch-Site":"same-origin",
    "X-CSRF-Token":current.csrf_token,
    "Content-Type":"application/json",...headers,
  },body:method==="POST"&&body!==undefined?JSON.stringify(body):undefined});
}
function proposalHandler(overrides={}){
  return createCrmSiteApprovalHandler({
    getSession:async()=>current,getMode:()=>"permanent",
    getSettings:()=>settings,isEnabled:()=>false,
    checkCapacity:async()=>Response.json(capacity),
    readAttempt:async()=>null,...overrides,
  });
}
function createHandler(overrides={}){
  return createOneCrmSiteHandler({
    isEnabled:()=>true,getMode:()=>"permanent",getSession:async()=>current,
    getSettings:()=>settings,checkCapacity:async()=>Response.json(capacity),
    getProjectRecord:async()=>project,getSchemaAttempt:async()=>schema,
    getGrant:async()=>info,
    inspectNetlify:async()=>({accounts:[team],existingSitesVisibleToUser:[]}),
    readAttempt:async()=>null,
    reserve:async()=>({reserved:true,requestId:"request-one"}),
    lockSubmitted:async()=>true,
    createSite:async()=>({id:siteId,name:PILOT_CRM_SITE_NAME,
      accountId:team.id,url:PILOT_CRM_SITE_URL}),
    verifySite:async()=>true,
    finish:async()=>true,...overrides,
  });
}

test("one-site creation remains disabled by default; no provider access when locked",async()=>{
  assert.equal(crmSiteCreationEnabled({}),false);
  assert.equal(crmSiteCreationEnabled({KLEANLY_TEST_CRM_SITE_CREATION_ENABLED:"false"}),false);
  assert.equal(crmSiteCreationEnabled({KLEANLY_TEST_CRM_SITE_CREATION_ENABLED:"true"}),true);
  let calls=0;
  const response=await createHandler({
    isEnabled:()=>false,
    getSession:async()=>{calls++;throw Error("never");},
    reserve:async()=>{calls++;throw Error("never");},
    createSite:async()=>{calls++;throw Error("never");},
  })(request(consent));
  assert.equal(response.status,423);
  assert.equal(calls,0);
  assert.equal((await response.json()).automaticRetryAllowed,false);
});

test("staging review stays locked and offers no creation without explicit flag",async()=>{
  const result=await proposalHandler()(request(undefined,"crm-site-approval"));
  assert.equal(result.status,200);
  const data=await result.json();
  assert.equal(data.proposedSiteUrl,PILOT_CRM_SITE_URL);
  assert.equal(data.confirmedFreePlan,true);
  assert.equal(data.confirmationPhrase,CRM_SITE_CONFIRMATION);
  assert.equal(data.creationUnlocked,false);
  assert.equal(data.creationLocked,true);
  assert.equal(data.siteCreated,false);
  assert.equal(data.writeAttempted,false);
  assert.equal(data.noPaidAddonsRequested,true);
  assert.equal(data.creditBalanceVerifiedByProvider,false);
  assert.equal(data.needsFinalConfirmation,true);
  const enabled=await proposalHandler({isEnabled:()=>true})(request(undefined,"crm-site-approval"));
  assert.equal((await enabled.json()).creationUnlocked,true);
});

test("read-only review detects existing one-time reservation and never offers repeat",async()=>{
  for(const status of ["reserved","submitted","unknown","rejected","created"]){
    let checked=0;
    const response=await proposalHandler({
      isEnabled:()=>true,
      readAttempt:async()=>({status,site_name:PILOT_CRM_SITE_NAME,site_id:siteId}),
      checkCapacity:async()=>{checked++;throw Error("not needed");},
    })(request(undefined,"crm-site-approval"));
    assert.equal(response.status,200);
    const data=await response.json();
    assert.equal(data.creationUnlocked,false);
    assert.equal(data.noSecondAttemptAllowed,true);
    assert.equal(data.existingAttempt.status,status);
    assert.equal(data.siteCreated,status==="created");
    assert.equal(checked,0);
  }
});

test("provider site creation targets the team-specific API with only the site name",async()=>{
  let calls=0;
  const result=await createOneCrmNetlifySite("private-test-netlify-token",team.id,{
    fetchFn:async(url,options)=>{
      calls++;
      assert.equal(url,"https://api.netlify.com/api/v1/kleanlytest/sites");
      assert.equal(options.method,"POST");
      assert.deepEqual(JSON.parse(options.body),{name:PILOT_CRM_SITE_NAME});
      assert.equal(options.headers.Authorization,"Bearer private-test-netlify-token");
      return Response.json({id:siteId,name:PILOT_CRM_SITE_NAME,
        account_id:team.id,account_slug:CRM_SITE_TEAM_SLUG},{status:201});
    },
  });
  assert.equal(calls,1);
  assert.deepEqual(result,{id:siteId,name:PILOT_CRM_SITE_NAME,
    accountId:team.id,url:PILOT_CRM_SITE_URL});
  assert.equal(await verifyCreatedCrmSite("private-test-netlify-token",siteId,team.id,{
    fetchFn:async(url,options)=>{
      assert.equal(url,"https://api.netlify.com/api/v1/sites/"+siteId);
      assert.equal(options.method,"GET");
      assert.ok(!options.body);
      return Response.json({id:siteId,name:PILOT_CRM_SITE_NAME,
        account_id:team.id,account_slug:CRM_SITE_TEAM_SLUG});
    },
  }),true);
});

test("strict site verification rejects fake teams, names, paid domains and bad IDs",()=>{
  const good={id:siteId,name:PILOT_CRM_SITE_NAME,account_id:team.id};
  assert.throws(()=>normalizeCrmSiteData({...good,name:"klean.ly"} ,team.id));
  assert.throws(()=>normalizeCrmSiteData({...good,account_id:"live-team"} ,team.id));
  assert.throws(()=>normalizeCrmSiteData({...good,id:"site-id"} ,team.id));
  assert.throws(()=>normalizeCrmSiteData({...good,custom_domain:"klean.ly"} ,team.id));
  assert.throws(()=>normalizeCrmSiteData({...good,account_slug:"another-team"} ,team.id));
});

test("the one-attempt ledger is globally unique, immutable under OAuth disconnect",async()=>{
  const migration=readFileSync(new URL(
    "../netlify/database/migrations/20261018194000_portal_test_crm_site_creations.sql",import.meta.url),"utf8");
  assert.match(migration,/UNIQUE \(site_key\)/);
  assert.match(migration,/status IN \('reserved', 'submitted', 'created', 'rejected', 'unknown'\)/);
  assert.doesNotMatch(migration,/ON DELETE CASCADE/i);
  assert.equal(CRM_SITE_KEY,"pilot-crm-site-v1");
  const calls=[];
  const db={pool:{query:async(sql,args)=>{
    calls.push([sql,args]);return {rows:[{request_id:"one"}]};
  }}};
  const reserve=await reserveCrmSiteAttempt(current,ref,info.netlifyUserId,team.id,{
    db,requestId:"one",
  });
  assert.deepEqual(reserve,{reserved:true,requestId:"one"});
  assert.equal(await markCrmSiteSubmitted(current,"one",db),true);
  assert.equal(await finishCrmSiteAttempt(current,"one","created",siteId,null,db),true);
  assert.match(calls[0][0],/ON CONFLICT DO NOTHING/);
  assert.match(calls[1][0],/status = 'reserved'/);
  assert.match(calls[2][0],/status = 'submitted'/);
  assert.equal(calls[0][1][3],ref);
  const blockedDb={pool:{query:async()=>({rows:[]})}};
  assert.deepEqual(await reserveCrmSiteAttempt(current,ref,info.netlifyUserId,team.id,{
    db:blockedDb,requestId:"second",
  }),{reserved:false,requestId:null});
  assert.equal(publicCrmSiteAttempt({site_id:siteId,status:"created"}).mayRetryAutomatically,false);
});

test("site consents require exactly three server-verified values",async()=>{
  assert.equal(await validSiteConsent(request(consent)),true);
  for(const changed of [
    {},{...consent,confirmation:"WRONG"},
    {...consent,acknowledgeFreeCredits:false},
    {...consent,acknowledgeSingleEmptySite:false},
    {...consent,name:"another.netlify.app"},
  ]){
    assert.equal(await validSiteConsent(request(changed)),false);
  }
});

test("creation blocked before side effects for foreign site, owner, CSRF, invalid consent",async()=>{
  let calls=0;
  const h=createHandler({reserve:async()=>{calls++;throw Error("must not reserve");}});
  assert.equal((await h(request(consent,"crm-site-create",
    "https://klean.ly/.netlify/functions/crm-site-create"))).status,403);
  assert.equal((await h(request(consent,"crm-site-create",undefined,
    {Origin:"https://attacker.invalid"}))).status,403);
  assert.equal((await h(request(consent,"crm-site-create",undefined,
    {"X-CSRF-Token":"incorrect"}))).status,403);
  assert.equal((await h(request({...consent,confirmation:"bad"}))).status,400);
  assert.equal((await createHandler({
    getSession:async()=>({...current,email:"unapproved@example.test"}),
    reserve:async()=>{calls++;throw Error("must not reserve");},
  })(request(consent))).status,403);
  assert.equal(calls,0);
});

test("existing site, paid plan or invalid CRM schema blocks Netlify write",async()=>{
  for(const changes of [
    {checkCapacity:async()=>Response.json({...capacity,matchingNameInChosenTeam:true})},
    {checkCapacity:async()=>Response.json({...capacity,confirmedFreePlan:false})},
    {checkCapacity:async()=>Response.json({...capacity,capacityAppearsAvailable:false})},
    {getSchemaAttempt:async()=>({...schema,status:"unknown"})},
    {getProjectRecord:async()=>({...project,project_ref:"00000000000000000000"})},
    {inspectNetlify:async()=>({accounts:[{...team,plan:"Pro"}],existingSitesVisibleToUser:[]})},
    {inspectNetlify:async()=>({accounts:[team],existingSitesVisibleToUser:[{id:siteId}]})},
    {readAttempt:async()=>({status:"unknown"})},
    {reserve:async()=>({reserved:false,requestId:null})},
    {lockSubmitted:async()=>false},
  ]){
    let creates=0;
    const r=await createHandler({
      createSite:async()=>{creates++;throw Error("should not run");},
      ...changes,
    })(request(consent));
    assert.equal(r.ok,false);
    assert.equal(creates,0);
    assert.equal((await r.json()).automaticRetryAllowed,false);
  }
});

test("one success applies exactly one POST after reservation and verifies before recording",async()=>{
  const order=[];
  const h=createHandler({
    reserve:async(currentRecord,projectRef,userId,teamId)=>{
      order.push(["reserve",projectRef,userId,teamId]);return {reserved:true,requestId:"unique"};
    },
    lockSubmitted:async()=>{order.push(["locked"]);return true;},
    createSite:async()=>{order.push(["create"]);return {id:siteId,name:PILOT_CRM_SITE_NAME};},
    verifySite:async()=>{order.push(["verify"]);return true;},
    finish:async(user,id,status,siteIdValue)=>{
      order.push(["finish",status,siteIdValue]);return true;
    },
  });
  const r=await h(request(consent));
  assert.equal(r.status,201);
  const data=await r.json();
  assert.equal(data.siteCreated,true);
  assert.equal(data.siteUrl,PILOT_CRM_SITE_URL);
  assert.equal(data.deployed,false);
  assert.equal(data.ownerCreated,false);
  assert.equal(data.invitationSent,false);
  assert.deepEqual(order.map(x=>x[0]),["reserve","locked","create","verify","finish"]);
  assert.equal(order.filter(x=>x[0]==="create").length,1);
  assert.equal(order[0][1],ref);
  assert.equal(order[4][1],"created");
});

test("provider failure, timeout, verification error never allows automatic retry",async()=>{
  for(const type of ["permission","conflict","timeout","verification"]){
    const statuses=[];
    const response=await createHandler({
      createSite:async()=>{
        if(type==="permission")throw new CrmSitePilotError("provider_permission_denied");
        if(type==="conflict")throw new CrmSitePilotError("site_name_unavailable");
        if(type==="timeout")throw Error("Netlify may have created the site");
        return {id:siteId};
      },
      verifySite:async()=>type==="verification"?false:true,
      finish:async(user,id,status)=>{statuses.push(status);return true;},
    })(request(consent));
    assert.equal(response.ok,false);
    assert.equal(statuses.length,1);
    assert.equal(statuses[0],["permission","conflict"].includes(type)?"rejected":"unknown");
    assert.equal((await response.json()).automaticRetryAllowed,false);
  }
});

test("mobile owner consent form remains hidden and disabled until backend flag is enabled",()=>{
  const html=readFileSync(new URL("../installer/index.html",import.meta.url),"utf8");
  const js=readFileSync(new URL("../installer/app.mjs",import.meta.url),"utf8");
  assert.match(html,/id="review-crm-site-create" class="action-button" disabled/);
  assert.match(html,/id="crm-site-create-form" class="pilot-approval" hidden/);
  assert.match(html,/id="create-one-crm-site" class="action-button" disabled/);
  assert.match(js,/window\.confirm\(/);
  assert.match(js,/\.netlify\/functions\/crm-site-create/);
  assert.match(js,/acknowledgeSingleEmptySite: true/);
  assert.match(js,/byId\("review-crm-site-create"\)\.addEventListener/);
});
