import { listServersForRole, getDefaultFor, type Server, type ServerRole } from "./db.js";
import { pSelect } from "./prompts.js";

/**
 * Resolver server de un rol. Prioridad:
 *   1) flag --from / --to explicito
 *   2) db.defaults[role]
 *   3) si hay 1 solo con ese rol -> ese
 *   4) si hay varios -> prompt
 *   5) si no hay -> null (caller decide)
 */
export function findArgServerId(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === flag || a === `${flag}=`) {
      const next = args[i + 1];
      if (next) return next;
    } else if (a.startsWith(`${flag}=`)) {
      return a.slice(flag.length + 1);
    }
  }
  return undefined;
}

export async function pickServer(
  args: string[],
  role: ServerRole
): Promise<Server | null> {
  const flag = role === "source" ? "--from" : "--to";
  const explicitId = findArgServerId(args, flag);
  if (explicitId) {
    const { getServer } = await import("./db.js");
    const s = await getServer(explicitId);
    if (!s) {
      throw new Error(
        `Server con id "${explicitId}" no existe. Usa: npm run servers -- add`
      );
    }
    if (!s.roles.includes(role)) {
      throw new Error(
        `Server "${explicitId}" no tiene rol "${role}" (tiene: ${s.roles.join(", ") || "ninguno"}). Edita el server: npm run servers -- edit ${explicitId}`
      );
    }
    return s;
  }
  const def = await getDefaultFor(role);
  if (def && def.roles.includes(role)) {
    return def;
  }
  const candidates = await listServersForRole(role);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  return pSelect<Server>({
    message: `Elige el server ${role}:`,
    choices: candidates.map((s) => ({
      name: `${s.id}  -  ${s.label}  (${s.dokploy.url})`,
      value: s,
    })),
  });
}

/**
 * Validacion dura: source y target deben ser servers distintos.
 */
export function ensureDistinctServers(
  source: Server | null,
  target: Server | null
): void {
  if (source && target && source.id === target.id) {
    throw new Error(
      `El server source y target son el mismo (${source.id}). Source y target deben ser servers distintos. Ve a: npm run servers -- edit ${source.id} y agrega el rol faltante.`
    );
  }
}

export async function offerAddServer(role: ServerRole): Promise<Server | null> {
  const ans = await pSelect<"add" | "cancel">({
    message: `No hay servers ${role} registrados. Que quieres hacer?`,
    choices: [
      { name: "Registrar un nuevo server ahora", value: "add" },
      { name: "Cancelar", value: "cancel" },
    ],
  });
  if (ans === "cancel") return null;

  const { wizardServer } = await import("./prompts-server.js");
  const { loadDb, upsertServer, setDefault } = await import("./db.js");
  const db = await loadDb();
  const draft = await wizardServer({
    defaults: {},
    takenIds: db.servers.map((s) => s.id),
  });
  await upsertServer(draft);
  if (draft.roles.length === 1 && !draft.roles.includes(role)) {
    draft.roles.push(role);
    await upsertServer(draft);
  }
  await setDefault(role, draft.id);
  return (await loadDb()).servers.find((s) => s.id === draft.id) ?? draft;
}
