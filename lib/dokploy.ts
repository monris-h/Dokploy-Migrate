import type {
  Connection,
  ProjectSummary,
  ServiceSummary,
  ServiceKind,
  DatabaseType,
} from "./types.js";

/**
 * Cliente para la API REST de Dokploy.
 *
 * READ: listProjects, listServices.
 * WRITE (restore): dokployCreateProject, dokployCreateApplication,
 *                 dokployCreatePostgres/MySql/MariaDb/Mongo/Redis,
 *                 dokployDeployApplication/Postgres/etc.
 */

type FetchOpts = {
  method?: "GET" | "POST";
  body?: unknown;
  signal?: AbortSignal;
};

class DokployError extends Error {
  status: number;
  body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "DokployError";
    this.status = status;
    this.body = body;
  }
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export async function dokployFetch<T>(
  conn: Connection,
  path: string,
  opts: FetchOpts = {}
): Promise<T> {
  const base = normalizeBaseUrl(conn.url);
  const url = `${base}${path}`;

  const headers: Record<string, string> = {
    "x-api-key": conn.apiKey,
    Accept: "application/json",
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
      cache: "no-store",
    });
  } catch (err) {
    throw new DokployError(
      `No pude conectar a Dokploy en ${base}. (${(err as Error).message})`,
      0,
      ""
    );
  }

  const text = await res.text();
  if (!res.ok) {
    if (process.env.DEBUG_DOKPLOY) {
      process.stderr.write(
        `[DEBUG_DOKPLOY] ${path} -> ${res.status}\n  body: ${text.slice(0, 800)}\n`
      );
    }
    throw new DokployError(
      `Dokploy respondio ${res.status} en ${path}: ${text.slice(0, 200)}`,
      res.status,
      text
    );
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

// ---------- READ ----------

export async function listProjects(conn: Connection): Promise<ProjectSummary[]> {
  type Raw = Array<{
    projectId: string;
    name: string;
    description?: string;
    env?: string | null;
    createdAt?: string;
  }>;
  let raw: Raw;
  try {
    raw = await dokployFetch<Raw>(conn, "/api/project.all");
  } catch {
    raw = await dokployFetch<Raw>(conn, "/api/project");
  }
  return (raw ?? []).map((p) => ({
    projectId: p.projectId,
    name: p.name,
    description: p.description ?? undefined,
  }));
}

export async function listServices(
  conn: Connection,
  projectId: string
): Promise<ServiceSummary[]> {
  const verbose = process.env.DEBUG_LIST_SERVICES === "1";
  const log = (m: string) => {
    if (verbose) process.stdout.write(`  [listServices] ${m}\n`);
  };

  log(`projectId: ${projectId}`);

  // Paso 1: detectar project + environments via /api/project.one
  const { project, environments } = await detectProjectAndEnvs(conn, projectId);
  const envIds = environments.map((e) => e.environmentId);
  log(`project "${project.name}" environments: [${envIds.join(", ")}]`);

  // === Estrategia A: services dentro de project.one.environments[] ===
  const out: ServiceSummary[] = [];
  const seen = new Set<string>();
  const seenEnvKeys = new Set<string>();

  for (const env of environments) {
    log(`  [A] env ${env.environmentId} - extrayendo desde project.one.environments[]:`);
    const { services, unknownKeys } = extractServicesFromEnv(
      env.raw,
      env.environmentId,
      projectId,
      seen,
      log
    );
    out.push(...services);
    for (const k of unknownKeys) seenEnvKeys.add(k);
  }

  if (seenEnvKeys.size > 0) {
    const keys = Array.from(seenEnvKeys);
    log(`  campos no reconocidos en env (parecian colecciones): ${keys.join(", ")}`);
  }

  // === Estrategia B: si A=0, llamar /api/environment.one por cada envId ===
  if (out.length === 0 && envIds.length > 0) {
    log(`0 desde project.one; probando /api/environment.one por environmentId...`);
    for (const envId of envIds) {
      try {
        const envServices = await listServicesByEnvironment(conn, envId, projectId);
        log(`  [B] env ${envId} -> ${envServices.length} services`);
        for (const s of envServices) {
          const k = `${s.kind}:${s.id}`;
          if (seen.has(k)) continue;
          seen.add(k);
          out.push(s);
        }
      } catch (e) {
        log(`  [B] env ${envId} FAIL: ${(e as Error).message}`);
      }
    }
  }

  // === Estrategia C: fallback a endpoints .all con filtro local ===
  if (out.length === 0) {
    log(`0 desde environment.one; fallback a endpoints .all`);
    const matches = (it: Record<string, unknown>): boolean => {
      const projectFields = ["projectId", "projectID", "ProjectId"];
      if (projectFields.some((f) => it[f] === projectId)) return true;
      const envFields = ["environmentId", "environmentID", "EnvironmentId"];
      if (envIds.some((e) => envFields.some((f) => it[f] === e))) return true;
      return false;
    };

    for (const [type, fetcher] of [
      ["application", () => fetchAllApps(conn, "", false)] as const,
      ["postgres", () => fetchAllDbs(conn, "postgres", "", false)] as const,
      ["mysql", () => fetchAllDbs(conn, "mysql", "", false)] as const,
      ["mariadb", () => fetchAllDbs(conn, "mariadb", "", false)] as const,
      ["mongo", () => fetchAllDbs(conn, "mongo", "", false)] as const,
      ["redis", () => fetchAllDbs(conn, "redis", "", false)] as const,
      ["compose", () => fetchCompose(conn, "", false)] as const,
    ]) {
      try {
        const items = await fetcher();
        log(`  [C] ${type}.all: ${items.length} total`);
        for (const s of items.filter((x) =>
          matches(x as unknown as Record<string, unknown>)
        )) {
          const k = `${s.kind}:${s.id}`;
          if (seen.has(k)) continue;
          seen.add(k);
          out.push(s);
        }
      } catch (e) {
        log(`  [C] ${type}.all FAIL: ${(e as Error).message}`);
      }
    }
  }

  log(`total: ${out.length} servicios`);

  if (out.length === 0) {
    let envShape = "(none)";
    if (environments.length > 0) {
      const env0 = environments[0];
      envShape = Object.keys(env0.raw)
        .filter((k) => {
          const v = (env0.raw as Record<string, unknown>)[k];
          return Array.isArray(v) || typeof v === "object";
        })
        .join(", ");
    }
    throw new Error(
      `No se encontraron servicios para el proyecto "${project.name}" (${projectId}). ` +
        `environments devueltos: [${envIds.join(", ")}]. ` +
        `Claves del primer environment: ${envShape}. ` +
        `Tip: corre "node debug-services.mjs ${projectId}" y mandame el output completo.`
    );
  }

  return out;
}

/**
 * Lista services de un environment especifico via /api/environment.one.
 * Funcion independiente: si el caller ya sabe el environmentId (ej. desde
 * la UI de Dokploy), puede llamarla directo sin pasar por projectId.
 */
export async function listServicesByEnvironment(
  conn: Connection,
  environmentId: string,
  projectId?: string
): Promise<ServiceSummary[]> {
  const verbose = process.env.DEBUG_LIST_SERVICES === "1";
  const log = (m: string) => {
    if (verbose) process.stdout.write(`  [listServicesByEnvironment] ${m}\n`);
  };

  log(`environmentId: ${environmentId}`);

  let data: Record<string, unknown>;
  try {
    data = await dokployFetch<Record<string, unknown>>(
      conn,
      `/api/environment.one?environmentId=${encodeURIComponent(environmentId)}`
    );
  } catch (e) {
    log(`environment.one FAIL: ${(e as Error).message}`);
    throw e;
  }

  const envId = String(data.environmentId ?? data.id ?? environmentId) || environmentId;
  const pid =
    projectId ?? (String(data.projectId ?? data.project ?? "") || undefined);

  const seen = new Set<string>();
  const { services, unknownKeys } = extractServicesFromEnv(
    data,
    envId,
    pid,
    seen,
    log
  );

  if (unknownKeys.length > 0) {
    log(`  campos no reconocidos: ${unknownKeys.join(", ")}`);
  }
  log(`  -> ${services.length} services`);

  return services;
}

/**
 * Extrae services de un objeto Dokploy que representa un environment
 * (ya sea desde /api/project.one.environments[i] o desde /api/environment.one).
 * Busca las colecciones estandar: applications, postgres, mysql, mariadb,
 * mongo, redis, compose.
 */
function extractServicesFromEnv(
  envRaw: Record<string, unknown>,
  envId: string,
  projectId: string | undefined,
  seen: Set<string>,
  log: (m: string) => void
): { services: ServiceSummary[]; unknownKeys: string[] } {
  const services: ServiceSummary[] = [];
  const unknownKeys: string[] = [];

  for (const entry of COLLECTION_KEYS) {
    const items = (envRaw[entry.key] as Array<Record<string, unknown>>) ?? [];
    if (items.length === 0) continue;
    log(`    ${entry.key}: ${items.length} items`);
    for (const it of items) {
      const id = String(it[entry.idField] ?? it["id"] ?? it["Id"] ?? "");
      if (!id) continue;
      const k = `${entry.kind}:${id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      services.push({
        kind: entry.kind,
        id,
        name: String(it["name"] ?? it["appName"] ?? it["Name"] ?? "?"),
        appName: String(it["appName"] ?? it["AppName"] ?? "") || undefined,
        envId,
        projectId,
        databaseType: entry.databaseType,
      });
    }
  }

  for (const k of Object.keys(envRaw)) {
    if (COLLECTION_KEYS.some((c) => c.key === k)) continue;
    const v = (envRaw as Record<string, unknown>)[k];
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object") {
      unknownKeys.push(k);
    }
  }

  return { services, unknownKeys };
}

/**
 * Llaves estandar que Dokploy usa dentro de cada environment para sus services.
 * Si tu version tiene otras, agregalas aca.
 *
 * `kind` es el ServiceKind generico (app/db/compose) que usa el resto del
 * codigo. `databaseType` se setea solo para kinds db.
 */
const COLLECTION_KEYS: Array<{
  kind: ServiceKind;
  key: string;
  idField: string;
  databaseType?: DatabaseType;
}> = [
  { kind: "app", key: "applications", idField: "applicationId" },
  { kind: "db", key: "postgres", idField: "postgresId", databaseType: "postgres" },
  { kind: "db", key: "mysql", idField: "mysqlId", databaseType: "mysql" },
  { kind: "db", key: "mariadb", idField: "mariadbId", databaseType: "mariadb" },
  { kind: "db", key: "mongo", idField: "mongoId", databaseType: "mongo" },
  { kind: "db", key: "redis", idField: "redisId", databaseType: "redis" },
  { kind: "compose", key: "compose", idField: "composeId" },
];

async function detectProjectAndEnvs(
  conn: Connection,
  projectId: string
): Promise<{
  project: { name: string; projectId: string };
  environments: Array<{ environmentId: string; name?: string; raw: Record<string, unknown> }>;
  raw: Record<string, unknown>;
}> {
  const data = await dokployFetch<Record<string, unknown>>(
    conn,
    `/api/project.one?projectId=${encodeURIComponent(projectId)}`
  );
  const envs = (data.environments as Array<Record<string, unknown>>) ?? [];
  return {
    project: {
      name: String(data.name ?? "?"),
      projectId: String(data.projectId ?? projectId),
    },
    environments: envs.map((e) => ({
      environmentId: String(e.environmentId ?? e.id ?? ""),
      name: e.name as string | undefined,
      raw: e,
    })),
    raw: data,
  };
}

async function fetchAllApps(
  conn: Connection,
  projectId: string,
  withFilter: boolean
): Promise<ServiceSummary[]> {
  try {
    const url = withFilter
      ? `/api/application.all?projectId=${encodeURIComponent(projectId)}`
      : `/api/application.all`;
    const apps = await dokployFetch<Array<Record<string, unknown>>>(conn, url);
    const out: ServiceSummary[] = [];
    for (const a of apps ?? []) {
      const id = String(a.applicationId ?? a.id ?? "");
      const name = String(a.name ?? "app");
      out.push({
        id,
        name,
        kind: "app",
        status: a.applicationStatus as string | undefined,
        image: (a.dockerImage as string | undefined) ?? undefined,
      });
    }
    return out;
  } catch {
    return [];
  }
}

async function fetchAllDbs(
  conn: Connection,
  dbType: DatabaseType,
  projectId: string,
  withFilter: boolean
): Promise<ServiceSummary[]> {
  try {
    const url = withFilter
      ? `/api/${dbType}.all?projectId=${encodeURIComponent(projectId)}`
      : `/api/${dbType}.all`;
    const items = await dokployFetch<Array<Record<string, unknown>>>(conn, url);
    const out: ServiceSummary[] = [];
    for (const it of items ?? []) {
      const id = String(
        it[`${dbType}Id`] ?? it.id ?? (dbType === "mongo" ? it.mongoId : null) ?? ""
      );
      const name = String(it.name ?? dbType);
      out.push({
        id,
        name,
        kind: "db",
        databaseType: dbType,
        status: it.applicationStatus as string | undefined,
        image: it.dockerImage as string | undefined,
        volumeName:
          (it[`${dbType}DataPath`] as string | undefined) ??
          (it.dataPath as string | undefined) ??
          undefined,
      });
    }
    return out;
  } catch {
    return [];
  }
}

async function fetchCompose(
  conn: Connection,
  projectId: string,
  withFilter: boolean
): Promise<ServiceSummary[]> {
  try {
    const url = withFilter
      ? `/api/compose.all?projectId=${encodeURIComponent(projectId)}`
      : `/api/compose.all`;
    const items = await dokployFetch<Array<Record<string, unknown>>>(conn, url);
    const out: ServiceSummary[] = [];
    for (const it of items ?? []) {
      const id = String(it.composeId ?? it.id ?? "");
      const name = String(it.name ?? "compose");
      out.push({
        id,
        name,
        kind: "compose",
        status:
          (it.composeStatus as string | undefined) ??
          (it.applicationStatus as string | undefined),
        image: (it.dockerImage as string | undefined) ?? undefined,
      });
    }
    return out;
  } catch {
    return [];
  }
}

async function collectDb(
  conn: Connection,
  projectId: string,
  dbType: DatabaseType,
  out: ServiceSummary[]
) {
  try {
    const items = await dokployFetch<Array<Record<string, unknown>>>(
      conn,
      `/api/${dbType}.all?projectId=${encodeURIComponent(projectId)}`
    );
    for (const it of items ?? []) {
      const id = String(
        it[`${dbType}Id`] ??
          it.id ??
          (dbType === "mongo" ? it.mongoId : null) ??
          ""
      );
      const name = String(it.name ?? dbType);
      out.push({
        id,
        name,
        kind: "db",
        databaseType: dbType,
        status: it.applicationStatus as string | undefined,
        image: it.dockerImage as string | undefined,
        volumeName:
          (it[`${dbType}DataPath`] as string | undefined) ??
          (it.dataPath as string | undefined) ??
          undefined,
      });
    }
  } catch {
    // tipo no disponible
  }
}

export function inferKindFromName(name: string): ServiceKind {
  const n = name.toLowerCase();
  if (/(postgres|postgresql|psql|mysql|mariadb|mongo|redis)/.test(n))
    return "db";
  return "app";
}

// ---------- WRITE (restore, per-service) ----------

/** Patrón: primero intenta REST simple, cae a tRPC si el shape no es el esperado. */
async function createViaEndpoint<TId extends string>(
  conn: Connection,
  opts: {
    restPath: string;
    trpcPath: string;
    body: Record<string, unknown>;
    idKeys: TId[];
  }
): Promise<{ ids: Record<TId, string>; raw: unknown }> {
  // Algunos endpoints devuelven el id en variantes (id, uuid, project_id)
  const altKeys = [
    ...opts.idKeys,
    "id",
    "uuid",
  ] as unknown as TId[];

  try {
    const raw = await dokployFetch<unknown>(conn, opts.restPath, {
      method: "POST",
      body: opts.body,
    });
    const ids = extractIds(raw, altKeys);
    if (Object.keys(ids).length > 0) return { ids, raw };
    if (process.env.DEBUG_DOKPLOY) {
      process.stderr.write(
        `[DEBUG_DOKPLOY] ${opts.restPath} no devolvio ${opts.idKeys.join("/")}. Raw: ${JSON.stringify(raw).slice(0, 500)}\n`
      );
    }
  } catch {
    // cae a trpc
  }

  type TrpcBatch = Array<{
    result?: { data?: { json?: Record<string, unknown> } };
  }>;
  const trpc = await dokployFetch<TrpcBatch>(conn, opts.trpcPath, {
    method: "POST",
    body: { "0": { json: opts.body } },
  });
  const j = trpc?.[0]?.result?.data?.json;
  if (!j) {
    if (process.env.DEBUG_DOKPLOY) {
      process.stderr.write(
        `[DEBUG_DOKPLOY] ${opts.trpcPath} sin .result[0].data.json. Raw: ${JSON.stringify(trpc).slice(0, 500)}\n`
      );
    }
    throw new Error(`Dokploy no devolvio ${opts.idKeys.join("/")} al crear servicio.`);
  }
  const ids = extractIds(j, altKeys);
  if (Object.keys(ids).length === 0) {
    if (process.env.DEBUG_DOKPLOY) {
      process.stderr.write(
        `[DEBUG_DOKPLOY] ${opts.trpcPath} j=${JSON.stringify(j).slice(0, 500)}\n`
      );
    }
    throw new Error(`Dokploy no devolvio ${opts.idKeys.join("/")} al crear servicio.`);
  }
  return { ids, raw: trpc };
}

function extractIds<TKey extends string>(
  r: unknown,
  keys: TKey[]
): Record<TKey, string> {
  const out = {} as Record<TKey, string>;
  if (!r || typeof r !== "object") return out;
  const visit = (v: unknown) => {
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    for (const k of keys) {
      const val = o[k];
      if (typeof val === "string" && !out[k]) out[k] = val;
    }
    // recursivo limitado a .data y .json
    if (o.data && typeof o.data === "object") visit(o.data);
    if (o.json && typeof o.json === "object") visit(o.json);
  };
  visit(r);
  return out;
}

/** Crea un proyecto nuevo. Si ya existe uno con ese nombre, lo reusa. */
export async function dokployCreateProject(
  conn: Connection,
  opts: { name: string; description?: string }
): Promise<string> {
  // Primero: si ya existe un proyecto con ese nombre, reusar
  try {
    const existing = await listProjects(conn);
    const found = existing.find(
      (p) => p.name.toLowerCase() === opts.name.toLowerCase()
    );
    if (found) {
      if (process.env.DEBUG_DOKPLOY) {
        process.stderr.write(
          `[DEBUG_DOKPLOY] Proyecto "${opts.name}" ya existe, reusando projectId=${found.projectId}\n`
        );
      }
      return found.projectId;
    }
  } catch {
    // si falla el listado, intentar crear igual
  }

  const { ids } = await createViaEndpoint(conn, {
    restPath: "/api/project.create",
    trpcPath: "/api/trpc/project.create?batch=1",
    body: { name: opts.name, description: opts.description ?? "" },
    idKeys: ["projectId"],
  });
  return ids.projectId ?? (ids as Record<string, string>).id ?? "";
}

// ------- Application (apps / web / Next, etc.) -------

export type CreateApplicationOpts = {
  projectId: string;
  name: string;
  image?: string;
  /** Variables de entorno que se aplican al servicio. */
  env?: Record<string, string>;
};

/** Crea una application (Next, Node, nginx, etc.) en Dokploy. */
export async function dokployCreateApplication(
  conn: Connection,
  opts: CreateApplicationOpts
): Promise<string> {
  const envString = opts.env ? JSON.stringify(opts.env) : "";

  const { ids } = await createViaEndpoint(conn, {
    restPath: "/api/application.create",
    trpcPath: "/api/trpc/application.create?batch=1",
    body: {
      name: opts.name,
      projectId: opts.projectId,
      appName: slugName(opts.name),
      sourceType: opts.image ? "image" : "git",
      dockerImage: opts.image ?? "",
      env: envString,
      replicas: 1,
      restartPolicy: "unless-stopped",
    },
    idKeys: ["applicationId", "appId"],
  });
  return ids.applicationId ?? ids.appId;
}

export async function dokployDeployApplication(
  conn: Connection,
  applicationId: string
): Promise<void> {
  try {
    await dokployFetch<unknown>(conn, "/api/application.deploy", {
      method: "POST",
      body: { applicationId },
    });
    return;
  } catch {
    /* trpc fallback */
  }
  await dokployFetch<unknown>(conn, "/api/trpc/application.deploy?batch=1", {
    method: "POST",
    body: { "0": { json: { applicationId } } },
  });
}

// ------- Database services -------

export type CreateDbOpts = {
  projectId: string;
  name: string;
  image?: string;
  env?: Record<string, string>;
};

export type DbIdMap = Record<DatabaseType, (conn: Connection, opts: CreateDbOpts) => Promise<string>>;

async function createDb(
  conn: Connection,
  type: DatabaseType,
  opts: CreateDbOpts,
  defaultImage: string
): Promise<string> {
  const envString = opts.env ? JSON.stringify(opts.env) : "";
  const idKey = `${type}Id`;

  const { ids } = await createViaEndpoint(conn, {
    restPath: `/api/${type}.create`,
    trpcPath: `/api/trpc/${type}.create?batch=1`,
    body: {
      name: opts.name,
      projectId: opts.projectId,
      appName: slugName(opts.name),
      sourceType: opts.image || defaultImage ? "image" : "image",
      dockerImage: opts.image ?? defaultImage,
      env: envString,
      restartPolicy: "unless-stopped",
    },
    idKeys: [idKey],
  });
  return ids[idKey];
}

async function deployDb(conn: Connection, type: DatabaseType, id: string): Promise<void> {
  try {
    await dokployFetch<unknown>(conn, `/api/${type}.deploy`, {
      method: "POST",
      body: { [`${type}Id`]: id },
    });
    return;
  } catch {
    /* trpc fallback */
  }
  await dokployFetch<unknown>(
    conn,
    `/api/trpc/${type}.deploy?batch=1`,
    {
      method: "POST",
      body: { "0": { json: { [`${type}Id`]: id } } },
    }
  );
}

export async function dokployCreatePostgres(
  conn: Connection,
  opts: CreateDbOpts
): Promise<string> {
  return createDb(conn, "postgres", opts, "postgres:18-alpine");
}

export async function dokployDeployPostgres(
  conn: Connection,
  id: string
): Promise<void> {
  return deployDb(conn, "postgres", id);
}

export async function dokployCreateMysql(
  conn: Connection,
  opts: CreateDbOpts
): Promise<string> {
  return createDb(conn, "mysql", opts, "mysql:8");
}

export async function dokployDeployMysql(
  conn: Connection,
  id: string
): Promise<void> {
  return deployDb(conn, "mysql", id);
}

export async function dokployCreateMariadb(
  conn: Connection,
  opts: CreateDbOpts
): Promise<string> {
  return createDb(conn, "mariadb", opts, "mariadb:11");
}

export async function dokployDeployMariadb(
  conn: Connection,
  id: string
): Promise<void> {
  return deployDb(conn, "mariadb", id);
}

export async function dokployCreateMongo(
  conn: Connection,
  opts: CreateDbOpts
): Promise<string> {
  return createDb(conn, "mongo", opts, "mongo:7");
}

export async function dokployDeployMongo(
  conn: Connection,
  id: string
): Promise<void> {
  return deployDb(conn, "mongo", id);
}

export async function dokployCreateRedis(
  conn: Connection,
  opts: CreateDbOpts
): Promise<string> {
  return createDb(conn, "redis", opts, "redis:7-alpine");
}

export async function dokployDeployRedis(
  conn: Connection,
  id: string
): Promise<void> {
  return deployDb(conn, "redis", id);
}

// ------- helpers -------

function slugName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "service"
  );
}
