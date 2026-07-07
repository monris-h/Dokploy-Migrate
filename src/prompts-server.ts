import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  pInput,
  pPassword,
  pConfirm,
  pSelect,
  pCheckbox,
} from "./prompts.js";
import type { Server, ServerRole } from "./db.js";

export type ServerDraft = Server;

export async function wizardServer(opts: {
  defaults?: Partial<Server>;
  takenIds: string[];
}): Promise<ServerDraft> {
  const def = opts.defaults ?? {};

  let id = def.id ?? "";
  if (!id) {
    id = (await pInput({
      message: "ID corto del server (sin espacios, ej: hostinger, contabo, do-nyc-1):",
      default: "",
      validate: (v: string) => {
        if (!v) return "Obligatorio";
        if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(v))
          return "Solo letras minusculas, digitos y guiones";
        if (opts.takenIds.includes(v)) return `El id "${v}" ya existe. Usa otro.`;
        return true;
      },
    })).trim();
  }

  const label = await pInput({
    message: "Nombre humano del server (ej: Hostinger OneFit):",
    default: def.label ?? id,
    validate: (v) => (v ? true : "Obligatorio"),
  });

  const url = await pInput({
    message: "URL del panel Dokploy:",
    default: def.dokploy?.url,
    validate: (v: string) => {
      if (!v) return "Obligatoria";
      if (!/^https?:\/\//.test(v)) return "Debe empezar por http(s)://";
      return true;
    },
  });
  const apiKey = await pPassword("API key de Dokploy:");
  if (!apiKey) throw new Error("API key obligatoria.");

  const host = await pInput({
    message: "Host/IP del VPS:",
    default: def.ssh?.host,
    validate: (v) => (v ? true : "Obligatorio"),
  });
  const portStr = await pInput({
    message: "Puerto SSH:",
    default: String(def.ssh?.port ?? 22),
    validate: (v) => (/^\d+$/.test(v) ? true : "Numero"),
  });
  const username = await pInput({
    message: "Usuario SSH:",
    default: def.ssh?.username ?? "root",
  });
  const wantsKey = await pConfirm({
    message: `Tienes una SSH key en este PC?`,
    default: true,
  });
  let privateKeyPath: string | undefined;
  let password: string | undefined;
  let passphrase: string | undefined;
  if (wantsKey) {
    privateKeyPath = await pInput({
      message: "Ruta a la SSH private key:",
      default: def.ssh?.privateKeyPath ?? path.join(os.homedir(), ".ssh", "id_rsa"),
    });
    if (!existsSync(privateKeyPath)) {
      throw new Error(`No encuentro la key en ${privateKeyPath}`);
    }
    const hasPassphrase = await pConfirm({
      message: `La key "${path.basename(privateKeyPath)}" esta cifrada (passphrase)?`,
      default: !!def.ssh?.passphrase,
    });
    if (hasPassphrase) {
      passphrase = await pPassword("Passphrase de la key:");
    }
  } else {
    password = await pPassword(`Password SSH para ${username}@${host}:`);
    if (!password) throw new Error("Password obligatoria.");
  }

  const rolesChoices: { name: string; value: ServerRole; checked?: boolean }[] = [
    {
      name: "source (VPS del que quiero sacar backups)",
      value: "source",
      checked: def.roles?.includes("source") ?? true,
    },
    {
      name: "target (VPS al que quiero importar)",
      value: "target",
      checked: def.roles?.includes("target") ?? false,
    },
  ];
  const roles = await pCheckbox<ServerRole>({
    message: "Para que roles sirve este server?",
    choices: rolesChoices,
    validate: (chosen) =>
      chosen.length === 0 ? "Selecciona al menos un rol" : true,
  });

  return {
    id,
    label,
    dokploy: { url: url.replace(/\/+$/, ""), apiKey },
    ssh: {
      host,
      port: parseInt(portStr, 10),
      username,
      privateKeyPath,
      passphrase,
    },
    roles,
    createdAt: def.createdAt ?? new Date().toISOString(),
    lastUsedAt: def.lastUsedAt,
  };
}

export async function quickEditServer(
  server: Server,
  _takenIds: string[]
): Promise<Server> {
  const field = await pSelect<
    | "label"
    | "url"
    | "sshHost"
    | "sshUser"
    | "sshPort"
    | "apiKey"
    | "keyPath"
    | "passphrase"
    | "removePassphrase"
    | "roles"
    | "cancel"
  >({
    message: `Que campo quieres editar de "${server.label}"?`,
    choices: [
      { name: "Label / nombre", value: "label" },
      { name: "URL del panel Dokploy", value: "url" },
      { name: "API key de Dokploy", value: "apiKey" },
      { name: "Host SSH", value: "sshHost" },
      { name: "Puerto SSH", value: "sshPort" },
      { name: "Usuario SSH", value: "sshUser" },
      { name: "Ruta SSH key", value: "keyPath" },
      {
        name: server.ssh.passphrase ? "Passphrase de la key (cambiar)" : "Passphrase de la key (agregar)",
        value: "passphrase",
      },
      ...(server.ssh.passphrase
        ? [{ name: "Passphrase de la key (borrar)", value: "removePassphrase" as const }]
        : []),
      { name: "Roles (source/target)", value: "roles" },
      { name: "Cancelar", value: "cancel" },
    ],
  });

  const next: Server = JSON.parse(JSON.stringify(server));

  switch (field) {
    case "label":
      next.label = await pInput({ message: "Nuevo label:", default: server.label });
      break;
    case "url":
      next.dokploy.url = (
        await pInput({
          message: "Nueva URL del panel:",
          default: server.dokploy.url,
          validate: (v: string) =>
            /^https?:\/\//.test(v) ? true : "Debe empezar por http(s)://",
        })
      ).replace(/\/+$/, "");
      break;
    case "apiKey":
      next.dokploy.apiKey = await pPassword("Nueva API key de Dokploy:");
      if (!next.dokploy.apiKey) throw new Error("API key no puede ser vacia.");
      break;
    case "sshHost":
      next.ssh.host = await pInput({ message: "Nuevo host SSH:", default: server.ssh.host });
      break;
    case "sshPort":
      next.ssh.port = parseInt(
        await pInput({
          message: "Nuevo puerto SSH:",
          default: String(server.ssh.port),
          validate: (v: string) => (/^\d+$/.test(v) ? true : "Numero"),
        }),
        10
      );
      break;
    case "sshUser":
      next.ssh.username = await pInput({
        message: "Nuevo usuario SSH:",
        default: server.ssh.username,
      });
      break;
    case "keyPath":
      next.ssh.privateKeyPath = await pInput({
        message: "Nueva ruta de SSH key:",
        default: server.ssh.privateKeyPath ?? "",
      });
      if (!existsSync(next.ssh.privateKeyPath ?? "")) {
        throw new Error(`No encuentro la key en ${next.ssh.privateKeyPath}`);
      }
      delete next.ssh.password;
      break;
    case "passphrase":
      next.ssh.passphrase = await pPassword("Passphrase de la key:");
      if (!next.ssh.passphrase) throw new Error("Passphrase no puede ser vacia.");
      break;
    case "removePassphrase":
      delete next.ssh.passphrase;
      break;
    case "roles": {
      const roles = await pCheckbox<ServerRole>({
        message: "Roles:",
        choices: [
          { name: "source", value: "source", checked: server.roles.includes("source") },
          { name: "target", value: "target", checked: server.roles.includes("target") },
        ],
        validate: (chosen) => (chosen.length === 0 ? "Al menos uno" : true),
      });
      next.roles = roles;
      break;
    }
    case "cancel":
      return server;
  }

  return next;
}
