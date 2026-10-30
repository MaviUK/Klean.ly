import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {submitExactCrmZip,checkExactCrmDeploy} from "../netlify/functions/crm-app-deploy-once.mjs";
const site="c4632a28-a4b0-4e77-a54e-7a8bf05a8882";
const id="6add12345678901234567890";
test("Netlify adapter uploads one complete ZIP directly to the existing site",async()=>{
 let calls=0;
 const body=Buffer.from("ZIP");
 const output=await submitExactCrmZip("test-netlify-oauth-token",body,{fetchFn:async(url,opts)=>{
   calls++;
   assert.equal(url,"https://api.netlify.com/api/v1/sites/"+site+"/deploys");
   assert.equal(opts.method,"POST");
   assert.equal(opts.headers["Content-Type"],"application/zip");
   assert.equal(opts.headers.Authorization,"Bearer test-netlify-oauth-token");
   assert.deepEqual(opts.body,body);
   return Response.json({id,site_id:site,name:"kleanly-business-crm-pilot",state:"processing"},{status:201});
 }});
 assert.deepEqual(output,{deployId:id});
 assert.equal(calls,1);
});
test("status inspection is a GET to the exact deployment, not another upload",async()=>{
 const o=await checkExactCrmDeploy("test-netlify-oauth-token",id,{fetchFn:async(url,opts)=>{
  assert.equal(url,"https://api.netlify.com/api/v1/sites/"+site+"/deploys/"+id);
  assert.equal(opts.method,"GET");
  return Response.json({id,site_id:site,name:"kleanly-business-crm-pilot",state:"ready"});
 }});
 assert.equal(o.ready,true);
 await assert.rejects(checkExactCrmDeploy("test-netlify-oauth-token",id,{fetchFn:async()=>
   Response.json({id,site_id:"wrong",state:"ready"})}),/wrong_deploy_identity/);
});
test("provider timeouts and malformed responses never trigger a second POST",async()=>{
 let attempts=0;
 await assert.rejects(submitExactCrmZip("test-netlify-oauth-token",Buffer.from("ZIP"),{fetchFn:async()=>{
  attempts++;throw Error("timeout with private token details");
 }}),/netlify_deploy_outcome_unknown/);
 assert.equal(attempts,1);
});
test("immutable staging-only migration permanently locks one deployment",async()=>{
 const sql=await readFile(new URL("../netlify/database/migrations/20261024163000_portal_test_crm_app_deploys.sql",import.meta.url),"utf8");
 assert.match(sql,/UNIQUE \(deploy_key\)/);
 assert.match(sql,/UNIQUE \(netlify_site_id\)/);
 assert.match(sql,/nlupgjwcyivepzggffss/);
 assert.match(sql,/c4632a28-a4b0-4e77-a54e-7a8bf05a8882/);
 assert.doesNotMatch(sql,/on delete cascade|references portal_/i);
 const ledger=await readFile(new URL("../provisioning/first-crm-deploy-ledger.mjs",import.meta.url),"utf8");
 assert.match(ledger,/ON CONFLICT DO NOTHING RETURNING request_id/);
 assert.match(ledger,/status='reserved'/);
 assert.match(ledger,/status='submitted'/);
});
test("mobile staging form locks repeat submission and clears public key after attempt",async()=>{
 const html=await readFile(new URL("../installer/index.html",import.meta.url),"utf8");
 const app=await readFile(new URL("../installer/app.mjs",import.meta.url),"utf8");
 for(const id of ["crm-app-deploy-form","crm-deploy-public-key","crm-deploy-one","crm-deploy-credits",
   "crm-deploy-phrase","submit-crm-app-deploy","check-crm-app-deploy"]){
  assert.ok(html.includes('id="'+id+'"'));
 }
 assert.ok(app.includes("crmDeploySubmittedInThisTab=true"));
 assert.ok(app.includes('byId("crm-deploy-public-key").value=""'));
 assert.ok(app.includes("DEPLOY ONE TEST CRM"));
 assert.ok(!app.includes('localStorage.setItem("crm-deploy-public-key"'));
});
