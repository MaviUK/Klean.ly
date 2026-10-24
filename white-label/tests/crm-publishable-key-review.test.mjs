import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  validatePilotPublishableKey,inspectPilotPublishableKey,
  createCrmPublishableKeyReviewHandler,diagnosePilotLedgerMismatch,
} from "../netlify/functions/crm-publishable-key-review.mjs";
import {
  PILOT_PROJECT_NAME,pilotSettings,
} from "../netlify/functions/_lib/test-project-pilot.mjs";

const ORIGIN="https://kleanly-business-installer-staging.netlify.app";
const OWNER="kleanlytest@gerball.co.uk";
const REF="nlupgjwcyivepzgqffss";
const SITE="c4632a28-a4b0-4e77-a54e-7a8bf05a8882";
const KEY="sb_publishable_"+"A".repeat(32);
const USER={
  user_id:"pilot-user",connection_id:"pilot-connection",
  connection_status:"connected",organization_name:"kleanly test database",
  organization_id:"pilot-org",organization_slug:"pilot-org",
  email:OWNER,csrf_token:"non-public-csrf-token",
};
const settings=pilotSettings({
  KLEANLY_PILOT_OWNER_EMAIL:OWNER,
  KLEANLY_PILOT_ORGANIZATION_NAME:USER.organization_name,
});
const site={
  status:"created",site_name:"kleanly-business-crm-pilot",site_id:SITE,
  netlify_team_slug:"kleanlytest",netlify_team_id:"test-team",
  netlify_user_id:"test-netlify-user",
  user_id:USER.user_id,organization_id:USER.organization_id,
  supabase_project_ref:REF,
};
const project={status:"created",project_name:PILOT_PROJECT_NAME,project_ref:REF};
const schema={status:"applied",project_ref:REF,blueprint_version:1};
const req=(value=KEY,opts={})=>new Request(
  opts.url??ORIGIN+"/.netlify/functions/crm-publishable-key-review",
  {method:opts.method??"POST",headers:{
    Origin:ORIGIN,"Sec-Fetch-Site":"same-origin",
    "Content-Type":"application/json","X-CSRF-Token":USER.csrf_token,
    ...opts.headers,
  },...(opts.method==="GET"?{}:{body:opts.raw??JSON.stringify({publishableKey:value})})}
);
function handler(overrides={}){
 return createCrmPublishableKeyReviewHandler({
   getMode:()=> "permanent",getSession:async()=>USER,
   getSettings:()=>settings,
   getSiteLedger:async()=>site,getProjectLedger:async()=>project,
   getSchemaLedger:async()=>schema,
   inspectKey:async key=>({
     keyAccepted:key===KEY,publicSignupsDisabled:true,fingerprint:"b".repeat(12),
   }),
   ...overrides,
 });
}

test("accepts publishable-only exact key; refuses admin secrets and unsafe whitespace",()=>{
 assert.equal(validatePilotPublishableKey(KEY),KEY);
 for(const invalid of [
   "sb_secret_"+"A".repeat(40),"eyJ"+"a".repeat(130),
   " service_role","sb_publishable_short"," "+KEY,KEY+" ",
   KEY+"\n","",null,12,
 ]) assert.throws(()=>validatePilotPublishableKey(invalid),/publishable_key_format_required/);
});

test("Supabase public Auth settings checked with GET only and key never in URL",async()=>{
 const calls=[];
 const report=await inspectPilotPublishableKey(KEY,async(url,opts)=>{
   calls.push({url,opts});
   assert.equal(opts.method,"GET");
   assert.equal(opts.cache,"no-store");
   assert.equal(opts.redirect,"error");
   assert.equal(opts.credentials,"omit");
   assert.equal(opts.headers.apikey,KEY);
   assert.equal(opts.body,undefined);
   return Response.json({disable_signup:true,external:{google:false}});
 });
 assert.deepEqual({keyAccepted:report.keyAccepted,
    publicSignupsDisabled:report.publicSignupsDisabled},
   {keyAccepted:true,publicSignupsDisabled:true});
 assert.equal(calls.length,1);
 assert.equal(calls[0].url,
   "https://"+REF+".supabase.co/auth/v1/settings");
 assert.match(report.fingerprint,/^[a-f0-9]{12}$/);
 assert.doesNotMatch(JSON.stringify(report),new RegExp(KEY));
});

test("unaccepted and unavailable provider keys fail closed; no false verification",async()=>{
 await assert.rejects(inspectPilotPublishableKey(KEY,
   async()=>Response.json({message:"internal: private provider information"},{status:401})),
 /publishable_key_not_accepted/);
 await assert.rejects(inspectPilotPublishableKey(KEY,
   async()=>Response.json({},{status:200})),
 /public_auth_settings_not_verifiable/);
});

test("preflight validates connected test pilot WITHOUT ever requesting a key",async()=>{
 let providerCalls=0;
 const report=await handler({inspectKey:async()=>{providerCalls++;throw Error("No provider calls allowed");}})
   (req(null,{raw:JSON.stringify({action:"preflight"})}));
 assert.equal(report.status,200);
 const body=await report.json();
 assert.equal(body.mode,"read_only_crm_publishable_key_review");
 assert.equal(body.state,"staging_access_verified");
 assert.equal(body.pilotAccessVerified,true);
 assert.equal(body.publishableKeyVerified,false);
 assert.equal(body.keyPersisted,false);
 assert.equal(body.websiteDeployed,false);
 assert.equal(body.ownerCreated,false);
 assert.equal(body.emailSent,false);
 assert.equal(providerCalls,0);
});

test("preflight with no session or wrong pilot fails BEFORE key verification",async()=>{
 let providerCalls=0;
 const noSession=await handler({
   getSession:async()=>null,
   inspectKey:async()=>{providerCalls++;throw Error("Must not check a key");},
 })(req(null,{raw:JSON.stringify({action:"preflight"})}));
 assert.equal(noSession.status,401);
 const wrongProject=await handler({
   getProjectLedger:async()=>({...project,project_ref:"aaaaaaaaaaaaaaaaaaaa"}),
   inspectKey:async()=>{providerCalls++;throw Error("Must not check a key");},
 })(req(null,{raw:JSON.stringify({action:"preflight"})}));
 assert.equal(wrongProject.status,403);
 const body=await wrongProject.json();
 assert.match(body.error,/does not match the separate test CRM/);
 assert.equal(providerCalls,0);
});

test("precise diagnostic reasons identify ONLY the first failing pilot ledger invariant",async()=>{
 const failures=[
   ["site_record_missing",{getSiteLedger:async()=>null}],
   ["database_record_missing",{getProjectLedger:async()=>null}],
   ["schema_record_missing",{getSchemaLedger:async()=>null}],
   ["site_not_created",{getSiteLedger:async()=>({...site,status:"unknown"})}],
   ["site_name_mismatch",{getSiteLedger:async()=>({...site,site_name:"different"})}],
   ["site_id_mismatch",{getSiteLedger:async()=>({...site,site_id:"c275509f-2fe2-4fb7-a797-39de7f2b22d4"})}],
   ["site_team_mismatch",{getSiteLedger:async()=>({...site,netlify_team_slug:"live"})}],
   ["site_owner_binding_mismatch",{getSiteLedger:async()=>({...site,organization_id:"other-org"})}],
   ["site_database_reference_mismatch",{getSiteLedger:async()=>({...site,supabase_project_ref:"aaaaaaaaaaaaaaaaaaaa"})}],
   ["database_not_created",{getProjectLedger:async()=>({...project,status:"unknown"})}],
   ["database_name_mismatch",{getProjectLedger:async()=>({...project,project_name:"different"})}],
   ["database_reference_mismatch",{getProjectLedger:async()=>({...project,project_ref:"aaaaaaaaaaaaaaaaaaaa"})}],
   ["schema_not_applied",{getSchemaLedger:async()=>({...schema,status:"unknown"})}],
   ["schema_database_reference_mismatch",{getSchemaLedger:async()=>({...schema,project_ref:"aaaaaaaaaaaaaaaaaaaa"})}],
   ["schema_version_mismatch",{getSchemaLedger:async()=>({...schema,blueprint_version:2})}],
   ["linked_records_mismatch",{getSiteLedger:async()=>({...site,netlify_team_id:null})}],
 ];
 for(const [code,over] of failures){
   let inspected=0;
   const r=await handler({...over,inspectKey:async()=>{inspected++;throw Error("Key must not be inspected");}})
     (req(null,{raw:JSON.stringify({action:"preflight"})}));
   assert.equal(r.status,403,code);
   const body=await r.json();
   assert.equal(body.diagnosticCode,code);
   assert.equal(body.publishableKeyVerified,false);
   assert.equal(body.keyPersisted,false);
   assert.equal(body.websiteDeployed,false);
   assert.equal(body.ownerCreated,false);
   assert.equal(body.emailSent,false);
   assert.equal(inspected,0);
   assert.ok(!Object.hasOwn(body,"site_id"));
   assert.ok(!Object.hasOwn(body,"project_ref"));
   assert.ok(!Object.hasOwn(body,"session"));
   assert.doesNotMatch(JSON.stringify(body),/sb_publishable_|csrf-token|pilot-user|pilot-org|test-netlify-user/i);
 }
 assert.equal(diagnosePilotLedgerMismatch(USER,site,project,schema),null);
});

test("no diagnostic reason leaks on wrong session, origin, or CSRF",async()=>{
 for(const opts of [
   {getSession:async()=>null},
   {getSession:async()=>({...USER,email:"other@example.test"})},
   {getMode:()=> "disabled"},
 ]){
   const result=await handler({...opts,getSiteLedger:async()=>null})
     (req(null,{raw:JSON.stringify({action:"preflight"})}));
   const body=await result.json();
   assert.ok(result.status>=400);
   assert.equal(body.diagnosticCode,undefined);
 }
 const resp=await handler({getSiteLedger:async()=>null})(
   req(null,{raw:JSON.stringify({action:"preflight"}),headers:{"X-CSRF-Token":"wrong"}}));
 assert.equal(resp.status,403);
 assert.equal((await resp.json()).diagnosticCode,undefined);
});

test("successful review returns only key fingerprint, no persisted credential",async()=>{
 const response=await handler()(req());
 assert.equal(response.status,200);
 const body=await response.json();
 assert.equal(body.publishableKeyVerified,true);
 assert.equal(body.publicSignupsDisabled,true);
 assert.equal(body.fingerprint,"b".repeat(12));
 assert.equal(body.keyPersisted,false);
 assert.equal(body.websiteDeployed,false);
 assert.equal(body.ownerCreated,false);
 assert.equal(body.emailSent,false);
 assert.equal(body.deploymentApproved,false);
 assert.doesNotMatch(JSON.stringify(body),new RegExp(KEY));
 assert.doesNotMatch(JSON.stringify(body),/non-public-csrf-token|pilot-connection/);
});

test("verified key with public signup ENABLED is blocked from readiness",async()=>{
 const resp=await handler({inspectKey:async()=>({
   keyAccepted:true,publicSignupsDisabled:false,fingerprint:"f".repeat(12)
 })})(req());
 assert.equal(resp.status,200);
 const body=await resp.json();
 assert.equal(body.state,"signup_security_review_required");
 assert.equal(body.publicSignupsDisabled,false);
 assert.equal(body.websiteDeployed,false);
});

test("bad method, origin, CSRF, session and operator short-circuit before any provider or ledger",async()=>{
 let calls=0;
 const h=handler({
   getSiteLedger:async()=>{calls++;throw new Error("should not be called");},
 });
 const cases=[
 req(KEY,{method:"GET"}),req(KEY,{url:"https://klean.ly/.netlify/functions/crm-publishable-key-review"}),
 req(KEY,{headers:{Origin:"https://attacker.invalid"}}),
 req(KEY,{headers:{"X-CSRF-Token":"bad"}}),
 ];
 for(const r of cases) assert.ok((await h(r)).status>=400);
 const badOwner=handler({getSession:async()=>({...USER,email:"other@example.test"}),
   getSiteLedger:async()=>{calls++;throw new Error("should not call");}});
 assert.equal((await badOwner(req())).status,403);
 const badMode=handler({getMode:()=> "verification-only",
   getSiteLedger:async()=>{calls++;throw new Error("should not call");}});
 assert.equal((await badMode(req())).status,503);
 assert.equal(calls,0);
});

test("source project/site ledgers must identify exact private pilot",async()=>{
 let calls=0;
 for(const over of [
   {getProjectLedger:async()=>({...project,project_ref:"aaaaaaaaaaaaaaaaaaaa"})},
   {getSiteLedger:async()=>({...site,site_id:"c275509f-2fe2-4fb7-a797-39de7f2b22d4"})},
   {getSchemaLedger:async()=>({...schema,status:"unknown"})},
   {getSiteLedger:async()=>({...site,netlify_team_slug:"main"})},
 ]) {
   const r=await handler({...over,inspectKey:async()=>{calls++;throw Error("Not allowed");}})(req());
   assert.ok(r.status>=400);
 }
 assert.equal(calls,0);
});

test("rejects malformed JSON, excess fields, foreign key, large body, no type",async()=>{
 let calls=0;
 const h=handler({inspectKey:async()=>{calls++;throw Error("No read");}});
 for(const r of [
   req("sb_secret_"+"a".repeat(60)),
   req(KEY,{raw:"{bad JSON"}),
   req(KEY,{raw:JSON.stringify({publishableKey:KEY,extra:true})}),
   req(KEY,{raw:"x".repeat(600)}),
   req(KEY,{headers:{"Content-Type":"text/plain"}}),
 ]) {
   assert.ok((await h(r)).status>=400);
 }
 assert.equal(calls,0);
});

test("provider response key fingerprint never returned if invalid response",async()=>{
 const bad=await handler({inspectKey:async()=>({
   keyAccepted:true,publicSignupsDisabled:true,
   fingerprint:KEY
 })})(req());
 const body=await bad.json();
 assert.equal(bad.status,422);
 assert.equal(body.publishableKeyVerified,false);
 assert.doesNotMatch(JSON.stringify(body),new RegExp(KEY));
});

test("published staging client never logs or stores the submitted key",()=>{
 const app=readFileSync(new URL("../installer/app.mjs",import.meta.url),"utf8");
 const html=readFileSync(new URL("../installer/index.html",import.meta.url),"utf8");
 assert.match(html,/id="review-crm-access"/);
 assert.match(html,/id="crm-access-result"/);
 assert.match(app,/async function reviewCrmAccess/);
 assert.match(app,/action: "preflight"/);
 assert.match(app,/crmSafeAccessError/);
 assert.match(app,/diagnosticCode/);
 assert.match(app,/site_owner_binding_mismatch/);
 assert.match(app,/site_id_mismatch/);
 assert.match(html,/id="crm-public-key"/);
 assert.match(html,/id="review-crm-public-key"/);
 assert.match(app,/reviewCrmPublicKey/);
 assert.match(app,/crm-publishable-key-review/);
 assert.match(app,/byId\("crm-public-key"\)\.value = ""/);
 assert.doesNotMatch(app,/localStorage\.setItem\(["']crm-public-key/i);
});
