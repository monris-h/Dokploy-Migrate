import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * BD local multi-server en `%USERPROFILE%\.migrate-dokploy\db.json`.
 */

export type DokployConn = { url: string; apiKey: string };
export type SshConn = {
  host: string;
  port: number;
  username: string;
  privateKeyPath?: string;
  passphrase?: string;
};

export type ServerRole = "source" | "target";

export type Server = {
  id: string;
  label: string;
  dokploy: DokployConn;
  ssh: SshConn;
  roles: ServerRole[];
  lastUsedAt?: string;
  createdAt: string;
};

export type Db = {
  version: 1;
  servers: Server[];
  defaults: { source?: string; target?: string };
};

const DATA_DIR = path.join(os.homedir(), ".migrate-dokploy");
const DB_FILE = path.join(DATA_DIR, "db.json");

function emptyDb(): Db {
  return { version: 1, servers: [], defaults: {} };
}

export function getDbPath(): string {
  return DB_FILE;
}

export async function loadDb(): Promise<Db> {
  try {
    const txt = await fs.readFile(DB_FILE, "utf8");
    const parsed = JSON.parse(txt) as Db;
    if (!parsed.servers) return emptyDb();
    return parsed;
  } catch {
    return migrateLegacy();
  }
}

export async function saveDb(db: Db): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2), { mode: 0o600 });
}

export async function upsertServer(server: Server): Promise<Db> {
  const db = await loadDb();
  db.servers = db.servers.filter((s) => s.id !== server.id);
  db.servers.push(server);
  await saveDb(db);
  return db;
}

export async function removeServer(id: string): Promise<Db> {
  const db = await loadDb();
  db.servers = db.servers.filter((s) => s.id !== id);
  if (db.defaults.source === id) delete db.defaults.source;
  if (db.defaults.target === id) delete db.defaults.target;
  await saveDb(db);
  return db;
}

export async function getServer(id: string): Promise<Server | undefined> {
  const db = await loadDb();
  return db.servers.find((s) => s.id === id);
}

export async function setDefault(
  role: ServerRole,
  serverId: string
): Promise<Db> {
  const db = await loadDb();
  const s = db.servers.find((x) => x.id === serverId);
  if (!s) throw new Error(`Server ${serverId} no encontrado.`);
  if (!s.roles.includes(role)) s.roles.push(role);
  db.defaults[role] = serverId;
  await saveDb(db);
  return db;
}

export async function touchLastUsed(id: string): Promise<void> {
  const db = await loadDb();
  const s = db.servers.find((x) => x.id === id);
  if (!s) return;
  s.lastUsedAt = new Date().toISOString();
  await saveDb(db);
}

export async function getDefaultFor(
  role: ServerRole
): Promise<Server | undefined> {
  const db = await loadDb();
  const id = db.defaults[role];
  if (!id) {
    const candidates = db.servers.filter((s) => s.roles.includes(role));
    return candidates[0];
  }
  return db.servers.find((s) => s.id === id);
}

export async function listServers(): Promise<Server[]> {
  const db = await loadDb();
  return db.servers;
}

export async function listServersForRole(role: ServerRole): Promise<Server[]> {
  const db = await loadDb();
  return db.servers.filter((s) => s.roles.includes(role));
}

export async function wipeDb(): Promise<void> {
  await saveDb(emptyDb());
}

async function migrateLegacy(): Promise<Db> {
  const legacy = path.join(DATA_DIR, "config.json");
  let raw: any;
  try {
    raw = JSON.parse(await fs.readFile(legacy, "utf8"));
  } catch {
    return emptyDb();
  }
  const db = emptyDb();
  if (raw.source && (raw.source.dokploy || raw.source.ssh)) {
    db.servers.push(toServer("hostinger", "Hostinger (legacy)", raw.source, ["source"]));
    db.defaults.source = "hostinger";
  }
  if (raw.target && (raw.target.dokploy || raw.target.ssh)) {
    db.servers.push(toServer("contabo", "Contabo (legacy)", raw.target, ["target"]));
    db.defaults.target = "contabo";
  }
  if (db.servers.length > 0) {
    await saveDb(db);
    process.stdout.write(
      `Migrada config.json vieja -> ${db.servers.length} server(s) en db.json.\n`
    );
  }
  return db;
}

function toServer(
  id: string,
  label: string,
  raw: any,
  roles: Server["roles"]
): Server {
  return {
    id,
    label,
    dokploy: {
      url: raw.dokploy?.url ?? "",
      apiKey: raw.dokploy?.apiKey ?? "",
    },
    ssh: {
      host: raw.ssh?.host ?? "",
      port: raw.ssh?.port ?? 22,
      username: raw.ssh?.username ?? "root",
      privateKeyPath: raw.ssh?.privateKeyPath,
      passphrase: raw.ssh?.passphrase,
    },
    roles,
    createdAt: new Date().toISOString(),
  };
}

export function slugifyId(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "server"
  );
}
