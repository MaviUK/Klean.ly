// Read-only CRM release source audit. Does not package, deploy, or request keys.
import {fileURLToPath} from "node:url";
import {auditPilotReleaseSource} from "../provisioning/audit-crm-release.mjs";

const root=fileURLToPath(new URL("../crm-runtime/",import.meta.url));
const result=await auditPilotReleaseSource(root);
process.stdout.write(JSON.stringify(result,null,2)+"\n");
