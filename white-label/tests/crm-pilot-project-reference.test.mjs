import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {RELEASE_PILOT_SUPABASE} from "../provisioning/prepare-crm-release.mjs";
import {PILOT_REF} from "../provisioning/first-owner-pilot.mjs";
import {verifiedPilotClientConfig} from "../crm-runtime/tenant.mjs";

// This value was recovered from the ORIGINAL test project creation ledger and
// independently matched against the original site and schema ledgers. A
// one-character hand-transcription error in a later CRM runtime pin must
// never silently select a different database.
const EXPECTED_REF="nlupgjwcyivepzggffss";
const INCORRECT_TRANSCRIPTION="nlupgjwcyivepzg"+"qffss";
const SITE="https://kleanly-business-crm-pilot.netlify.app";
const FILES=[
  "crm-runtime/README.md",
  "crm-runtime/_headers",
  "crm-runtime/manifest.json",
  "crm-runtime/tenant.mjs",
  "installer/app.mjs",
  "installer/index.html",
  "netlify/functions/crm-publishable-key-review.mjs",
  "provisioning/README.md",
  "provisioning/audit-crm-release.mjs",
  "provisioning/control-plane-owner-ledger.proposed.sql",
  "provisioning/first-owner-pilot.mjs",
  "provisioning/prepare-crm-release.mjs",
  "tests/audit-crm-release.test.mjs",
  "tests/crm-invite-callback.test.mjs",
  "tests/crm-publishable-key-review.test.mjs",
  "tests/crm-runtime.test.mjs",
];
const source=file=>readFileSync(new URL("../"+file,import.meta.url),"utf8");

test("every affected pilot source and proposed ledger rejects the incorrect project transcription",()=>{
  assert.equal(EXPECTED_REF.length,20);
  assert.equal(INCORRECT_TRANSCRIPTION.length,20);
  assert.notEqual(EXPECTED_REF,INCORRECT_TRANSCRIPTION);
  for(const filename of FILES){
    const content=source(filename);
    assert.ok(content.includes(EXPECTED_REF),filename+" must target the verified test project");
    assert.ok(!content.includes(INCORRECT_TRANSCRIPTION),
      filename+" still contains the false project ref");
  }
});

test("the runtime, release package and first-owner binding use the same verified project",()=>{
  assert.equal(PILOT_REF,EXPECTED_REF);
  assert.equal(RELEASE_PILOT_SUPABASE,"https://"+EXPECTED_REF+".supabase.co");
  const manifest=JSON.parse(source("crm-runtime/manifest.json"));
  assert.equal(manifest.targetProject,EXPECTED_REF);
  assert.equal(manifest.targetSite,SITE);
  assert.equal(manifest.deployable,false);
  assert.equal(manifest.ownerInvitationConfigured,false);
  assert.equal(manifest.customerSiteDeployed,false);
  const config={
    projectUrl:RELEASE_PILOT_SUPABASE,
    siteUrl:SITE,
    publishableKey:"sb_publishable_"+"a".repeat(40),
  };
  const verified=verifiedPilotClientConfig(config,SITE);
  assert.equal(verified.projectUrl,RELEASE_PILOT_SUPABASE);
  assert.equal(verified.siteUrl,SITE);
  assert.throws(()=>verifiedPilotClientConfig({
    ...config,projectUrl:"https://"+INCORRECT_TRANSCRIPTION+".supabase.co",
  },SITE),/configuration does not match this isolated pilot/);
});

test("the network allowlist and staging installer cannot accidentally use the old project",()=>{
  const headers=source("crm-runtime/_headers");
  assert.ok(headers.includes("connect-src 'self' "+RELEASE_PILOT_SUPABASE));
  const review=source("netlify/functions/crm-publishable-key-review.mjs");
  assert.match(review,/const RUNTIME_SOURCE_PIN = "nlupgjwcyivepzggffss"/);
  assert.match(review,/verifiedProjectRef=records\[1\]\.project_ref/);
  assert.match(review,/if\(!runtimeSourceMatches\)/);
  assert.match(review,/runtime_reference_mismatch/);
  assert.match(source("installer/app.mjs"),/review\.projectUrl !== "https:\/\/nlupgjwcyivepzggffss\.supabase\.co"/);
  assert.match(source("installer/index.html"),
    /supabase\.com\/dashboard\/project\/nlupgjwcyivepzggffss\/settings\/api-keys/);
});
