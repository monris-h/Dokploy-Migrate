import path from "node:path";
import type { Ssh } from "../src/ssh.js";
import {
  dokployCreateProject,
  dokployCreateApplication,
  dokployDeployApplication,
  dokployCreatePostgres,
  dokployDeployPostgres,
  dokployCreateMysql,
  dokployDeployMysql,
  dokployCreateMariadb,
  dokployDeployMariadb,
  dokployCreateMongo,
  dokployDeployMongo,
  dokployCreateRedis,
  dokployDeployRedis,
} from "./dokploy.js";
import {
  readEnvJson,
  type ExtractedBundle,
  type ManifestService,
} from "./bundle.js";
import type { Connection } from "./types.js";
import { log } from "../src/ui.js";
import { confirmStep, isAborted, type StepContext } from "../src/step.js";

/**
 * Motor de restore per-servicio: cada item del bundle se recrea como su propia
 * unidad administrable en Dokploy Contabo (application, postgres, mysql, etc.).
 *
 * Modo debug (--debug o via TUI): cada operacion mayor se muestra con su plan
 * y se pide confirmacion explicita antes de ejecutarla. Los servicios marcados
 * como skip no se recrean.
 */

export type RestoreOptions = {
  conn: Connection;
  ssh: Ssh;
  bundle: ExtractedBundle;
  tarGzPath: string;
  waitForRunningSec?: number;
  /** Si true, el caller ya encadeno; aqui solo manejamos errores. */
  catchesAbort?: boolean;
};

export type RestoreResult = {
  projectId: string;
  serviceResults: Record<string, { id: string; container?: string; skipped?: boolean }>;
};

export async function runRestore(opts: RestoreOptions): Promise<RestoreResult> {
  const { conn, ssh, bundle, tarGzPath } = opts;
  const { manifest } = bundle;

  // Validaciones tempranas para fallar con mensajes utiles en vez de errores raros
  if (!manifest?.services || !Array.isArray(manifest.services)) {
    throw new Error(`Manifest invalido: 'services' no es un array.`);
  }
  if (!manifest?.project?.name) {
    throw new Error(`Manifest invalido: falta 'project.name'.`);
  }
  for (const [i, svc] of manifest.services.entries()) {
    if (!svc || typeof svc !== "object") {
      throw new Error(`Manifest invalido: services[${i}] no es un objeto.`);
    }
    if (!svc.name || typeof svc.name !== "string") {
      throw new Error(`Manifest invalido: services[${i}].name falta o no es string.`);
    }
    if (!svc.kind) {
      throw new Error(`Manifest invalido: services[${i}].kind falta.`);
    }
  }

  const projectName = sanitizeProjectName(manifest.project.name);
  const wait = (opts.waitForRunningSec ?? 30) * 1000;

  log.out(`[debug-trace] runRestore start. services=${manifest.services.length}`);
  log.out(`[debug-trace] manifest.services=${JSON.stringify(manifest.services.map((s: ManifestService) => ({ name: s.name, kind: s.kind, db: s.databaseType })))}`);

  log.step(0, `Creando proyecto en Dokploy: ${projectName}`);

  // 1) Crear proyecto
  log.out(`[debug-trace] Llamando dokployCreateProject...`);
  let projectId: string;
  try {
    projectId = await dokployCreateProject(conn, { name: projectName });
    log.ok(`Proyecto creado: ${projectId}`);
    log.out(`[debug-trace] dokployCreateProject OK. projectId=${projectId}`);
  } catch (e) {
    throw new Error(
      `No pude crear el proyecto en Dokploy: ${(e as Error).message}`
    );
  }

  // 2) Subir bundle al Contabo
  log.step(1, "Subiendo bundle al Contabo");
  log.out(`[debug-trace] remoteTmp=${`/tmp/restore-${bundle.bundleDir}`}`);
  const remoteTmp = `/tmp/restore-${bundle.bundleDir}`;
  await ssh.exec(`rm -rf ${remoteTmp} && mkdir -p ${remoteTmp}`);
  const remoteBundleTar = `${remoteTmp}/bundle.tar.gz`;
  log.out(`[debug-trace] Subiendo bundle al Contabo...`);
  await ssh.uploadFile(tarGzPath, remoteBundleTar);
  log.out(`[debug-trace] Bundle subido. Extrayendo en Contabo...`);
  await ssh.exec(
    `mkdir -p ${remoteTmp}/x && tar -xzf ${remoteBundleTar} -C ${remoteTmp}/x`
  );
  log.ok(`Bundle disponible en ${remoteTmp}/x/${bundle.bundleDir}`);

  log.step(2, "Creando servicios uno por uno (cada uno como su propia unidad)");
  const serviceResults: RestoreResult["serviceResults"] = {};

  for (let i = 0; i < manifest.services.length; i++) {
    const svc = manifest.services[i];
    const stepNo = i + 1;
    log.out(`[debug-trace] Servicio ${stepNo}/${manifest.services.length}: ${svc.name} (${svc.kind})`);
    try {
      const result = await createAndProvisionService({
        conn,
        ssh,
        svc,
        projectId,
        bundle,
        remoteTmp,
        wait,
        step: { n: stepNo, total: manifest.services.length },
      });
      serviceResults[svc.name] = result;
    } catch (e) {
      if (isAborted(e)) throw e;
      log.err(`Error creando servicio ${svc.name}: ${(e as Error).message}`);
      serviceResults[svc.name] = { id: "", skipped: true };
    }
  }

  log.step(99, "Restauracion completa");
  log.out(`Proyecto: ${projectName}`);
  log.out(`Servicios restaurados: ${Object.keys(serviceResults).length}`);
  for (const [name, info] of Object.entries(serviceResults)) {
    if (info.skipped) {
      log.out(`  - ${name}  (saltado)`);
    } else {
      log.out(
        `  - ${name}  (id: ${info.id}${info.container ? `, container: ${info.container}` : ""})`
      );
    }
  }

  return { projectId, serviceResults };
}

// ---------------------------------------------------------------------------

type Ctx = {
  conn: Connection;
  ssh: Ssh;
  svc: ManifestService;
  projectId: string;
  bundle: ExtractedBundle;
  remoteTmp: string;
  wait: number;
  step: { n: number; total: number };
};

async function createAndProvisionService(ctx: Ctx) {
  const { conn, ssh, svc, projectId, bundle, remoteTmp, wait, step } = ctx;
  const out: { id: string; container?: string; skipped?: boolean } = { id: "" };

  const envPath = bundle.paths.envByName[svc.name];
  const envVars = envPath ? await readEnvJson(envPath) : {};
  const image = svc.image ?? defaultImage(svc);

  const planLines: string[] = [
    `Tipo:    ${svc.kind === "db" ? `db/${svc.databaseType ?? "?"}` : svc.kind === "compose" ? "compose" : "application"}`,
    `Nombre:  ${svc.name}`,
    `Imagen:  ${image}`,
    `Env:     ${Object.keys(envVars).length} variable(s) ${Object.keys(envVars).length === 0 ? "(ninguna)" : "(" + Object.keys(envVars).join(", ") + ")"}`,
  ];
  if (svc.kind === "db") {
    planLines.push(`Dump SQL: ${bundle.paths.dumpByName[svc.name] ? "si, se importara" : "no"}`);
  }
  if (bundle.paths.volumesByName[svc.name]?.length) {
    planLines.push(
      `Volumenes: ${bundle.paths.volumesByName[svc.name].length} archivo(s) tar.gz`
    );
  }
  if (bundle.paths.composeByName[svc.name]) {
    planLines.push(`Compose original: presente en bundle`);
  }

  const stepCtx: StepContext = {
    title: `Crear servicio "${svc.name}" en Dokploy`,
    index: step,
    plan: planLines,
    optional: true,
    onSkip: () => {
      out.skipped = true;
    },
  };

  let deployFn: () => Promise<void> = async () => {};

  await confirmStep(stepCtx, async () => {
    log.out(`(${slugify(svc.name)}) tipo=${svc.kind}${svc.databaseType ? `/${svc.databaseType}` : ""}`);

    switch (svc.kind) {
      case "app": {
        const id = await dokployCreateApplication(conn, {
          projectId,
          name: svc.name,
          image,
          env: envVars,
        });
        out.id = id;
        log.ok(`  application creada: ${id}`);
        deployFn = () => dokployDeployApplication(conn, id);
        break;
      }
      case "db": {
        switch (svc.databaseType) {
          case "postgres":
            out.id = await dokployCreatePostgres(conn, {
              projectId,
              name: svc.name,
              image,
              env: envVars,
            });
            deployFn = () => dokployDeployPostgres(conn, out.id);
            break;
          case "mysql":
            out.id = await dokployCreateMysql(conn, {
              projectId,
              name: svc.name,
              image,
              env: envVars,
            });
            deployFn = () => dokployDeployMysql(conn, out.id);
            break;
          case "mariadb":
            out.id = await dokployCreateMariadb(conn, {
              projectId,
              name: svc.name,
              image,
              env: envVars,
            });
            deployFn = () => dokployDeployMariadb(conn, out.id);
            break;
          case "mongo":
            out.id = await dokployCreateMongo(conn, {
              projectId,
              name: svc.name,
              image,
              env: envVars,
            });
            deployFn = () => dokployDeployMongo(conn, out.id);
            break;
          case "redis":
            out.id = await dokployCreateRedis(conn, {
              projectId,
              name: svc.name,
              image,
              env: envVars,
            });
            deployFn = () => dokployDeployRedis(conn, out.id);
            break;
          default:
            throw new Error(
              `Tipo de BD desconocido para el servicio ${svc.name}: ${svc.databaseType}`
            );
        }
        log.ok(`  ${svc.databaseType} creado: ${out.id}`);
        break;
      }
      default:
        log.warn(`  (${svc.name}) kind=${svc.kind} no soportado en restore, saltando creacion.`);
        out.skipped = true;
        return;
    }
  });

  if (out.skipped) return out;

  // 4) Disparar deploy
  const stepDeploy: StepContext = {
    title: `Disparar deploy de "${svc.name}"`,
    index: step,
    plan: [
      `Servicio: ${svc.name}  (id: ${out.id})`,
      `Tipo:     ${svc.kind === "db" ? svc.databaseType : "application"}`,
      `Accion:   Dokploy baja la imagen y arranca el container`,
    ],
  };
  await confirmStep(stepDeploy, async () => {
    try {
      await deployFn();
      log.ok(`  deploy disparado`);
    } catch (e) {
      log.warn(`  No se pudo disparar el deploy via API (${(e as Error).message}); continuamos.`);
    }
  });

  // 5) Esperar al container
  const projectContainerPrefix = `${projectId}-`;
  const slug = slugify(svc.name);
  const container = await waitForContainerBySlug(ssh, projectContainerPrefix, slug, wait);
  if (container) {
    log.ok(`  container: ${container}`);
    out.container = container;
  } else {
    log.warn(`  container no detectado a tiempo (${wait}ms). Continuando.`);
  }

  // 6) Restaurar volumenes
  const tarList = bundle.paths.volumesByName[svc.name] ?? [];
  if (tarList.length) {
    const stepVols: StepContext = {
      title: `Restaurar ${tarList.length} volumen(es) de "${svc.name}"`,
      index: step,
      plan: tarList.map((v) => `  - ${path.basename(v)}`),
      optional: true,
      onSkip: () => { log.warn(`Volumenes de ${svc.name} saltados.`); },
    };
    await confirmStep(stepVols, async () => {
      log.out(`  restaurando ${tarList.length} volumen(es)...`);
      for (const localTar of tarList) {
        const baseName = path.basename(localTar);
        const extracted = extractVolumeTarget(baseName);
        if (!extracted) {
          log.warn(`    nombre de archivo de volumen no reconocido: ${baseName}`);
          continue;
        }
        const remoteTar = `${remoteTmp}/x/${bundle.bundleDir}/services/${slugify(svc.name)}/volumes/${baseName}`;
        if (extracted.kind === "named") {
          await ssh.exec(`docker volume create ${extracted.name} || true`);
          await ssh.exec(
            `docker run --rm -v ${extracted.name}:/to -v ${remoteTmp}/x/${bundle.bundleDir}/services/${slug}/volumes:/from:ro alpine sh -c 'tar -xzf /from/${baseName} -C /to'`
          );
        } else {
          await ssh.exec(
            `mkdir -p ${extracted.dst} && cat ${remoteTar} | docker run --rm -i -v ${extracted.dst}:/to alpine sh -c 'tar -xzf - -C /to'`
          );
        }
      }
    });
  }

  // 7) Importar dump de BD
  const dump = bundle.paths.dumpByName[svc.name];
  if (dump && svc.kind === "db") {
    const stepDump: StepContext = {
      title: `Importar dump SQL de "${svc.name}"`,
      index: step,
      plan: [
        `Tipo BD:  ${svc.databaseType}`,
        `Archivo:  dump.sql.gz`,
        `Destino:  container del servicio ${svc.name} (${container ?? slug})`,
        `Accion:   gunzip -c | docker exec ... psql/mysql/mongorestore`,
      ],
      optional: true,
      onSkip: () => { log.warn(`Importacion de BD saltada para ${svc.name}.`); },
    };
    await confirmStep(stepDump, async () => {
      const remoteDump = `${remoteTmp}/x/${bundle.bundleDir}/services/${slug}/dump.sql.gz`;
      await importDump(ssh, container ?? slug, svc.databaseType, remoteDump);
    });
  }

  return out;
}

async function waitForContainerBySlug(
  ssh: Ssh,
  projectPrefix: string,
  slug: string,
  timeoutMs: number
): Promise<string | undefined> {
  const start = Date.now();
  const candidates = [
    `${projectPrefix}${slug}-1`,
    `${projectPrefix}${slug}`,
    slug,
  ];

  while (Date.now() - start < timeoutMs) {
    const r = await ssh.exec(`docker ps -a --format '{{.Names}}'`);
    const all = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const name of all) {
      if (candidates.includes(name)) return name;
      if (name.includes(slug)) return name;
    }
    await sleep(2000);
  }
  return undefined;
}

async function importDump(
  ssh: Ssh,
  container: string,
  db: ManifestService["databaseType"],
  remoteDump: string
): Promise<void> {
  const q = shellQuote;
  switch (db) {
    case "postgres":
      await ssh.exec(
        `gunzip -c ${q(remoteDump)} | docker exec -i ${q(container)} psql -U "$POSTGRES_USER" -d postgres || true`
      );
      return;
    case "mysql":
    case "mariadb":
      await ssh.exec(
        `gunzip -c ${q(remoteDump)} | docker exec -i ${q(container)} mysql -u root -p"$MYSQL_ROOT_PASSWORD" || true`
      );
      return;
    case "mongo":
      await ssh.exec(
        `gunzip -c ${q(remoteDump)} | docker exec -i ${q(container)} mongorestore --archive || true`
      );
      return;
    case "redis":
      await ssh.exec(
        `gunzip -c ${q(remoteDump)} | docker exec -i ${q(container)} sh -c 'cat > /data/dump.rdb && redis-cli FLUSHALL' || true`
      );
      return;
    default:
      await ssh.exec(
        `gunzip -c ${q(remoteDump)} | docker exec -i ${q(container)} sh -c 'cat > /tmp/dump.sql && (command -v psql && psql -U "$POSTGRES_USER" /tmp/dump.sql) || (command -v mysql && mysql -u root -p"$MYSQL_ROOT_PASSWORD" /tmp/dump.sql) || true'`
      );
      return;
  }
}

function defaultImage(svc: ManifestService): string {
  if (svc.image) return svc.image;
  if (svc.kind === "db") {
    switch (svc.databaseType) {
      case "postgres":
        return "postgres:18-alpine";
      case "mysql":
        return "mysql:8";
      case "mariadb":
        return "mariadb:11";
      case "mongo":
        return "mongo:7";
      case "redis":
        return "redis:7-alpine";
      default:
        return "alpine:3";
    }
  }
  return "nginx:alpine";
}

type VolTarget =
  | { kind: "named"; name: string }
  | { kind: "bind"; dst: string };

function extractVolumeTarget(fileName: string): VolTarget | null {
  if (fileName.startsWith("_")) {
    const inner = fileName.replace(/\.tar\.gz$/, "").replace(/^_+/, "");
    const dst = "/" + inner.replace(/__/g, "/").replace(/_/g, "/");
    return { kind: "bind", dst };
  }
  return { kind: "named", name: fileName.replace(/\.tar\.gz$/, "") };
}

function sanitizeProjectName(n: string): string {
  return n.replace(/[^A-Za-z0-9 _-]/g, "").trim() || "restored-project";
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "service"
  );
}

function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9_\-\.\/=]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
