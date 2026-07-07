import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { pInput, pConfirm } from "../prompts.js";
import {
  loadDb,
  touchLastUsed,
  getServer,
} from "../db.js";
import { pickServer, offerAddServer, findArgServerId } from "../server-pick.js";
import { log } from "../ui.js";
import { Ssh } from "../ssh.js";
import { extractBundle } from "../../lib/bundle.js";
import { runRestore } from "../../lib/restore-engine.js";
import {
  parseDebugFlag,
  stripDebugFlag,
  setDebugMode,
  isAborted,
} from "../step.js";
import { BACKUPS_DIR } from "./backup.js";

/**
 * Flujo restore end-to-end contra Dokploy Contabo. Usa la BD multi-server
 * para resolver el target (o `--to <id>`). Ofrece wizard si no hay target.
 */

export type RestoreFlowOpts = {
  bundlePath?: string;
  projectName?: string;
  parseArgs?: string[];
};

export async function runRestoreFlow(opts: RestoreFlowOpts): Promise<void> {
  const args = opts.parseArgs ?? [];
  const debug = parseDebugFlag(args);
  setDebugMode(debug);
  const cleanArgs = stripDebugFlag(args);

  log.step(
    0,
    "migrate-dokploy - restore / import a Dokploy VPS Nuevo" +
      (debug ? "  [DEBUG paso a paso]" : "")
  );

  // 1) Bundle
  const bundlePath = opts.bundlePath
    ? path.resolve(opts.bundlePath)
    : await resolveBundleArg(opts.parseArgs ?? []);

  if (!(await fs.stat(bundlePath)).isFile()) {
    throw new Error(`No encuentro el bundle: ${bundlePath}`);
  }
  const bundleStat = await fs.stat(bundlePath);
  log.ok(`Bundle: ${bundlePath} (${humanBytes(bundleStat.size)})`);

  log.info("Extrayendo bundle y leyendo manifest...");
  const bundle = await extractBundle(bundlePath);
  log.ok(
    `Manifest: proyecto "${bundle.manifest.project.name}" - ${bundle.manifest.services.length} servicios`
  );
  for (const s of bundle.manifest.services) {
    const tag = s.kind === "db" ? `db/${s.databaseType ?? "?"}` : s.kind === "compose" ? "compose" : "app";
    process.stdout.write(`   - ${s.name} (${tag})\n`);
  }

  // 2) Server target
  log.step(1, "Seleccionando server de destino (VPS Nuevo)");
  let target = await pickServer(cleanArgs, "target");
  if (!target) {
    target = await offerAddServer("target");
    if (!target) throw new Error("Sin server target. Agrega uno: npm run servers -- add");
  }
  log.ok(`Target: ${target.id}  -  ${target.label}`);

  // 3) SSH connect (con retry si la key esta cifrada y falta passphrase)
  log.step(2, `Conexion SSH al VPS Nuevo  (${target.ssh.username}@${target.ssh.host}:${target.ssh.port ?? 22})`);
  let passwordSsh: string | undefined;
  let privateKeyPath = target.ssh.privateKeyPath;
  let passphrase = target.ssh.passphrase;

  if (privateKeyPath && !existsSync(privateKeyPath)) {
    log.warn(`La key ${privateKeyPath} no esta accesible. Se pedira password.`);
    privateKeyPath = undefined;
  }
  if (!privateKeyPath && !passphrase) {
    const { pPassword } = await import("../prompts.js");
    passwordSsh = await pPassword(
      `Password SSH para ${target.ssh.username}@${target.ssh.host}:`
    );
  }

  const sshTarget: {
    host: string;
    port: number;
    username: string;
    privateKeyPath?: string;
    password?: string;
    passphrase?: string;
  } = {
    host: target.ssh.host,
    port: target.ssh.port ?? 22,
    username: target.ssh.username,
    privateKeyPath,
    password: passwordSsh,
    passphrase,
  };

  const ssh = new Ssh(sshTarget);
  log.info(`Conectando a ${sshTarget.username}@${sshTarget.host}:${sshTarget.port}...`);

  let lastErr: string | undefined;
  try {
    await ssh.connect();
  } catch (e) {
    lastErr = (e as Error).message;
  }

  // Si fallo por passphrase cifrada y no tenemos una, pedirla y reintentar
  if (lastErr && /passphrase|Encrypted/i.test(lastErr) && !passphrase && privateKeyPath) {
    log.warn(`La key esta cifrada. Necesito la passphrase.`);
    const { pPassword, pConfirm } = await import("../prompts.js");
    passphrase = await pPassword("Passphrase de la key:");
    if (passphrase) {
      sshTarget.passphrase = passphrase;
      log.info(`Reintentando con passphrase...`);
      try {
        await ssh.connect();
        lastErr = undefined;
        // Ofrecer guardar la passphrase para no pedirla de nuevo
        const save = await pConfirm({
          message: `Conexion OK. Guardar la passphrase en este server (db.json)? Asi no te la pido cada vez.`,
          default: true,
        });
        if (save) {
          const { upsertServer } = await import("../db.js");
          await upsertServer({
            ...target,
            ssh: { ...target.ssh, passphrase },
          });
          log.ok(`Passphrase guardada para ${target.id}.`);
        }
      } catch (e2) {
        lastErr = (e2 as Error).message;
      }
    }
  }

  if (lastErr) {
    throw new Error(`Conexion SSH fallo: ${lastErr}`);
  }
  log.ok("Conexion SSH establecida.");
  const v = await ssh.exec("docker --version");
  if (v.code !== 0) {
    throw new Error(`VPS Contabo no responde a docker (code ${v.code}).`);
  }
  log.out(`VPS Nuevo: ${(v.stdout || "").trim()}`);

  const proceed = await pConfirm({
    message: `Crear el proyecto "${bundle.manifest.project.name}" en VPS Nuevo (${target.label}) y restaurar ${bundle.manifest.services.length} servicios?`,
    default: false,
  });
  if (!proceed) {
    await ssh.disconnect();
    log.warn("Cancelado por el usuario. No se aplico nada.");
    return;
  }

  const conn = { url: target.dokploy.url, apiKey: target.dokploy.apiKey };
  try {
    await runRestore({
      conn,
      ssh,
      bundle,
      tarGzPath: bundlePath,
      waitForRunningSec: 60,
    });
  } catch (e) {
    if (isAborted(e)) {
      log.warn(`Restore abortado: ${(e as Error).message}`);
    } else {
      throw e;
    }
  } finally {
    await ssh.disconnect();
  }
  await touchLastUsed(target.id);

  log.step(99, "Listo");
  log.out("Abre el panel de Dokploy del VPS Nuevo para verificar.");
  log.out("Recordatorio READ-ONLY: nada en el VPS Viejo fue modificado.");
  setDebugMode(false);
}

// --------- CLI entry ---------

export async function runRestore(args: string[]): Promise<void> {
  await runRestoreFlow({ parseArgs: args });
}

// --------- helpers ---------

async function resolveBundleArg(args: string[]): Promise<string> {
  let bundlePath = "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--file" || a === "-f") {
      bundlePath = args[++i] ?? "";
    } else if (a.startsWith("--file=")) {
      bundlePath = a.slice("--file=".length);
    } else if (!bundlePath && /\.tar\.gz$/i.test(a)) {
      bundlePath = a;
    }
  }
  if (bundlePath) return path.resolve(bundlePath);

  const dir = BACKUPS_DIR;
  const list = await fs
    .readdir(dir)
    .catch(() => [])
    .then((arr) => arr.filter((e) => e.endsWith(".tar.gz")).sort());
  let chosen = "";
  if (list.length === 0) {
    chosen = await pInput({
      message: "Ruta al bundle .tar.gz:",
      validate: (v) => (v ? true : "Obligatorio"),
    });
  } else if (list.length === 1) {
    chosen = path.join(dir, list[0]);
    process.stdout.write(`Bundle detectado: ${chosen}\n`);
  } else {
    const picked = await pInput({
      message: `Hay ${list.length} bundles en ./backups. Nombre exacto o ruta:`,
      default: list[list.length - 1],
    });
    chosen = picked.includes("/") ? picked : path.join(dir, picked);
  }
  return path.resolve(chosen);
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let i = -1;
  let v = n;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(1)} ${units[i]}`;
}

// helper silencioso del lint
void loadDb;
void getServer;
void findArgServerId;
