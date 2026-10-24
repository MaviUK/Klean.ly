import test from "node:test";
import assert from "node:assert/strict";
import {readFile,writeFile,mkdir,cp,rm,mkdtemp,symlink} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {dirname,join} from "node:path";
import {tmpdir} from "node:os";
import {
  auditPilotReleaseSource,
} from "../provisioning/audit-crm-release.mjs";
import {
  RELEASE_PILOT_SITE_ID,RELEASE_PILOT_SUPABASE,RELEASE_PILOT_URL,
} from "../provisioning/prepare-crm-release.mjs";

const source=fileURLToPath(new URL("../crm-runtime/",import.meta.url));

test("audit actual committed CRM assets without keys, visitors, deploys or invitations",async()=>{
  const r=await auditPilotReleaseSource(source);
  assert.equal(r.audit,"source-only");
  assert.equal(r.sourceValidated,true);
  assert.equal(r.noPublishableKeyBundled,true);
  assert.equal(r.noSecretKeysBundled,true);
  assert.equal(r.filesChecked,9);
  assert.equal(r.siteId,RELEASE_PILOT_SITE_ID);
  assert.equal(r.siteUrl,RELEASE_PILOT_URL);
  assert.equal(r.projectUrl,RELEASE_PILOT_SUPABASE);
  assert.match(r.sourceHash,/^[a-f0-9]{64}$/);
  assert.equal(r.websiteDeployed,false);
  assert.equal(r.ownerInvitationSent,false);
  assert.equal(r.readyForSeparateDeploymentApproval,false);
  assert.ok(r.remainingPrerequisites.length>=3);
});

async function copySource(fn) {
  const root=await mkdtemp(join(tmpdir(),"crm-audit-test-"));
  const dir=join(root,"code");
  await cp(source,dir,{recursive:true});
  try{await fn(dir,root);} finally{await rm(root,{recursive:true,force:true});}
}
test("fails closed if a public key, secret, unsafe HTML or modified target enters source",async()=>{
  await copySource(async dir=>{
    const config=join(dir,"tenant-config.json");
    await writeFile(config,JSON.stringify({publishableKey:"sb_publishable_FAKE"}));
    await assert.rejects(auditPilotReleaseSource(dir),/embedded_credentials/);
    await rm(config);
    const file=join(dir,"manifest.json");
    const original=await readFile(file,"utf8");
    await writeFile(file,original.replace("nlupgjwcyivepzgqffss","live_project_ref"));
    await assert.rejects(auditPilotReleaseSource(dir),/manifest_safety_state/);
  });
  await copySource(async dir=>{
    const file=join(dir,"index.html");
    const original=await readFile(file,"utf8");
    await writeFile(file,original.replace("<body>","<body><script>alert(1)</script>"));
    await assert.rejects(auditPilotReleaseSource(dir),/unsafe_html/);
    await writeFile(file,original);
    const css=join(dir,"styles.css");
    await writeFile(css,(await readFile(css,"utf8"))+"\nsb_secret_"+"a".repeat(40));
    await assert.rejects(auditPilotReleaseSource(dir),/sensitive_source/);
  });
});

test("fails if auth callback references break, Netlify security headers soften or modules disappear",async()=>{
  await copySource(async dir=>{
    const callback=join(dir,"auth/callback/index.html");
    await writeFile(callback,(await readFile(callback,"utf8"))
      .replace("../../invite-callback.mjs","../../wrong-module.mjs"));
    await assert.rejects(auditPilotReleaseSource(dir),/broken_page_assets/);
  });
  await copySource(async dir=>{
    const header=join(dir,"_headers");
    await writeFile(header,(await readFile(header,"utf8"))
      .replace("script-src 'self'","script-src 'self' 'unsafe-inline'"));
    await assert.rejects(auditPilotReleaseSource(dir),/missing_security_headers/);
  });
  await copySource(async dir=>{
    await rm(join(dir,"app.mjs"));
    await assert.rejects(auditPilotReleaseSource(dir),/ENOENT/);
  });
});
test("does not follow symlinks from the package source directory",async()=>{
  await copySource(async(dir,root)=>{
    const target=join(dir,"app.mjs");
    await rm(target);
    const outside=join(root,"private-key");
    await writeFile(outside,"private data not eligible for release");
    await symlink(outside,target);
    await assert.rejects(auditPilotReleaseSource(dir),/unsafe_asset/);
  });
});
test("staging deploy still excludes the CRM runtime directory",async()=>{
  const toml=await readFile(new URL("../netlify.toml",import.meta.url),"utf8");
  assert.match(toml,/publish = "installer"/);
  assert.doesNotMatch(toml,/publish = "crm-runtime"/);
});
