import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import * as tar from "tar";
import type { BackupSelection, DatabaseType, ServiceKind } from "./types.js";

/**
 * Parseo de un bundle .tar.gz que generamos nosotros mismos.
 *
 *   <bundle-name>/
 *   ├── manifest.json
 *   ├── RESTORE.md
 *   ├── services/
 *   │   └── <slug>/
 *   │       ├── docker-compose.yml   (opcional)
 *   │       ├── docker-inspect.json (opcional)
 *   │       ├── env.json            (opcional)
 *   │       ├── service.env         (opcional)
 *   │       ├── volumes/            (opcional, *.tar.gz)
 *   │       └── dump.sql.gz         (opcional, solo db)
 *   └── volumes/                    (named volumes sueltos)
 */

export type ManifestService = {
  name: string;
  kind: ServiceKind;
  databaseType: DatabaseType | null;
  image: string | null;
  /** Tipo de fuente original: "image" / "git" / "docker-compose" */
  sourceType?: "image" | "git" | "docker-compose" | null;
  /** Repo URL si viene de git */
  repository?: string | null;
  /** Branch a deployar */
  branch?: string | null;
  /** Commit SHA actual del repo */
  commit?: string | null;
  /** Path dentro del repo (monorepos) */
  buildPath?: string | null;
  selection: BackupSelection;
};

export type Manifest = {
  project: { id: string; name: string };
  generatedAt: string;
  bundle: string;
  services: ManifestService[];
  notes: string[];
};

export type BundlePathMap = {
  manifestPath: string;
  restoreMdPath: string;
  composeByName: Record<string, string>;
  envByName: Record<string, string>;
  dumpByName: Record<string, string>;
  volumesByName: Record<string, string[]>;
};

export type ExtractedBundle = {
  root: string;
  bundleDir: string;
  manifest: Manifest;
  paths: BundlePathMap;
  full: string;
};

export async function extractBundle(tarPath: string): Promise<ExtractedBundle> {
  if (!tarPath.endsWith(".tar.gz")) {
    throw new Error(`No es un .tar.gz: ${tarPath}`);
  }
  const abs = path.resolve(tarPath);
  const stat = await fs.stat(abs);
  if (!stat.isFile()) throw new Error(`No existe archivo: ${abs}`);

  const extractRoot = await fs.mkdtemp(path.join(os.tmpdir(), "migrate-dokploy-"));
  await tar.x({
    file: abs,
    cwd: extractRoot,
    preservePaths: false,
  });

  const top = await fs.readdir(extractRoot);
  let bundleDirs = top.filter((d) => !d.startsWith("."));

  // Retrocompatibilidad: si el primer nivel es un dir de sistema (tmp/, root/,
  // home/) que se metio porque el script bash uso paths absolutos, bajar un nivel.
  const SYSTEM_DIRS = new Set(["tmp", "root", "home", "var"]);
  let extraPrefix = "";
  if (bundleDirs.length === 1 && SYSTEM_DIRS.has(bundleDirs[0])) {
    extraPrefix = bundleDirs[0];
    const inner = await fs.readdir(path.join(extractRoot, extraPrefix));
    bundleDirs = inner.filter((d) => !d.startsWith("."));
  }

  if (bundleDirs.length === 0) throw new Error("Bundle vacio");
  if (bundleDirs.length > 1) {
    throw new Error(
      "Bundle inesperado: hay mas de un directorio raiz: " + bundleDirs.join(", ")
    );
  }
  const bundleDir = bundleDirs[0];
  const full = path.join(extractRoot, extraPrefix, bundleDir);

  const manifestPath = path.join(full, "manifest.json");
  const manifestRaw = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Manifest;
  if (!manifestRaw?.project?.name || !Array.isArray(manifestRaw.services)) {
    throw new Error("manifest.json invalido o no es un bundle de migrate-dokploy");
  }

  const restoreMdPath = path.join(full, "RESTORE.md");
  const composeByName: Record<string, string> = {};
  const envByName: Record<string, string> = {};
  const dumpByName: Record<string, string> = {};
  const volumesByName: Record<string, string[]> = {};

  const servicesDir = path.join(full, "services");
  try {
    const entries = await fs.readdir(servicesDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const svcDir = path.join(servicesDir, e.name);
      const files = await listFiles(svcDir);
      for (const f of files) {
        const base = path.basename(f);
        if (base === "docker-compose.yml") {
          const found = pickServiceName(e.name, manifestRaw.services);
          if (found) composeByName[found] = f;
        } else if (base === "env.json") {
          const found = pickServiceName(e.name, manifestRaw.services);
          if (found) envByName[found] = f;
        } else if (base === "dump.sql.gz") {
          const found = pickServiceName(e.name, manifestRaw.services);
          if (found) dumpByName[found] = f;
        } else if (base.endsWith(".tar.gz") && !base.startsWith("_")) {
          const found = pickServiceName(e.name, manifestRaw.services);
          if (found) {
            (volumesByName[found] ||= []).push(f);
          }
        }
      }
    }
  } catch {
    // carpeta services no existe
  }

  return {
    root: extractRoot,
    bundleDir,
    manifest: manifestRaw,
    paths: {
      manifestPath,
      restoreMdPath,
      composeByName,
      envByName,
      dumpByName,
      volumesByName,
    },
    full,
  };
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    const entries = await fs.readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out.push(p);
    }
  };
  await walk(dir);
  return out;
}

function pickServiceName(
  dirName: string,
  services: ManifestService[]
): string | undefined {
  const dirSlug = dirName;
  for (const s of services) {
    if (slugify(s.name) === dirSlug) return s.name;
  }
  return undefined;
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

/**
 * Compone un unico docker-compose.yml que recrea TODOS los servicios del bundle.
 */
export function combineCompose(
  services: ManifestService[],
  envsByName: Record<string, Record<string, string>>
): string {
  const svcBlocks: string[] = [];
  const namedVolumes: string[] = [];

  for (const s of services) {
    const env = envsByName[s.name] ?? {};
    const isApp = s.kind === "app";
    const image =
      s.image ?? (isApp ? "nginx:alpine" : defaultDbImage(s.databaseType));

    const envBlock = Object.entries(env)
      .map(([k, v]) => `      ${k}: ${yamlQuote(v)}`)
      .join("\n");

    const portSpec = isApp ? guessAppPort(image) : guessDbPort(s.databaseType);

    const lines: string[] = [];
    lines.push(`  ${slugify(s.name)}:`);
    lines.push(`    image: ${image}`);
    lines.push(`    container_name: ${slugify(s.name)}`);
    if (envBlock) {
      lines.push(`    environment:`);
      lines.push(envBlock);
    }
    if (portSpec) {
      const [hostPort, containerPort] = portSpec.includes(":")
        ? portSpec.split(":")
        : [portSpec, portSpec];
      lines.push(`    ports:`);
      lines.push(`      - "${hostPort}:${containerPort}"`);
    }
    if (s.kind === "db") {
      lines.push(`    volumes:`);
      lines.push(
        `      - ${slugify(s.name)}-data:/var/lib/${dbVolumeDir(s.databaseType)}`
      );
      namedVolumes.push(`  ${slugify(s.name)}-data:`);
    }
    lines.push(`    restart: unless-stopped`);
    svcBlocks.push(lines.join("\n"));
  }

  const out: string[] = [];
  out.push(`services:`);
  out.push(svcBlocks.join("\n"));
  if (namedVolumes.length) {
    out.push(``);
    out.push(`volumes:`);
    out.push(namedVolumes.join("\n"));
  }
  return out.join("\n");
}

export function composeForService(
  service: ManifestService,
  envPairs: Record<string, string>
): string {
  return combineCompose([service], { [service.name]: envPairs });
}

function yamlQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function guessAppPort(image: string): string {
  if (/next/i.test(image) || /node/i.test(image)) return "3000";
  if (/nginx/i.test(image)) return "80";
  return "";
}

function guessDbPort(t: DatabaseType | null): string {
  switch (t) {
    case "postgres":
      return "5432";
    case "mysql":
    case "mariadb":
      return "3306";
    case "mongo":
      return "27017";
    case "redis":
      return "6379";
    default:
      return "";
  }
}

function dbVolumeDir(t: DatabaseType | null): string {
  switch (t) {
    case "postgres":
      return "postgresql/data";
    case "mysql":
    case "mariadb":
      return "mysql";
    case "mongo":
      return "data/db";
    case "redis":
      return "data";
    default:
      return "data";
  }
}

function defaultDbImage(t: DatabaseType | null): string {
  switch (t) {
    case "postgres":
      return "postgres:18";
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

export async function readEnvJson(envPath: string): Promise<Record<string, string>> {
  type Doc = Array<string> | Record<string, string>;
  try {
    const raw = JSON.parse(await fs.readFile(envPath, "utf8")) as Doc;
    if (Array.isArray(raw)) {
      const out: Record<string, string> = {};
      for (const kv of raw) {
        const i = kv.indexOf("=");
        if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
      }
      return out;
    }
    return raw;
  } catch {
    return {};
  }
}
