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
    throw new DokployError(
      `Dokploy respondio ${res.status} en ${path}`,
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

  // Paso 1: detectar environmentId via /api/project.one
  const { project, environmentIds } = await detectProjectAndEnvs(conn, projectId);
  log(`project encontrado: "${project.name}". environments: ${environmentIds.join(", ")}`);

  // Helper: filtra items por projectId o por environmentId (cualquier variante)
  const matches = (it: Record<string, unknown>): boolean => {
    const projectFields = ["projectId", "projectID", "ProjectId"];
    if (projectFields.some((f) => it[f] === projectId)) return true;
    const envFields = ["environmentId", "environmentID", "EnvironmentId"];
    if (environmentIds.some((e) => envFields.some((f) => it[f] === e))) return true;
    return false;
  };

  // Paso 2: estrategia de "listar todo + filtrar local" como fallback principal
  // (porque la API puede ignorar ?projectId= y ?environmentId= en esta version)
  const out: ServiceSummary[] = [];
  const seen = new Set<string>(); // dedupe por id

  for (const [type, fetcher] of [
    ["application", () => fetchAllApps(conn, "", false)] as const,
    ["postgres", () => fetchAllDbs(conn, "postgres", "", false)] as const,
    ["mysql", () => fetchAllDbs(conn, "mysql", "", false)] as const,
    ["mariadb", () => fetchAllDbs(conn, "mariadb", "", false)] as const,
    ["mongo", () => fetchAllDbs(conn, "mongo", "", false)] as const,
    ["redis", () => fetchAllDbs(conn, "redis", "", false)] as const,
    ["compose", () => fetchCompose(conn, "", false)] as const,
  ]) {
    let allItems: ServiceSummary[] = [];
    try {
      allItems = await fetcher();
    } catch (e) {
      log(`${type}.all FAIL: ${(e as Error).message}`);
      continue;
    }
    log(`${type}.all (total server): ${allItems.length} items`);

    const mine = allItems.filter((s) => matches(s as unknown as Record<string, unknown>));
    log(`${type}.all -> mios: ${mine.length}`);

    for (const svc of mine) {
      const k = `${svc.kind}:${svc.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(svc);
    }
  }

  log(`total: ${out.length} servicios`);

  if (out.length === 0) {
    // Ninguna estrategia funciono. Damos info util de debug.
    let info = "";
    try {
      const allApps = await fetchAllApps(conn, "", false);
      info = `Aplicaciones del server (sin filtro): ${allApps.length}. `;
      if (allApps.length > 0) {
        const sample = allApps.slice(0, 3).map((a) => {
          const x = a as unknown as Record<string, unknown>;
          return `name=${a.name} projectId=${x.projectId ?? "?"} environmentId=${x.environmentId ?? "?"}`;
        });
        info += `Ejemplos: ${sample.join(" | ")}`;
      }
    } catch (e) {
      info = `Error: ${(e as Error).message}`;
    }
    throw new Error(
      `No se encontraron servicios para el proyecto "${projectId}". ` +
        `project.one devolvio environments: [${environmentIds.join(", ")}]. ` +
        `${info}. ` +
        `Tip: tu Dokploy puede usar un campo distinto. Corre: node debug-services.mjs ${projectId}`
    );
  }

  return out;
}

/**
 * Detecta el projectId y todos los environmentIds asociados via /api/project.one.
 */
async function detectProjectAndEnvs(
  conn: Connection,
  projectId: string
): Promise<{ project: { name: string; projectId: string }; environmentIds: string[] }> {
  try {
    const data = await dokployFetch<Record<string, unknown>>(
      conn,
      `/api/project.one?projectId=${encodeURIComponent(projectId)}`
    );
    const envs = (data.environments as Array<Record<string, unknown>>) ?? [];
    const envIds = envs
      .map((e) => String(e.environmentId ?? e.id ?? ""))
      .filter(Boolean);
    return {
      project: {
        name: String(data.name ?? "?"),
        projectId: String(data.projectId ?? projectId),
      },
      environmentIds: envIds,
    };
  } catch (e) {
    return {
      project: { name: "?", projectId },
      environmentIds: [],
    };
  }
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
  try {
    const raw = await dokployFetch<unknown>(conn, opts.restPath, {
      method: "POST",
      body: opts.body,
    });
    const ids = extractIds(raw, opts.idKeys);
    if (Object.keys(ids).length > 0) return { ids, raw };
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
  if (!j) throw new Error(`Dokploy no devolvio ${opts.idKeys.join("/")} al crear servicio.`);
  const ids = extractIds(j, opts.idKeys);
  if (Object.keys(ids).length === 0)
    throw new Error(`Dokploy no devolvio ${opts.idKeys.join("/")} al crear servicio.`);
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

/** Crea un proyecto nuevo. */
export async function dokployCreateProject(
  conn: Connection,
  opts: { name: string; description?: string }
): Promise<string> {
  const { ids } = await createViaEndpoint(conn, {
    restPath: "/api/project.create",
    trpcPath: "/api/trpc/project.create?batch=1",
    body: { name: opts.name, description: opts.description ?? "" },
    idKeys: ["projectId"],
  });
  return ids.projectId;
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
