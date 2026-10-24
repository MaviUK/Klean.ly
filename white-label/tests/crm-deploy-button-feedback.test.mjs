import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";

const script = readFileSync(new URL("../installer/app.mjs",import.meta.url),"utf8");
const html = readFileSync(new URL("../installer/index.html",import.meta.url),"utf8");
function functionSource(start,end){
  const first=script.indexOf(start),last=script.indexOf(end,first+start.length);
  assert.ok(first>=0&&last>first,start+" function located");
  return script.slice(first,last);
}
const blocker=functionSource("function crmDeployFormBlocker() {","function renderSummary()");
const submit=functionSource("async function submitOneCrmAppDeployment(event) {","async function reviewCrmPackageSource()");

function environment(){
  const fields = {
    "crm-deploy-public-key": {value:""},
    "crm-deploy-credits": {checked:false},
    "crm-deploy-one": {checked:false},
    "crm-deploy-phrase": {value:""},
    "crm-app-deploy-result": {
      textContent:"",
      classList:{add(){},remove(){}},
    },
  };
  const requests=[];
  const context={
    crmDeploySubmittedInThisTab:false,
    crmDeployAlreadyAttempted:false,
    crmDeploySubmitPending:false,
    oauthState:{connected:true,csrfToken:"local-test-csrf"},
    netlifyState:{connected:true},
    byId:id=>fields[id]??(fields[id]={textContent:"",classList:{add(){},remove(){}}}),
    renderProviders(){},
    window:{confirm:()=>false},
    async fetch(...args){requests.push(args);throw Error("No fetch unless explicitly allowed");},
  };
  vm.runInNewContext(blocker+"\n"+submit+"\nthis.blocker=crmDeployFormBlocker;this.submit=submitOneCrmAppDeployment;",context);
  return {context,fields,requests,submit:()=>context.submit({preventDefault(){}})};
}
test("deploy form has visible live prerequisite guidance and submit wiring",()=>{
  assert.match(html,/id="crm-deploy-requirements"[^>]*aria-live="polite"/);
  assert.match(script,/byId\("crm-deploy-public-key"\)\.addEventListener\("input", renderProviders\)/);
  assert.match(script,/byId\("crm-deploy-credits"\)\.addEventListener\("change", renderProviders\)/);
  assert.match(script,/byId\("crm-deploy-one"\)\.addEventListener\("change", renderProviders\)/);
  assert.match(script,/byId\("crm-deploy-phrase"\)\.addEventListener\("input", renderProviders\)/);
  assert.match(script,/byId\("submit-crm-app-deploy"\)\.disabled = unsafeToSubmit/);
  assert.doesNotMatch(script,/byId\("submit-crm-app-deploy"\)\.disabled =[^;]*"crm-deploy-credits"/);
  assert.match(script,/byId\("crm-app-deploy-form"\)\.addEventListener\("submit", submitOneCrmAppDeployment\)/);
});
test("incomplete form gives helpful warnings without provider calls",async()=>{
  const t=environment();
  const key="sb_publishable_"+"a".repeat(40);
  const errors=[
    [/Step 1: paste/,()=>t.fields["crm-deploy-public-key"].value=key],
    [/Step 2: tick/,()=>t.fields["crm-deploy-credits"].checked=true],
    [/Step 3: tick/,()=>t.fields["crm-deploy-one"].checked=true],
    [/Step 4: type/,()=>t.fields["crm-deploy-phrase"].value="DEPLOY ONE TEST CRM"],
  ];
  for(const [pattern,fix] of errors){
    assert.match(t.context.blocker(),pattern);
    await t.submit();
    assert.match(t.fields["crm-app-deploy-result"].textContent,/No deployment request was sent/);
    assert.equal(t.requests.length,0);
    fix();
  }
  assert.equal(t.context.blocker(),"");
  await t.submit(); // user cancels final confirmation
  assert.match(t.fields["crm-app-deploy-result"].textContent,/No upload was submitted/);
  assert.equal(t.requests.length,0);
});
test("reconnection and previous attempts are visibly blocked, no retry",async()=>{
  const t=environment();
  const o=t.fields;
  o["crm-deploy-public-key"].value="sb_publishable_"+"a".repeat(40);
  o["crm-deploy-credits"].checked=true;
  o["crm-deploy-one"].checked=true;
  o["crm-deploy-phrase"].value="DEPLOY ONE TEST CRM";
  for(const prop of ["crmDeployAlreadyAttempted","crmDeploySubmittedInThisTab","crmDeploySubmitPending"]){
    t.context[prop]=true;
    assert.match(t.context.blocker(),/Do NOT|in progress/);
    await t.submit();
    assert.equal(t.requests.length,0);
    t.context[prop]=false;
  }
  t.context.netlifyState.connected=false;
  assert.match(t.context.blocker(),/connect both approved TEST accounts/);
  await t.submit();
  assert.equal(t.requests.length,0);
});
test("valid one-time confirmation sends only one exact upload POST",async()=>{
  const t=environment();
  t.fields["crm-deploy-public-key"].value="sb_publishable_"+"a".repeat(40);
  t.fields["crm-deploy-credits"].checked=true;
  t.fields["crm-deploy-one"].checked=true;
  t.fields["crm-deploy-phrase"].value="DEPLOY ONE TEST CRM";
  t.context.window.confirm=()=>true;
  t.context.fetch=async (...args)=>{
    t.requests.push(args);
    return {ok:true,json:async()=>({
      mode:"staging_exact_first_crm_deploy",state:"submitted",
      firstDeploymentOnly:true,automaticRetryAllowed:false,
      ownerCreated:false,emailSent:false,
    })};
  };
  await t.submit();
  assert.equal(t.requests.length,1);
  assert.equal(t.requests[0][0],"/.netlify/functions/crm-app-deploy-once");
  assert.equal(t.requests[0][1].method,"POST");
  assert.equal(t.context.crmDeploySubmittedInThisTab,true);
  assert.equal(t.context.crmDeployAlreadyAttempted,true);
  assert.equal(t.fields["crm-deploy-public-key"].value,"");
  assert.equal(t.fields["crm-deploy-phrase"].value,"");
  assert.match(t.fields["crm-app-deploy-result"].textContent,/Do NOT submit again/);
  await t.submit();
  assert.equal(t.requests.length,1);
});
