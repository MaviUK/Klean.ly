import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,readFile,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
  RELEASE_CONTENT,RELEASE_PILOT_URL,RELEASE_PILOT_SUPABASE,
  RELEASE_PILOT_SITE_ID,checkReleaseInput,preparePilotRelease,
} from "../provisioning/prepare-crm-release.mjs";

const approval={approvalPhrase:"PREPARE ONE CRM TEST BUILD",
  separateDeploymentApprovalRequired:true,
  siteCreateAllowed:false,emailSendAllowed:false};
const args={
  siteId:RELEASE_PILOT_SITE_ID,
  siteUrl:RELEASE_PILOT_URL,
  projectUrl:RELEASE_PILOT_SUPABASE,
  publishableKey:"sb_publishable_"+"a".repeat(40),
  approval,
};

test("release input fails shut on other Netlify/Supabase, service-role or absent consent",()=>{
  assert.equal(checkReleaseInput(args).siteId,RELEASE_PILOT_SITE_ID);
  for(const bad of [
    {siteId:"other-site-id"}, {siteUrl:"https://klean.ly"},
    {projectUrl:"https://other.supabase.co"},
    {publishableKey:"sb_secret_"+"x".repeat(40)},
    {publishableKey:"service_role"},
    {publishableKey:""},
    {approval:null},
    {approval:{...approval,approvalPhrase:"YES"}},
    {approval:{...approval,siteCreateAllowed:true}},
    {approval:{...approval,emailSendAllowed:true}},
  ]) assert.throws(()=>checkReleaseInput({...args,...bad}),/crm_release_not_approved/);
});

test("release is exactly allowlisted static files and public-only config; no upload or email",async()=>{
  const root=await mkdtemp(join(tmpdir(),"kleanly-release-test-"));
  try {
    const source=join(root,"source"),dest=join(root,"artifact");
    await mkdir(join(source,"auth","callback"),{recursive:true});
    for(const f of RELEASE_CONTENT) {
      const full=join(source,f);
      await writeFile(full,"non-empty fixture: "+f);
    }
    await writeFile(join(source,"not-for-release.key"),"NEVER_COPY");
    await writeFile(join(source,"README.md"),"NEVER_COPY");
    const result=await preparePilotRelease({...args,sourceDir:source,outputDir:dest});
    assert.deepEqual({
      files:result.applicationFiles,needsApproval:result.needsSeparateNetlifyDeployApproval,
      deployed:result.websiteDeployed,sent:result.ownerInvitationSent,
      created:result.ownerCreated
    },{files:RELEASE_CONTENT.length+1,needsApproval:true,
      deployed:false,sent:false,created:false});
    assert.match(result.sourceHash,/^[a-f0-9]{64}$/);
    const output=JSON.parse(await readFile(join(dest,"tenant-config.json"),"utf8"));
    assert.deepEqual(output,{
      siteUrl:RELEASE_PILOT_URL,projectUrl:RELEASE_PILOT_SUPABASE,
      publishableKey:args.publishableKey,
    });
    await assert.rejects(readFile(join(dest,"not-for-release.key")));
    await assert.rejects(readFile(join(dest,"README.md")));
    await assert.rejects(preparePilotRelease({...args,sourceDir:source,outputDir:dest}));
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("builder is not attached to current Netlify staging build command",async()=>{
  const {readFileSync}=await import("node:fs");
  const toml=readFileSync(new URL("../netlify.toml",import.meta.url),"utf8");
  assert.match(toml,/publish = "installer"/);
  assert.doesNotMatch(toml,/prepare-crm-release|publish = "crm-runtime"/);
  const source=readFileSync(new URL("../provisioning/prepare-crm-release.mjs",import.meta.url),"utf8");
  assert.doesNotMatch(source,/\b(?:deployToNetlify|inviteUserByEmail|service_role|sb_secret_)\s*\(/);
});
