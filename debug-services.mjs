/**
 * debug-services.mjs - Diagnostica porque listServices devuelve 0.
 *
 * Uso:
 *   node debug-services.mjs <projectId>
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const DB_PATH = path.join(os.homedir(), ".migrate-dokploy", "db.json");

async function main() {
  const db = JSON.parse(await fs.readFile(DB_PATH, "utf8"));
  const source = db.servers.find((s) => s.id === db.defaults.source) || db.servers[0];
  if (!source) {
    console.error("No hay server source en la BD");
    process.exit(1);
  }
  const { url, apiKey } = source.dokploy;
  const headers = { "x-api-key": apiKey, Accept: "application/json" };

  // Auto-detectar el projectId: si pasan uno como arg, usarlo;
  // si no, listar todos los proyectos y buscar uno llamado OneFit.
  let projectId = process.argv[2];
  if (!projectId) {
    console.log(`Source: ${source.id} - ${source.label} (${url})`);
    console.log(`\n[auto-detect] Listando proyectos para encontrar OneFit...`);
    try {
      const r = await fetch(`${url.replace(/\/+$/, "")}/api/project.all`, { headers });
      const projects = await r.json();
      const arr = Array.isArray(projects) ? projects : (projects.data || []);
      console.log(`  ${arr.length} proyectos encontrados:`);
      for (const p of arr.slice(0, 10)) {
        console.log(`    - id=${p.projectId}  name=${p.name}`);
      }
      const onefit = arr.find(
        (p) => p.name === "OneFit" || /onefit/i.test(p.name)
      );
      if (!onefit) {
        console.log(`\nNo encontre OneFit. Pasame el projectId a mano:`);
        console.log(`  node debug-services.mjs <projectId>`);
        process.exit(1);
      }
      projectId = onefit.projectId;
      console.log(`\n  OneFit encontrado: projectId=${projectId}`);
    } catch (e) {
      console.error(`Error listando proyectos: ${e.message}`);
      process.exit(1);
    }
  }

  console.log(`\nProjectId a buscar: ${projectId}\n`);

  async function probe(label, p) {
    const fullUrl = `${url.replace(/\/+$/, "")}${p}`;
    process.stdout.write(`[${label}]\n  GET ${fullUrl}\n`);
    try {
      const r = await fetch(fullUrl, { headers });
      const text = await r.text();
      process.stdout.write(`  Status: ${r.status}\n`);
      try {
        const data = JSON.parse(text);
        const arr = Array.isArray(data) ? data : (data.data || data.result || [data]);
        process.stdout.write(`  Items: ${arr.length}\n`);
        if (arr.length > 0) {
          process.stdout.write(`  Primer item (claves): ${Object.keys(arr[0]).slice(0, 10).join(", ")}\n`);
          for (const item of arr.slice(0, 5)) {
            const pid = item.projectId || item.ProjectId || item.projectID;
            const name = item.name || item.appName;
            process.stdout.write(`    - name=${name}  projectId=${pid}\n`);
          }
        }
      } catch (e) {
        process.stdout.write(`  No-JSON response (${text.length} chars): ${text.slice(0, 200)}\n`);
      }
    } catch (e) {
      process.stdout.write(`  Error: ${e.message}\n`);
    }
    process.stdout.write("\n");
  }

  await probe("1) Lista TODOS los proyectos", "/api/project.all");
  await probe("2) Detalle del projectId", `/api/project.one?projectId=${encodeURIComponent(projectId)}`);

  // Dump estructura completa del project.one para entender la forma
  console.log(`[2b] Estructura COMPLETA del project.one (solo envs y services):`);
  try {
    const r = await fetch(`${url.replace(/\/+$/, "")}/api/project.one?projectId=${encodeURIComponent(projectId)}`, { headers });
    const data = await r.json();
    const envs = data.environments || [];
    console.log(`  ${envs.length} environments. Claves top-level del proyecto: ${Object.keys(data).join(", ")}`);
    for (const env of envs) {
      const keys = Object.keys(env).filter((k) => {
        const v = env[k];
        return Array.isArray(v) || typeof v === "object";
      });
      console.log(`  env ${env.environmentId} name=${env.name} - claves con datos: ${keys.join(", ")}`);
      for (const k of keys) {
        const v = env[k];
        if (Array.isArray(v)) {
          console.log(`    ${k}: array[${v.length}] - ejemplos: ${v.slice(0, 2).map((x) => `${x.name || x.appName || "?"}(${Object.keys(x).slice(0,5).join(",")})`).join(" | ")}`);
        }
      }
    }
  } catch (e) {
    console.log(`  Error: ${e.message}`);
  }
  console.log("");

  await probe("3) application.all SIN filtro", "/api/application.all");
  await probe("4) application.all CON projectId", `/api/application.all?projectId=${encodeURIComponent(projectId)}`);
  await probe("5) application.all CON environmentId", `/api/application.all?environmentId=NCne7bMSIzrDySX71zGsT`);
  await probe("6) postgres.all CON projectId", `/api/postgres.all?projectId=${encodeURIComponent(projectId)}`);
  await probe("7) compose.all CON projectId", `/api/compose.all?projectId=${encodeURIComponent(projectId)}`);
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
