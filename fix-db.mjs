#!/usr/bin/env node
/**
 * fix-db.mjs - Corrige la BD de servers para que source/target esten bien asignados.
 *
 * Como: hostinger -> source (viejo), contabo -> target (nuevo)
 * Defaults: source=hostinger, target=contabo
 *
 * Uso:
 *   node fix-db.mjs
 *
 * Si tu archivo es diferente (distintos ids / labels / API keys), el script
 * los preserva y solo ajusta los campos problematicos (roles + defaults).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const DB_PATH = path.join(os.homedir(), ".migrate-dokploy", "db.json");

async function main() {
  let db;
  try {
    db = JSON.parse(await fs.readFile(DB_PATH, "utf8"));
  } catch {
    console.error(`No encontre ${DB_PATH}`);
    process.exit(1);
  }

  if (!db.servers || !Array.isArray(db.servers)) {
    console.error("db.json no tiene la estructura esperada (sin 'servers')");
    process.exit(1);
  }

  // Buscar heuristica: el server que tenga 'hostinger' o 'contabo' en su id/label
  const hostinger =
    db.servers.find((s) => /hostinger/i.test(s.id) || /hostinger/i.test(s.label));
  const contabo =
    db.servers.find((s) => /contabo/i.test(s.id) || /contabo/i.test(s.label));

  if (!hostinger || !contabo) {
    console.error(
      "No encontre servers 'hostinger' y 'contabo' en la BD. Edite el JSON a mano o use el CLI:"
    );
    console.error("  npm run servers -- edit <id>");
    process.exit(1);
  }

  hostinger.roles = ["source"];
  contabo.roles = ["target"];

  db.defaults = db.defaults || {};
  db.defaults.source = hostinger.id;
  db.defaults.target = contabo.id;

  // Permisos mode 0600 (solo el user puede leer/escribir)
  await fs.writeFile(DB_PATH, JSON.stringify(db, null, 2), { mode: 0o600 });
  console.log(`OK - BD corregida:`);
  console.log(`  ${hostinger.id}  -> role=source, default.source`);
  console.log(`  ${contabo.id}    -> role=target, default.target`);
  console.log(`  Path: ${DB_PATH}`);
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
