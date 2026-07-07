/**
 * Comando `config` ahora es un wrapper sobre la BD multi-server.
 * Conserva los subcomandos viejos --show / --reset apuntando a la db.json.
 */

import { pConfirm } from "../prompts.js";
import { getDbPath, loadDb, wipeDb } from "../db.js";
import { log } from "../ui.js";
import { renderServersTable } from "../ui-render.js";

export async function runConfig(args: string[]): Promise<void> {
  const action = args[0] ?? "--show";
  switch (action) {
    case "--show":
    case "show": {
      const db = await loadDb();
      log.info(`BD: ${getDbPath()}`);
      process.stdout.write(renderServersTable(db.servers, db.defaults));
      return;
    }
    case "--reset":
    case "reset": {
      const ok = await pConfirm({
        message: "Borrar TODA la BD de servers (API keys, SSH guardadas)?",
        default: false,
      });
      if (ok) {
        await wipeDb();
        log.ok("BD borrada.");
      } else {
        log.out("Cancelado.");
      }
      return;
    }
    default:
      process.stderr.write(
        `Subcomando desconocido: ${action}\n  --show | show   Ver config\n  --reset | reset  Borrar BD\n`
      );
      process.exitCode = 2;
  }
}
