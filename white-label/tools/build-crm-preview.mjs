// Stage the separately packaged CRM interface for visual review ONLY.
// The generated files are published under the INSTALLER's staging domain,
// never to the company's newly created Netlify CRM site.
// No OAuth grants or other environment variables are included.
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {auditPilotReleaseSource} from "../provisioning/audit-crm-release.mjs";

export const CRM_PREVIEW_ASSETS = Object.freeze([
  "index.html",
  "styles.css",
  "app.mjs",
  "deployment-manifest.json",
]);
const source = new URL("../crm-app/", import.meta.url);
const defaultDestination = new URL("../installer/crm-preview/", import.meta.url);

export async function buildCrmPreview(destination = defaultDestination) {
  const raw = await readFile(new URL("deployment-manifest.json", source), "utf8");
  const manifest = JSON.parse(raw);
  if (manifest.deployable !== false ||
      manifest.authenticationConfigured !== false ||
      manifest.databaseConnected !== false ||
      manifest.previewOnly !== true ||
      manifest.readsCustomerData !== false ||
      manifest.writesCustomerData !== false) {
    throw new Error("Refusing to publish a CRM prototype with unexpected security state");
  }
  if (manifest.includedFiles.length !== 5 ||
      !CRM_PREVIEW_ASSETS.every(name => manifest.includedFiles.includes(name))) {
    throw new Error("CRM preview asset list does not match the approved package");
  }
  await mkdir(destination, { recursive: true });
  for (const asset of CRM_PREVIEW_ASSETS) {
    await copyFile(new URL(asset, source), new URL(asset, destination));
  }
  return [...CRM_PREVIEW_ASSETS];
}

export async function buildCrmReleaseAudit(
  destination = new URL("../installer/crm-release-audit.json", import.meta.url)
) {
  // This publishes ONLY a static read-only source audit on the installer domain.
  // It contains no API credentials, CRM data, invitation or user records.
  const directory = fileURLToPath(new URL("../crm-runtime/", import.meta.url));
  const review = await auditPilotReleaseSource(directory);
  if (review.sourceValidated !== true ||
      review.noPublishableKeyBundled !== true ||
      review.noSecretKeysBundled !== true ||
      review.websiteDeployed !== false ||
      review.readyForSeparateDeploymentApproval !== false) {
    throw new Error("The isolated CRM release source audit did not pass");
  }
  await writeFile(destination, JSON.stringify(review, null, 2) + "\n", {
    encoding: "utf8",
  });
  return review;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  buildCrmPreview().then(async (files) => {
    const audit = await buildCrmReleaseAudit();
    console.log("Staged a STATIC, NO-LOGIN CRM preview on installer staging only: " +
      files.join(", "));
    console.log("Checked " + audit.filesChecked +
      " CRM source files. Read-only package fingerprint: " + audit.sourceHash);
    console.log("No customer CRM deploy, Supabase reads or provider writes were performed.");
  }).catch(error => {
    console.error("CRM preview packaging blocked: " + error.message);
    process.exitCode = 1;
  });
}
