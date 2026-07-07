import { input, password, confirm, select, checkbox } from "@inquirer/prompts";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Prompts normalizados para flujos del CLI. Cada uno cancela con Ctrl-C
 * sin tirar stack - el caller decide que hacer.
 */

export async function pInput(opts: Parameters<typeof input>[0]): Promise<string> {
  return input(opts);
}

export async function pPassword(message: string, mask = "*"): Promise<string> {
  return password({ message, mask });
}

export async function pConfirm(opts: Parameters<typeof confirm>[0]): Promise<boolean> {
  return confirm(opts);
}

export async function pSelect<T>(opts: Parameters<typeof select<T>>[0]): Promise<T> {
  return select<T>(opts);
}

export async function pCheckbox<T>(
  opts: Parameters<typeof checkbox<T>>[0]
): Promise<T[]> {
  return checkbox<T>(opts);
}

// ---------------------------------------------------------------
//  Dokploy (Source / Target)
// ---------------------------------------------------------------

type DokployConn = { url?: string; apiKey?: string };

async function askDokployConn(
  label: string,
  cached: DokployConn
): Promise<{ url: string; apiKey: string }> {
  const envUrlKey = label === "source" ? "DOKPLOY_URL" : "DOKPLOY_TARGET_URL";
  const envKeyKey = label === "source" ? "DOKPLOY_API_KEY" : "DOKPLOY_TARGET_API_KEY";

  let url = process.env[envUrlKey] ?? cached.url ?? "";
  let apiKey = process.env[envKeyKey] ?? cached.apiKey ?? "";

  if (!url) {
    url = await pInput({
      message: `URL de Dokploy ${label === "source" ? "(Hostinger)" : "(Contabo destino)"}:`,
      validate: (v: string) => {
        if (!v) return "La URL es obligatoria";
        if (!/^https?:\/\//.test(v)) return "Debe empezar por http:// o https://";
        return true;
      },
    });
    process.stdout.write("\n");
  } else {
    process.stdout.write(`URL Dokploy ${label}: ${url} (de config/env)\n`);
  }

  if (!apiKey) {
    apiKey = await pPassword(`API key de Dokploy ${label}:`);
    if (!apiKey) throw new Error("La API key es obligatoria.");
  }

  return { url: url.replace(/\/+$/, ""), apiKey };
}

export async function askSourceDokploy(
  cached: DokployConn
): Promise<{ url: string; apiKey: string }> {
  return askDokployConn("source", cached);
}

export async function askTargetDokploy(
  cached: DokployConn
): Promise<{ url: string; apiKey: string }> {
  return askDokployConn("target", cached);
}

// ---------------------------------------------------------------
//  SSH (Source / Target)
// ---------------------------------------------------------------

type SshConn = {
  host?: string;
  username?: string;
  port?: number;
  privateKeyPath?: string;
};

type SshFinal = {
  host: string;
  port: number;
  username: string;
  privateKeyPath?: string;
  password?: string;
};

export async function askSsh(
  label: "source" | "target",
  cached: SshConn
): Promise<SshFinal> {
  const hostEnv = label === "source" ? "SSH_HOST" : "SSH_TARGET_HOST";
  const userEnv = label === "source" ? "SSH_USER" : "SSH_TARGET_USER";
  const portEnv = label === "source" ? "SSH_PORT" : "SSH_TARGET_PORT";
  const keyEnv =
    label === "source" ? "SSH_PRIVATE_KEY_PATH" : "SSH_TARGET_PRIVATE_KEY_PATH";

  const username = process.env[userEnv] ?? cached.username ?? "root";
  const port = parseInt(process.env[portEnv] ?? String(cached.port ?? 22), 10);
  const host = process.env[hostEnv] ?? cached.host ?? "";

  if (!host) {
    const h = await pInput({
      message: `Host/IP del VPS ${label === "source" ? "Hostinger (origen)" : "Contabo (destino)"}:`,
      validate: (v: string) => (v ? true : "Obligatorio"),
    });
    return finalizeSsh(h, username, port, cached, keyEnv);
  }

  process.stdout.write(
    `SSH ${label}: ${username}@${host}:${port} (de config/env)\n`
  );
  return finalizeSsh(host, username, port, cached, keyEnv);
}

async function finalizeSsh(
  host: string,
  username: string,
  port: number,
  cached: SshConn,
  keyEnv: string
): Promise<SshFinal> {
  let privateKeyPath = process.env[keyEnv] ?? cached.privateKeyPath ?? "";

  if (!privateKeyPath) {
    const defaultKey = path.join(os.homedir(), ".ssh", "id_rsa");
    const wantsKey = await pConfirm({
      message: `Tienes una SSH key (default: ${defaultKey})?`,
      default: existsSync(defaultKey),
    });
    if (wantsKey) {
      const typed = await pInput({
        message: "Ruta a la SSH private key:",
        default: defaultKey,
      });
      if (!existsSync(typed)) {
        throw new Error(`No encuentro la key en ${typed}`);
      }
      privateKeyPath = typed;
    }
  } else if (!existsSync(privateKeyPath)) {
    process.stdout.write(
      `AVISO: la key ${privateKeyPath} no existe - te voy a pedir password.\n`
    );
    privateKeyPath = "";
  }

  let password: string | undefined;
  if (!privateKeyPath) {
    password = await pPassword(`Password SSH para ${username}@${host}:`);
  }

  return { host, username, port, privateKeyPath, password };
}
