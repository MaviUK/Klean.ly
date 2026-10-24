import test from "node:test";
import assert from "node:assert/strict";
import {readFile,rm,mkdtemp} from "node:fs/promises";
import {readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {buildCrmReleaseAudit} from "../tools/build-crm-preview.mjs";

const code=path=>readFileSync(new URL("../"+path,import.meta.url),"utf8");

test("only an explicitly labelled, read-only source audit is exposed in the staging UI",()=>{
  const html=code("installer/index.html");
  const js=code("installer/app.mjs");
  const builder=code("tools/build-crm-preview.mjs");
  assert.match(html,/Review CRM deployment package/);
  assert.match(html,/id="review-crm-package"/);
  assert.match(html,/id="crm-package-result"/);
  assert.match(js,/byId\("review-crm-package"\)\.addEventListener\("click", reviewCrmPackageSource\)/);
  assert.match(js,/async function reviewCrmPackageSource\(\)/);
  assert.match(js,/fetch\("\/crm-release-audit\.json"/);
  assert.match(js,/response\.json\(\)/);
  assert.match(js,/review\.sourceValidated !== true/);
  assert.match(js,/review\.websiteDeployed !== false/);
  assert.match(js,/No CRM website deployment or owner invitation was attempted/);
  assert.match(builder,/auditPilotReleaseSource\(/);
  assert.match(builder,/buildCrmReleaseAudit\(\)/);
  assert.doesNotMatch(builder,/\binviteUserByEmail\(|\bnetlify\.deploy\(/);
});

test("builder emits only nonsecret package metadata, never tenant config",async()=>{
  const root=await mkdtemp(join(tmpdir(),"kleanly-crm-static-review-"));
  try{
    const destination=join(root,"crm-release-audit.json");
    const output=await buildCrmReleaseAudit(destination);
    assert.equal(output.sourceValidated,true);
    const onDisk=JSON.parse(await readFile(destination,"utf8"));
    assert.deepEqual(onDisk,output);
    assert.equal(onDisk.noSecretKeysBundled,true);
    assert.equal(onDisk.noPublishableKeyBundled,true);
    assert.equal(onDisk.readyForSeparateDeploymentApproval,false);
    assert.equal(onDisk.websiteDeployed,false);
    assert.equal(onDisk.ownerInvitationSent,false);
    assert.equal(onDisk.filesChecked,9);
    assert.deepEqual(Object.keys(onDisk).filter(x=>/key|token|password|email/i.test(x)).sort(),
      ["noPublishableKeyBundled","noSecretKeysBundled"].sort());
  } finally{await rm(root,{recursive:true,force:true});}
});

test("installer remains the ONLY published directory",()=>{
  const netlify=code("netlify.toml");
  assert.match(netlify,/publish = "installer"/);
  assert.doesNotMatch(netlify,/publish = "crm-runtime"/);
  assert.doesNotMatch(netlify,/crm-deploy|crm-site-pilot/);
});
