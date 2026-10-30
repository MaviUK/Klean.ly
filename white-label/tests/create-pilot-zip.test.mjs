import test from "node:test";
import assert from "node:assert/strict";
import {readFile, lstat} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {
  buildOfflinePilotZip,encodePilotZip,
} from "../provisioning/create-pilot-zip.mjs";
import {
  RELEASE_CONTENT,RELEASE_PILOT_SITE_ID,RELEASE_PILOT_SUPABASE,
  RELEASE_PILOT_URL,
} from "../provisioning/prepare-crm-release.mjs";

const root=fileURLToPath(new URL("../crm-runtime/",import.meta.url));
const publishableKey="sb_publishable_"+"a".repeat(40);
const args={
  sourceDir:root,siteId:RELEASE_PILOT_SITE_ID,siteUrl:RELEASE_PILOT_URL,
  projectUrl:RELEASE_PILOT_SUPABASE,publishableKey,
  approval:{
    approvalPhrase:"PREPARE ONE CRM TEST BUILD",
    separateDeploymentApprovalRequired:true,
    siteCreateAllowed:false,
    emailSendAllowed:false,
  },
};

// Read ZIP local and central directory by spec, independently from
// the implementation. Every entry must be STORE, CRC-covered and complete.
function readStoredZip(bytes){
  const b=Buffer.from(bytes);
  const end=b.length-22;
  assert.equal(b.readUInt32LE(end),0x06054b50,"valid end of central directory");
  const count=b.readUInt16LE(end+10),dirSize=b.readUInt32LE(end+12);
  const centralStart=b.readUInt32LE(end+16);
  assert.equal(centralStart+dirSize,end);
  let centralAt=centralStart;const names=new Set(),data=new Map();
  for(let i=0;i<count;i++){
    assert.equal(b.readUInt32LE(centralAt),0x02014b50);
    assert.equal(b.readUInt16LE(centralAt+10),0,"no compression");
    const size=b.readUInt32LE(centralAt+24);
    const nameLength=b.readUInt16LE(centralAt+28);
    const other=b.readUInt16LE(centralAt+30)+b.readUInt16LE(centralAt+32);
    const name=b.toString("utf8",centralAt+46,centralAt+46+nameLength);
    assert.equal(names.has(name),false,"no filename collisions");
    names.add(name);
    const localOffset=b.readUInt32LE(centralAt+42);
    assert.equal(b.readUInt32LE(localOffset),0x04034b50,"valid local file header");
    assert.equal(b.readUInt16LE(localOffset+8),0,"stored local entry");
    assert.equal(b.readUInt32LE(localOffset+18),size);
    const localLength=b.readUInt16LE(localOffset+26);
    const start=localOffset+30+localLength+b.readUInt16LE(localOffset+28);
    const value=b.subarray(start,start+size);
    assert.equal(value.length,size);
    assert.equal(b.readUInt32LE(localOffset+14),b.readUInt32LE(centralAt+16),"CRC32 matches both headers");
    data.set(name,value);
    centralAt+=46+nameLength+other;
  }
  assert.equal(centralAt,end);
  return data;
}

test("deterministic offline ZIP targets only the nine approved CRM files and public config",async()=>{
  const a=await buildOfflinePilotZip(args);
  const b=await buildOfflinePilotZip(args);
  assert.equal(a.fileCount,10);
  assert.equal(a.targetSiteId,RELEASE_PILOT_SITE_ID);
  assert.equal(a.targetUrl,RELEASE_PILOT_URL);
  assert.equal(a.deployAttempted,false);
  assert.equal(a.inviteSent,false);
  assert.equal(a.ownerCreated,false);
  assert.match(a.sourceHash,/^[a-f0-9]{64}$/);
  assert.match(a.archiveSha256,/^[a-f0-9]{64}$/);
  assert.ok(a.archiveSize>2000);
  assert.ok(a.archiveSize<3500000);
  assert.deepEqual(a.archive,b.archive,"same files produce same archive");
  const data=readStoredZip(a.archive);
  assert.equal(data.size,10);
  assert.deepEqual([...data.keys()].sort(),
    [...RELEASE_CONTENT,"tenant-config.json"].sort());
  const publicConfig=JSON.parse(data.get("tenant-config.json").toString("utf8"));
  assert.deepEqual(publicConfig,{
    projectUrl:RELEASE_PILOT_SUPABASE,
    siteUrl:RELEASE_PILOT_URL,publishableKey,
  });
  for (const filename of RELEASE_CONTENT){
    assert.deepEqual(data.get(filename),await readFile(new URL("../crm-runtime/"+filename,import.meta.url)));
  }
  assert.ok(data.get("index.html").toString("utf8").includes("./app.mjs"));
  assert.ok(data.get("_redirects").toString("utf8").includes("/auth/callback"));
  assert.doesNotMatch(JSON.stringify({
    target:a.targetUrl,sourceHash:a.sourceHash,archiveSha256:a.archiveSha256,
    zipSize:a.archiveSize,
  }),new RegExp(publishableKey));
});

test("wrong project/site, absent consent and privileged API credentials fail before reading files",async()=>{
  let reads=0;
  const fs={
    async readFile(){reads++;throw Error("Must not read source");},
    async lstat(){reads++;throw Error("Must not inspect source");},
  };
  const invalid=[
    {siteId:"c275509f-2fe2-4fb7-a797-39de7f2b22d4"},
    {projectUrl:"https://different.supabase.co"},
    {siteUrl:"https://klean.ly"},
    {publishableKey:"sb_secret_"+"a".repeat(40)},
    {publishableKey:"service_role"},
    {approval:null},
    {approval:{...args.approval,emailSendAllowed:true}},
    {approval:{...args.approval,siteCreateAllowed:true}},
    {approval:{...args.approval,approvalPhrase:"YES"}},
  ];
  for(const each of invalid){
    await assert.rejects(buildOfflinePilotZip({...args,...each,fs}),
      /crm_release_not_approved_or_wrong_target/);
  }
  assert.equal(reads,0);
});

test("no extra or duplicated file entries can enter archive",()=>{
  const rows=[...RELEASE_CONTENT,"tenant-config.json"].map(filename=>({
    filename,bytes:Buffer.from("demo"),
  }));
  assert.ok(encodePilotZip(rows).length>22);
  assert.throws(()=>encodePilotZip([...rows.slice(0,-1),
    {filename:"../secret",bytes:Buffer.from("bad")}]),/unsafe_entry/);
  assert.throws(()=>encodePilotZip([...rows.slice(0,-1),rows[0]]),/unsafe_entry/);
  assert.throws(()=>encodePilotZip(rows.slice(0,-1)),/incorrect_file_count/);
  assert.throws(()=>encodePilotZip([...rows.slice(0,-1),
    {filename:"tenant-config.json",bytes:Buffer.alloc(600001)}]),/invalid_size/);
});

test("ZIP code is isolated from all live Netlify deployment endpoints",async()=>{
  const file=await readFile(new URL("../provisioning/create-pilot-zip.mjs",import.meta.url),"utf8");
  assert.doesNotMatch(file,/\bfetch\s*\(|\bconsole\.log\s*\(|\binviteUserByEmail\s*\(/);
  assert.doesNotMatch(file,/\bservice_role\s*=\s*["']/);
  const netlify=await readFile(new URL("../netlify.toml",import.meta.url),"utf8");
  assert.match(netlify,/publish = "installer"/);
  assert.doesNotMatch(netlify,/publish = "crm-runtime"/);
});
