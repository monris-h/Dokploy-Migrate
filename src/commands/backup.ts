import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { checkbox } from "@inquirer/prompts";
import chalk from "chalk";
import {
  pConfirm,
  pSelect,
} from "../prompts.js";
import {
  loadDb,
  upsertServer,
  touchLastUsed,
} from "../db.js";
import {
  pickServer,
  offerAddServer,
  ensureDistinctServers,
} from "../server-pick.js";
import { listProjects, listServices } from "../../lib/dokploy.js";
import { generateBackupScript } from "../../lib/backup-generator.js";
import { Ssh } from "../ssh.js";
import { log } from "../ui.js";
import { renderProjectsList } from "../ui-render.js";
import { runRestoreFlow } from "./restore.js";
import {
  confirmStep,
  parseDebugFlag,
  stripDebugFlag,
  setDebugMode,
  isAborted,
  type StepContext,
} from "../step.js";
import type {
  BackupPlan,
  BackupSelection,
  ProjectSummary,
  ServiceBackupPlan,
  ServiceSummary,
  Server,
} from "../../lib/types.js";

const REMOTE_TMP = "/tmp";

/**
 * Flags:
 *   --from <id>        server source
 *   --auto-select      marca todo por servicio
 *   --auto-import      si target listo, importa al final sin preguntar
 *   --yes              --auto-select + --auto-import
 *   --debug            modo paso a paso con confirmacion
 */
export async function runBackup(args: string[]): Promise<void> {
  const debug = parseDebugFlag(args);
  setDebugMode(debug);
  const cleanArgs = stripDebugFlag(args);

  const flags = parseFlags(cleanArgs);
  log.step(
    0,
    "migrate-dokploy - backup por proyecto (READ-ONLY)" +
      (debug ? "  [DEBUG paso a paso]" : flags.yes ? "  [MIGRATE]" : "")
  );

  // 1. Resolver server source
  log.step(1, "Seleccionando server de origen (VPS Viejo)");
  let source = await pickServer(cleanArgs, "source");
  if (!source) {
    source = await offerAddServer("source");
    if (!source) throw new Error("Sin server source. Agrega uno: npm run servers -- add");
  }
  log.ok(`Source: ${source.id}  -  ${source.label}  (${source.dokploy.url})`);

  // 1b. Resolver server target (para mostrar el plan completo)
  //    No lo exigimos aqui, pero al menos informamos si existe.
  const { getDefaultFor } = await import("../db.js");
  const targetDefault = await getDefaultFor("target");
  if (targetDefault) {
    log.ok(`Target: ${targetDefault.id}  -  ${targetDefault.label}  (${targetDefault.dokploy.url})`);
    if (targetDefault.id === source.id) {
      log.err(
        `  ADVERTENCIA: source y target son el mismo server (${source.id}).`
      );
      log.err(
        `  Para importar a otro VPS, registra el segundo server:  npm run servers -- add`
      );
      log.err(
        `  Y marcalo como "target" en su rol. Despues corre:  npm run servers -- default target <id>`
      );
    }
  } else {
    log.warn(
      `No hay target configurado. El bundle quedara en ./backups/ sin importar automaticamente.`
    );
    log.out(
      `  Para configurar target:  npm run servers -- add  (marca como "target")`
    );
  }

  // 1c. Confirmar el plan antes de seguir
  const continueOk = await pConfirm({
    message: targetDefault && targetDefault.id !== source.id
      ? `Continuar: source=${source.id} -> bundle -> target=${targetDefault.id}?`
      : `Continuar con backup desde ${source.id}? (sin auto-import)`,
    default: true,
  });
  if (!continueOk) {
    throw new Error("Cancelado por el usuario.");
  }

  ensureDistinctServers(source, targetDefault ?? null);

  const conn = { url: source.dokploy.url, apiKey: source.dokploy.apiKey };

  log.info("Listando proyectos del VPS Viejo...");
  const projects = await listProjects(conn);
  if (projects.length === 0) {
    throw new Error("No hay proyectos en este Dokploy.");
  }
  log.ok(`${projects.length} proyectos encontrados.`);
  process.stdout.write(renderProjectsList(projects) + "\n");

  const project: ProjectSummary = await pSelect<ProjectSummary>({
    message: "Proyecto a respaldar:",
    choices: projects.map((p) => ({
      name: p.description ? `${p.name}  -  ${p.description}` : p.name,
      value: p,
    })),
    pageSize: 15,
  });

  // 2. Servicios del proyecto
  log.step(2, `Servicios del proyecto "${project.name}"`);
  const services: ServiceSummary[] = await listServices(conn, project.projectId);
  if (services.length === 0) {
    throw new Error(`El proyecto ${project.name} no tiene servicios exposables via API.`);
  }
  log.ok(`${services.length} servicios encontrados:`);
  const order = (k: ServiceSummary["kind"]): number =>
    k === "app" ? 0 : k === "db" ? 1 : k === "compose" ? 2 : 3;
  const sorted = [...services].sort(
    (a, b) => order(a.kind) - order(b.kind) || a.name.localeCompare(b.name)
  );
  for (const s of sorted) {
    const tag =
      s.kind === "db"
        ? `db/${s.databaseType ?? "?"}`
        : s.kind === "compose"
          ? "compose"
          : "app";
    const dot = s.status === "running" ? "o" : ".";
    process.stdout.write(
      `   ${dot} ${s.name.padEnd(28)}  [${tag}]${s.image ? `  ${s.image}` : ""}\n`
    );
  }

  // 3. Seleccion per-servicio
  const servicePlans: ServiceBackupPlan[] = [];
  const selectAll = flags.autoSelect
    ? true
    : await pConfirm({
        message: "Marcar todos los servicios para backup completo?",
        default: true,
      });

  const defaultsAll: BackupSelection = {
    compose: true,
    env: true,
    volumes: true,
    database: true,
  };

  for (const s of services) {
    if (selectAll) {
      servicePlans.push({ service: s, selection: { ...defaultsAll } });
      continue;
    }
    const opts: BackupSelection = {
      compose: false,
      env: false,
      volumes: false,
      database: false,
    };
    const choices: { name: string; value: keyof BackupSelection; checked?: boolean }[] = [
      { name: "Definicion / compose del servicio", value: "compose", checked: true },
      { name: "Variables de entorno (.env)", value: "env", checked: true },
      { name: "Volumenes (datos persistentes)", value: "volumes", checked: true },
    ];
    if (s.kind === "db") {
      choices.push({
        name: `Dump completo de ${s.databaseType ?? "la BD"}`,
        value: "database",
        checked: true,
      });
    }
    const picked = await checkboxService(s, choices);
    for (const k of picked) opts[k] = true;
    if (Object.values(opts).some(Boolean)) {
      servicePlans.push({ service: s, selection: opts });
    }
  }

  // 4. SSH source
  log.step(3, `Conexion SSH al VPS Viejo  (${source.ssh.username}@${source.ssh.host}:${source.ssh.port ?? 22})`);
  let passwordSsh: string | undefined;
  let privateKeyPath = source.ssh.privateKeyPath;
  if (privateKeyPath && !existsSync(privateKeyPath)) {
    log.warn(`La key ${privateKeyPath} no esta accesible. Se pedira password.`);
    privateKeyPath = undefined;
  }
  if (!privateKeyPath) {
    const { pPassword } = await import("../prompts.js");
    passwordSsh = await pPassword(
      `Password SSH para ${source.ssh.username}@${source.ssh.host}:`
    );
  }
  const sshTarget = {
    host: source.ssh.host,
    port: source.ssh.port ?? 22,
    username: source.ssh.username,
    privateKeyPath,
    passphrase: source.ssh.passphrase,
    password: passwordSsh,
  };

  const ssh = new Ssh(sshTarget);
  log.info(`Conectando a ${sshTarget.username}@${sshTarget.host}:${sshTarget.port}...`);
  await ssh.connect();
  log.ok("Conexion SSH establecida.");
  const v = await ssh.exec("docker --version");
  if (v.code !== 0) {
    throw new Error(`VPS no responde a 'docker --version' (code ${v.code}).`);
  }
  log.out(`VPS: ${(v.stdout || "").trim()}`);

  // 5. Generar y enviar script
  log.step(4, "Generando script de backup");
  const ts = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
  const bundleName = `${slugify(project.name)}-backup-${ts}`;
  const plan: BackupPlan = {
    project,
    services: servicePlans,
    bundleName,
    generatedAt: new Date().toISOString(),
  };
  const script = generateBackupScript(plan);
  const localScript = path.join("./backups", `${bundleName}.sh`);
  await fs.mkdir(path.dirname(localScript), { recursive: true });
  await fs.writeFile(localScript, script, { mode: 0o600 });
  log.ok(`Script local: ${localScript}`);

  // --debug: mostrar preview del script
  if (debug) {
    process.stdout.write(
      `\n--- Preview del script (primeras 30 lineas) ---\n` +
        script.split("\n").slice(0, 30).join("\n") +
        "\n--- fin preview ---\n"
    );
  }

  const remoteScript = `${REMOTE_TMP}/${bundleName}.sh`;
  const stepPlanUpload: StepContext = {
    title: "Subir script al VPS",
    plan: [
      `Origen:  ${localScript}`,
      `Destino: ${sshTarget.username}@${sshTarget.host}:${remoteScript}`,
      `Tamano:  ${(await fs.stat(localScript)).size} bytes`,
    ],
  };
  await confirmStep(stepPlanUpload, async () => {
    log.info(`Subiendo script -> ${remoteScript}`);
    await ssh.uploadFile(localScript, remoteScript);
    await ssh.exec(`chmod +x ${remoteScript}`);
  });

  // 6. Ejecutar en VPS
  const stepPlanRun: StepContext = {
    title: "Ejecutar backup en el VPS (read-only sobre Dokploy)",
    plan: [
      `Comando:   bash ${remoteScript}`,
      `Accion:   pg_dumpall, copia de volumenes, .env, compose, etc.`,
      `Tiempo:   puede tardar minutos (depende del tamano de la BD/volumenes)`,
      `Seguro:   el script NO modifica Dokploy, ni servicios, ni containers.`,
    ],
  };
  await confirmStep(stepPlanRun, async () => {
    log.step(5, "Ejecutando backup en el VPS Viejo");
    const run = await ssh.exec(`REMOTE_TMP=${REMOTE_TMP} bash ${remoteScript}`, {
      onStdout: (chunk: Buffer) => process.stdout.write(`   ${chunk.toString()}`),
      onStderr: (chunk: Buffer) => process.stderr.write(`   ${chunk.toString()}`),
    });
    if (run.code !== 0) {
      log.err(`El script termino con codigo ${run.code}.`);
      const want = await pConfirm({
        message: "Descargar el bundle de todos modos?",
        default: false,
      });
      if (!want) {
        await ssh.disconnect();
        throw new Error("Backup fallo y abortaste la descarga.");
      }
    }
  });

  const remoteBundle = `${REMOTE_TMP}/${bundleName}.tar.gz`;
  const size = await ssh.fileSize(remoteBundle);
  if (size <= 0) {
    await ssh.disconnect();
    throw new Error(`No se genero ${remoteBundle} en el VPS.`);
  }
  log.ok(`Bundle remoto listo: ${remoteBundle} (${humanBytes(size)})`);

  // 7. SCP pull local
  const stepPlanDownload: StepContext = {
    title: "Descargar bundle a tu PC",
    plan: [
      `Origen:  ${sshTarget.username}@${sshTarget.host}:${remoteBundle}`,
      `Destino: ${path.join("./backups", `${bundleName}.tar.gz`)}`,
      `Tamano:  ${humanBytes(size)}`,
    ],
  };
  let localBundle = path.join("./backups", `${bundleName}.tar.gz`);
  await confirmStep(stepPlanDownload, async () => {
    log.step(6, "Bajando backup a tu PC");
    localBundle = path.join("./backups", `${bundleName}.tar.gz`);
    await ssh.downloadFile(remoteBundle, localBundle);
    const stat = await fs.stat(localBundle);
    log.ok(`Bundle en tu PC: ${localBundle} (${humanBytes(stat.size)})`);
  });

  await ssh.disconnect();
  await touchLastUsed(source.id);

  log.step(7, "Backup completo (READ-ONLY sobre el VPS Viejo)");
  log.out(
    `En el VPS Viejo quedaron: ${remoteScript} y ${remoteBundle} (sin borrar).`
  );

  // 8. Importar al target?
  let wantRestore = false;
  if (flags.autoImport) {
    if (targetDefault && targetDefault.id !== source.id) {
      log.out(`[auto-import] Default target: ${targetDefault.id}  -  ${targetDefault.label}`);
      wantRestore = true;
    } else {
      wantRestore = await pConfirm({
        message: "Quieres importar este bundle a un VPS Nuevo ahora?",
        default: true,
      });
    }
  } else {
    wantRestore = await pConfirm({
      message: "Quieres importar este bundle a un VPS Nuevo ahora?",
      default: false,
    });
  }

  if (wantRestore) {
    try {
      await runRestoreFlow({ bundlePath: localBundle, projectName: project.name });
    } catch (e) {
      if (isAborted(e)) {
        log.warn(`Restore abortado: ${(e as Error).message}`);
      } else {
        throw e;
      }
    }
  } else {
    log.out(
      `Para importar despues:  npm run restore -- --file "${localBundle}"`
    );
  }
  setDebugMode(false);
}

function parseFlags(args: string[]): {
  autoSelect: boolean;
  autoImport: boolean;
  yes: boolean;
} {
  const out = { autoSelect: false, autoImport: false, yes: false };
  for (const a of args) {
    if (a === "--auto-select") out.autoSelect = true;
    else if (a === "--auto-import") out.autoImport = true;
    else if (a === "--yes" || a === "-y") {
      out.yes = true;
      out.autoSelect = true;
      out.autoImport = true;
    }
  }
  return out;
}

async function checkboxService(
  s: ServiceSummary,
  choices: { name: string; value: keyof BackupSelection; checked?: boolean }[]
): Promise<Array<keyof BackupSelection>> {
  const picked = await checkbox<keyof BackupSelection>({
    message: `Que respaldar de "${s.name}"${
      s.kind === "db" ? ` (db/${s.databaseType ?? "?"})` : ""
    }?`,
    choices,
  });
  return picked;
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "project"
  );
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
