import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {EMBEDDED_CRM_FILES} from "../netlify/functions/_lib/crm-runtime-embedded.mjs";
import {buildEmbeddedCrmZip} from "../provisioning/create-embedded-crm-zip.mjs";
import {buildOfflinePilotZip} from "../provisioning/create-pilot-zip.mjs";
import {
 RELEASE_PILOT_SUPABASE,RELEASE_PILOT_SITE_ID,RELEASE_PILOT_URL,
 RELEASE_CONTENT,
} from "../provisioning/prepare-crm-release.mjs";

const key="sb_publishable_"+"a".repeat(40);
const approval={
  approvalPhrase:"PREPARE ONE CRM TEST BUILD",
  separateDeploymentApprovalRequired:true,
  siteCreateAllowed:false,emailSendAllowed:false,
};
const options={publishableKey:key,approval};
test("statically bundled CRM source exactly matches every reviewed source file",async()=>{
  assert.deepEqual(EMBEDDED_CRM_FILES.map(e=>e.filename),RELEASE_CONTENT);
  for(const item of EMBEDDED_CRM_FILES){
    const s=await readFile(new URL("../crm-runtime/"+item.filename,import.meta.url),"utf8");
    assert.equal(item.source,s,"embedded source drift: "+item.filename);
    assert.doesNotMatch(s,/\bsb_secret_[A-Za-z0-9_-]{16,}\b/);
  }
});
test("bundled one-site archive is byte-identical to audited local offline archive",async()=>{
  const embedded=buildEmbeddedCrmZip(options);
  const offline=await buildOfflinePilotZip({
    sourceDir:fileURLToPath(new URL("../crm-runtime/",import.meta.url)),
    siteId:RELEASE_PILOT_SITE_ID,
    siteUrl:RELEASE_PILOT_URL,
    projectUrl:RELEASE_PILOT_SUPABASE,
    publishableKey:key,approval,
  });
  assert.equal(embedded.fileCount,10);
  assert.equal(embedded.sourceHash,offline.sourceHash);
  assert.equal(embedded.sha256,offline.archiveSha256);
  assert.deepEqual(embedded.zip,offline.archive);
  assert.equal(embedded.uploaded,false);
  assert.equal(embedded.inviteSent,false);
  assert.equal(embedded.ownerCreated,false);
});
test("bundle builder denies wrong key and source drift",()=>{
  for(const candidate of ["sb_secret_"+"a".repeat(40),"service_role","",key+" "]) {
    assert.throws(()=>buildEmbeddedCrmZip({...options,publishableKey:candidate}),
      /crm_release_not_approved_or_wrong_target/);
  }
  const altered=EMBEDDED_CRM_FILES.map(v=>({...v}));
  altered[0].source="X-Robots-Tag: noindex, nofollow";
  assert.throws(()=>buildEmbeddedCrmZip({...options,embedded:altered}),
    /embedded_runtime_security_check_failed/);
  altered[0].source=EMBEDDED_CRM_FILES[0].source;
  altered[3].filename="../../admin";
  assert.throws(()=>buildEmbeddedCrmZip({...options,embedded:altered}),
    /invalid_embedded_source/);
});
