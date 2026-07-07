import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const DB = path.join(os.homedir(), ".migrate-dokploy", "db.json");
const db = JSON.parse(await fs.readFile(DB, "utf8"));
const t = db.servers.find((s) => s.id === "contabo");
const { url, apiKey } = t.dokploy;
const headers = { "x-api-key": apiKey, Accept: "application/json" };

console.log("Target:", url);

// Probar /api/project.all (lo que usa listProjects)
const r1 = await fetch(`${url.replace(/\/+$/, "")}/api/project.all`, { headers });
console.log(`\n[GET /api/project.all]`);
console.log(`Status: ${r1.status}`);
const t1 = await r1.text();
console.log(`Body (primeros 800 chars): ${t1.slice(0, 800)}`);

// Probar /api/trpc/project.all?batch=1
const r2 = await fetch(`${url.replace(/\/+$/, "")}/api/trpc/project.all?batch=1`, { headers });
console.log(`\n[GET /api/trpc/project.all?batch=1]`);
console.log(`Status: ${r2.status}`);
const t2 = await r2.text();
console.log(`Body (primeros 800 chars): ${t2.slice(0, 800)}`);

// Probar POST /api/project.create y ver QUÉ devuelve
console.log(`\n[POST /api/project.create] body={name:"DEBUG_DELETE_ME"}`);
const r3 = await fetch(`${url.replace(/\/+$/, "")}/api/project.create`, {
  method: "POST",
  headers: { ...headers, "Content-Type": "application/json" },
  body: JSON.stringify({ name: "DEBUG_DELETE_ME" }),
});
console.log(`Status: ${r3.status}`);
const t3 = await r3.text();
console.log(`Body: ${t3.slice(0, 1500)}`);