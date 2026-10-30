import test from "node:test";
import assert from "node:assert/strict";
import {createOneCrmAppDeployHandler,pilotCrmDeployEnabled} from "../netlify/functions/crm-app-deploy-once.mjs";
const URL="https://kleanly-business-installer-staging.netlify.app/.netlify/functions/crm-app-deploy-once";
const project="nlupgjwcyivepzggffss";
const siteId="c4632a28-a4b0-4e77-a54e-7a8bf05a8882";
const owner="kleanlytest@gerball.co.uk";
const key="sb_publishable_"+"a".repeat(40);
const user={user_id:"pilot-user",connection_id:"pilot-connection",connection_status:"connected",organization_id:"test-org",organization_slug:"test-org",organization_name:"kleanly test database",email:owner,csrf_token:"csrf-private"};
const site={status:"created",site_name:"kleanly-business-crm-pilot",site_id:siteId,netlify_team_id:"test-team-123",netlify_team_slug:"kleanlytest",netlify_user_id:"netlify-user-123",supabase_project_ref:project,user_id:user.user_id,organization_id:user.organization_id};
const proj={status:"created",project_ref:project,project_name:"Kleanly Business Staging CRM Pilot"};
const schema={status:"applied",project_ref:project,blueprint_version:1};
const deployId="6add12345678901234567890";
const requestId="11111111-1111-4111-8111-111111111111";
function request(body={}){return new Request(URL,{method:"POST",headers:{"Origin":"https://kleanly-business-installer-staging.netlify.app","Content-Type":"application/json","X-CSRF-Token":"csrf-private","Sec-Fetch-Site":"same-origin"},body:JSON.stringify({...{confirmation:"DEPLOY ONE TEST CRM",acknowledgeCredits:true,acknowledgeOneDeploy:true,publishableKey:key},...body})});}
function make(custom={}){
 const actions=[];
 const handler=createOneCrmAppDeployHandler({
 isEnabled:()=>true,getMode:()=> "permanent",getSession:async()=>user,
 getSettings:()=>({ownerEmail:owner,organizationName:user.organization_name,allowlistConfigured:true}),
 getSite:async()=>site,getProject:async()=>proj,getSchema:async()=>schema,
 readAttempt:async()=>null,getGrant:async()=>({netlifyAccountEmail:owner,netlifyUserId:site.netlify_user_id,accessToken:"test-oauth-token"}),
 inspectSite:async()=>({confirmedFreePlan:true,siteEmpty:true,hasExistingDeploy:false,linkedRepository:false,readyToPrepareCrmPackage:true}),
 inspectKey:async()=>({keyAccepted:true,publicSignupsDisabled:true}),
 createZip:()=>({zip:Buffer.from("test-zip"),sha256:"a".repeat(64),sourceHash:"b".repeat(64),siteId,siteUrl:"https://kleanly-business-crm-pilot.netlify.app",fileCount:10}),
 reserve:async()=>{actions.push("reserve");return {reserved:true,requestId}},
 markSubmitted:async()=>{actions.push("lock");return true},
 deployZip:async()=>{actions.push("POST");return {deployId}},
 recordId:async()=>{actions.push("record");return true},
 checkDeploy:async()=>{actions.push("verify");return {ready:true,state:"ready",deployId}},
 finish:async()=>{actions.push("finish");return true},
 ...custom,
 });
 return {actions,handler};
}
test("deployment locked by default",async()=>{
 assert.equal(pilotCrmDeployEnabled({}),false);
 const {handler}=make({isEnabled:()=>false});
 assert.equal((await handler(request())).status,423);
});
test("read-only status works as a same-origin POST without consent or key",async()=>{
  let outgoing=0;
  const {handler,actions}=make({
    reserve:async()=>{outgoing++;throw Error("Status must not reserve a deploy");},
    deployZip:async()=>{outgoing++;throw Error("Status must not upload a ZIP");},
  });
  const req=new Request(URL+"?status=1",{
    method:"POST",
    headers:{
      Origin:"https://kleanly-business-installer-staging.netlify.app",
      "Sec-Fetch-Site":"same-origin",
      "Content-Type":"application/json",
      "X-CSRF-Token":"csrf-private",
    },
    body:"{}",
  });
  const response=await handler(req);
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.state,"not_attempted");
  assert.equal(body.canSubmit,true);
  assert.equal(outgoing,0);
  assert.deepEqual(actions,[]);
});
test("secure verified one-time deployment locks before upload",async()=>{
 const {handler,actions}=make();
 const response=await handler(request());
 assert.equal(response.status,201);
 const body=await response.json();
 assert.equal(body.state,"ready");
 assert.equal(body.websiteDeployed,true);
 assert.equal(body.automaticRetryAllowed,false);
 assert.equal(body.ownerCreated,false);
 assert.equal(body.emailSent,false);
 assert.deepEqual(actions,["reserve","lock","POST","record","verify","finish"]);
 assert.doesNotMatch(JSON.stringify(body),/sb_publishable_|csrf-private|test-oauth-token/);
});
test("wrong Supabase or Netlify project never uploads",async()=>{
 let posts=0;
 for(const changed of [
 {getProject:async()=>({...proj,project_ref:"abcdefghijklmnopqrst"})},
 {getSite:async()=>({...site,site_id:"c275509f-2fe2-4fb7-a797-39de7f2b22d4"})},
 {getSchema:async()=>({...schema,blueprint_version:0})},
 {inspectSite:async()=>({confirmedFreePlan:false,siteEmpty:false,hasExistingDeploy:true,linkedRepository:true,readyToPrepareCrmPackage:false})},
 {inspectKey:async()=>({keyAccepted:false,publicSignupsDisabled:false})},
 {readAttempt:async()=>({status:"submitted"})},
 {reserve:async()=>({reserved:false,requestId:null})},
 {markSubmitted:async()=>false},
 ]){
  const {handler}=make({...changed,deployZip:async()=>{posts++;return {deployId};}});
  const response=await handler(request());
  assert.ok(response.status>=400);
 }
 assert.equal(posts,0);
});
test("missing exact consent never checks providers",async()=>{
 let preflightCalls=0;
 const {handler}=make({getProject:async()=>{preflightCalls++;return proj;}});
 for(const change of [
 {confirmation:"YES"},{acknowledgeCredits:false},{acknowledgeOneDeploy:false},
 {publishableKey:"sb_secret_"+"a".repeat(40)},
 ])assert.equal((await handler(request(change))).status,400);
 assert.equal(preflightCalls,0);
});
test("uncertain outcome causes permanent no-auto-retry state",async()=>{
 let tries=0;
 const {handler,actions}=make({deployZip:async()=>{tries++;throw Error("provider private error");}});
 const response=await handler(request());
 assert.equal(response.status,503);
 const body=await response.json();
 assert.equal(body.state,"deployment_outcome_unknown_manual_review");
 assert.equal(body.automaticRetryAllowed,false);
 assert.equal(tries,1);
 assert.deepEqual(actions,["reserve","lock","finish"]);
});
