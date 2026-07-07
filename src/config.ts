import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export type DokployConn = { url: string; apiKey: string };
export type SshConn = {
  host: string;
  port: number;
  username: string;
  privateKeyPath?: string;
};
export type ServerConfig = {
  dokploy?: DokployConn;
  ssh?: SshConn;
};

export type PersistedConfig = {
  source: ServerConfig;
  target: ServerConfig;
};

const CONFIG_DIR = path.join(os.homedir(), ".migrate-dokploy");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

function freshConfig(): PersistedConfig {
  return { source: {}, target: {} };
}

export async function loadConfig(): Promise<PersistedConfig> {
  let raw: any = {};
  try {
    raw = JSON.parse(await fs.readFile(CONFIG_FILE, "utf8"));
  } catch {
    return freshConfig();
  }
  if (!raw.source && !raw.target) {
    const out = freshConfig();
    if (raw.dokploy) out.source.dokploy = raw.dokploy;
    if (raw.ssh) out.source.ssh = raw.ssh;
    await saveConfig(out);
    return out;
  }
  return {
    source: raw.source ?? {},
    target: raw.target ?? {},
  };
}

export async function saveConfig(cfg: PersistedConfig): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const clean: PersistedConfig = {
    source: cfg.source ?? {},
    target: cfg.target ?? {},
  };
  await fs.writeFile(CONFIG_FILE, JSON.stringify(clean, null, 2), {
    mode: 0o600,
  });
}

export async function updateSource(partial: ServerConfig): Promise<PersistedConfig> {
  const cur = await loadConfig();
  cur.source = {
    ...cur.source,
    ...partial,
    dokploy: partial.dokploy
      ? { ...(cur.source.dokploy ?? {}), ...partial.dokploy }
      : cur.source.dokploy,
    ssh: partial.ssh
      ? { ...(cur.source.ssh ?? {}), ...partial.ssh }
      : cur.source.ssh,
  };
  await saveConfig(cur);
  return cur;
}

export async function updateTarget(partial: ServerConfig): Promise<PersistedConfig> {
  const cur = await loadConfig();
  cur.target = {
    ...cur.target,
    ...partial,
    dokploy: partial.dokploy
      ? { ...(cur.target.dokploy ?? {}), ...partial.dokploy }
      : cur.target.dokploy,
    ssh: partial.ssh
      ? { ...(cur.target.ssh ?? {}), ...partial.ssh }
      : cur.target.ssh,
  };
  await saveConfig(cur);
  return cur;
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}
