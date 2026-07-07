/**
 * Test del flujo extract + plan (sin tocar Dokploy ni SSH).
 * Recorre el bundle y muestra el plan de creacion per-servicio que hara
 * el restore engine en Dokploy Contabo.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { extractBundle, readEnvJson, type ManifestService } from "../lib/bundle.js";
import * as tar from "tar";

const plan: import("../lib/types.js").BackupPlan = {
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
  bundleName: "onefit-restore-test",
  generatedAt: new Date().toISOString(),
};

const tmpDir = path.join("./backups", "restore-test-staging");
await fs.rm(tmpDir, { recursive: true, force: true });
await fs.mkdir(tmpDir, { recursive: true });

const outDir = path.join(tmpDir, plan.bundleName);
await fs.mkdir(path.join(outDir, "services", "web"), { recursive: true });
await fs.mkdir(path.join(outDir, "services", "onefit-postgres"), { recursive: true });
await fs.writeFile(
  path.join(outDir, "manifest.json"),
  JSON.stringify({
    project: { id: plan.project.projectId, name: plan.project.name },
    generatedAt: plan.generatedAt,
    bundle: plan.bundleName,
    services: plan.services.map((s) => ({
      name: s.service.name,
      kind: s.service.kind,
      databaseType: s.service.databaseType ?? null,
      image: s.service.image ?? null,
      selection: s.selection,
    })),
    notes: [],
  }, null, 2)
);
await fs.writeFile(
  path.join(outDir, "services", "web", "env.json"),
  JSON.stringify(["NODE_ENV=production", "PORT=3000"])
);
await fs.writeFile(
  path.join(outDir, "services", "onefit-postgres", "env.json"),
  JSON.stringify({ POSTGRES_USER: "onefit", POSTGRES_DB: "onefit_prod" })
);
await fs.writeFile(
  path.join(outDir, "services", "onefit-postgres", "dump.sql.gz"),
  "-- mock sql --"
);

const tarPath = path.join("./backups", `${plan.bundleName}.tar.gz`);
await tar.c({ gzip: true, file: tarPath, cwd: tmpDir }, [plan.bundleName]);
console.log(`Bundle mock: ${tarPath} (${(await fs.stat(tarPath)).size} bytes)`);

console.log("\n--- Plan de restore per-servicio ---");
const bundle = await extractBundle(tarPath);
for (const svc of bundle.manifest.services as ManifestService[]) {
  const kind = svc.kind === "db" ? `db/${svc.databaseType ?? "?"}` : "application";
  console.log(`\n>> ${svc.name} -> ${kind}`);
  const envPath = bundle.paths.envByName[svc.name];
  if (envPath) {
    const env = await readEnvJson(envPath);
    console.log(`   env: ${JSON.stringify(env)}`);
  }
  if (bundle.paths.dumpByName[svc.name]) {
    console.log(`   dump.sql.gz: si -> se importara via docker exec`);
  }
  const vols = bundle.paths.volumesByName[svc.name] ?? [];
  if (vols.length) console.log(`   volumenes: ${vols.length}`);
  console.log(`   imagen: ${svc.image ?? "(default por tipo)"}`);
}

await fs.rm(tmpDir, { recursive: true, force: true });
await fs.unlink(tarPath).catch(() => {});
console.log("\nDev-restore-test completo.");
console.log("(Cada servicio del bundle se recrea como su propia unidad en Contabo)");
