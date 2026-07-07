import {
  loadDb,
  listServers,
  getServer,
  upsertServer,
  removeServer,
  setDefault,
  getDbPath,
  wipeDb,
  type Server,
} from "../db.js";
import {
  pInput,
  pConfirm,
  pSelect,
} from "../prompts.js";
import {
  wizardServer,
  quickEditServer,
} from "../prompts-server.js";
import { log } from "../ui.js";
import { renderServersTable, renderServerDetail } from "../ui-render.js";

/**
 * Comando `servers`:
 *   npm run servers                                 -> list
 *   npm run servers -- add                          -> wizard
 *   npm run servers -- show <id>
 *   npm run servers -- edit <id>
 *   npm run servers -- remove <id>
 *   npm run servers -- default source <id>
 *   npm run servers -- default target <id>
 *   npm run servers -- reset                        -> borra todo
 */

export async function runServers(args: string[]): Promise<void> {
  const action = args[0] ?? "list";
  const target = args[1];
  const extra = args[2];

  switch (action) {
    case "list":
    case "ls": {
      const servers = await listServers();
      const db = await loadDb();
      process.stdout.write(renderServersTable(servers, db.defaults));
      process.stdout.write(
        `\nPath: ${getDbPath()}\n` +
          `Total: ${servers.length} server(s)\n` +
          `Comandos:\n` +
          `  npm run servers -- add                  registrar uno nuevo\n` +
          `  npm run servers -- show <id>           ver detalle\n` +
          `  npm run servers -- edit <id>           editar campos\n` +
          `  npm run servers -- remove <id>         eliminar\n` +
          `  npm run servers -- default <source|target> <id>\n`
      );
      return;
    }

    case "add": {
      const db = await loadDb();
      const takenIds = db.servers.map((s) => s.id);
      let draft: Server | null = null;
      try {
        draft = await wizardServer({ defaults: {}, takenIds });
      } catch (e) {
        log.warn(`Wizard cancelado: ${(e as Error).message}`);
        return;
      }
      if (!draft) return;
      const updated = await upsertServer(draft);
      log.ok(`Server "${draft.id}" guardado.`);

      // pregunta si marcar como default source y/o target
      if (draft.roles.includes("source")) {
        const y = await pConfirm({
          message: `Marcar "${draft.id}" como default source?`,
          default: !updated.defaults.source,
        });
        if (y) await setDefault("source", draft.id);
      }
      if (draft.roles.includes("target")) {
        const y = await pConfirm({
          message: `Marcar "${draft.id}" como default target?`,
          default: !updated.defaults.target,
        });
        if (y) await setDefault("target", draft.id);
      }
      log.ok(`Listo. Puedes usarlo en:  npm run backup -- --from ${draft.id}`);
      return;
    }

    case "show": {
      const id = target;
      if (!id) {
        log.err("Falta el id. Ej: npm run servers -- show hostinger");
        process.exitCode = 2;
        return;
      }
      const s = await getServer(id);
      if (!s) {
        log.err(`Server "${id}" no encontrado.`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(renderServerDetail(s));
      return;
    }

    case "edit": {
      const id = target;
      if (!id) {
        log.err("Falta el id. Ej: npm run servers -- edit hostinger");
        process.exitCode = 2;
        return;
      }
      const s = await getServer(id);
      if (!s) {
        log.err(`Server "${id}" no encontrado.`);
        process.exitCode = 1;
        return;
      }
      const next = await quickEditServer(s, (await loadDb()).servers.map((x) => x.id));
      await upsertServer(next);
      log.ok(`Server "${id}" actualizado.`);
      return;
    }

    case "remove":
    case "rm": {
      const id = target;
      if (!id) {
        log.err("Falta el id. Ej: npm run servers -- remove contabo");
        process.exitCode = 2;
        return;
      }
      const s = await getServer(id);
      if (!s) {
        log.err(`Server "${id}" no encontrado.`);
        process.exitCode = 1;
        return;
      }
      const ok = await pConfirm({
        message: `Eliminar server "${s.label}" (${id})? Esto borra API key y SSH guardadas.`,
        default: false,
      });
      if (!ok) {
        log.out("Cancelado.");
        return;
      }
      await removeServer(id);
      log.ok(`Server "${id}" eliminado.`);
      return;
    }

    case "default": {
      const roleRaw = target;
      const id = extra;
      const role: "source" | "target" | undefined =
        roleRaw === "source" || roleRaw === "target" ? roleRaw : undefined;
      if (!role || !id) {
        log.err("Uso: npm run servers -- default <source|target> <id>");
        process.exitCode = 2;
        return;
      }
      await setDefault(role, id);
      log.ok(`Default ${role} -> ${id}`);
      return;
    }

    case "reset": {
      const ok = await pConfirm({
        message:
          "Borrar TODA la BD de servers (API keys, SSH keys guardadas)?",
        default: false,
      });
      if (!ok) {
        log.out("Cancelado.");
        return;
      }
      await wipeDb();
      log.ok("BD de servers borrada.");
      return;
    }

    default:
      process.stderr.write(
        `Subcomando desconocido: ${action}\n` +
          `Usa: list | add | show <id> | edit <id> | remove <id> | default <source|target> <id> | reset\n`
      );
      process.exitCode = 2;
  }
}
