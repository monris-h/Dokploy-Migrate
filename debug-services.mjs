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
  await probe("3) application.all SIN filtro", "/api/application.all");
  await probe("4) application.all CON filtro", `/api/application.all?projectId=${encodeURIComponent(projectId)}`);
  await probe("5) postgres.all CON filtro", `/api/postgres.all?projectId=${encodeURIComponent(projectId)}`);
  await probe("6) compose.all CON filtro", `/api/compose.all?projectId=${encodeURIComponent(projectId)}`);
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
