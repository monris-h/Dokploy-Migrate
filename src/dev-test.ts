/**
 * Test rapido: genera un script de backup con datos mock de OneFit y lo
 * guarda en ./backups/test-onefit.sh. No toca Dokploy ni SSH.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { generateBackupScript } from "../lib/backup-generator.js";
import type { BackupPlan } from "../lib/types.js";

const plan: BackupPlan = {
  project: { projectId: "onefit-prod-xyz", name: "OneFit" },
  services: [
    {
      service: {
        id: "web-svc-1",
        name: "web",
        kind: "app",
        status: "running",
        image: "ghcr.io/onefit/web:latest",
      },
      selection: { compose: true, env: true, volumes: true, database: false },
    },
    {
      service: {
        id: "pg-svc-1",
        name: "onefit-postgres",
        kind: "db",
        databaseType: "postgres",
        status: "running",
        image: "postgres:18",
      },
      selection: { compose: true, env: true, volumes: true, database: true },
    },
  ],
  bundleName: "onefit-test",
  generatedAt: new Date().toISOString(),
};

const script = generateBackupScript(plan);
const out = path.join("./backups", "test-onefit.sh");
await fs.mkdir(path.dirname(out), { recursive: true });
await fs.writeFile(out, script, { mode: 0o755 });
console.log(`Script escrito en: ${out} (${script.length} bytes)`);
