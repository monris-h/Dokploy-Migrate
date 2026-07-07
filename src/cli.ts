/**
 * Entry point principal.
 *
 * Sin argumentos -> abre el TUI (menu interactivo por terminal).
 * Con argumentos -> despacha al comando correspondiente.
 */

import { runBackup } from "./commands/backup.js";
import { runRestore } from "./commands/restore.js";
import { runServers } from "./commands/servers.js";

const HELP = `
migrate-dokploy - migracion end-to-end de proyectos Dokploy (PC -> VPS Viejo -> PC -> VPS Nuevo)

Esta herramienta es READ-ONLY sobre el VPS Viejo. NO elimina nada alli. Solo
lee, baja el bundle al PC y (opcional) lo aplica en el VPS Nuevo creando cada
servicio como su propia unidad (application, postgres, etc.).

Uso:
  npm start                                 abre el TUI (menu interactivo)
  npm run migrate                           shortcut: backup + import en una corrida
  npm run backup                            backup del VPS Viejo (te pregunta al final)
  npm run backup -- --from <id> --to <id>   usa servers especificos
  npm run backup -- --auto-select           sin prompts por servicio
  npm run backup -- --auto-import           si target listo, importar sin preguntar
  npm run backup -- --yes                   --auto-select + --auto-import
  npm run backup -- --debug                 modo paso a paso con confirmaciones
  npm run restore -- --debug                modo paso a paso con confirmaciones
  npm run restore -- --file X               restaurar un bundle
  npm run servers                           listar servers
  npm run servers -- add                    wizard para registrar uno
  npm run servers -- show <id>              ver detalle
  npm run servers -- edit <id>              editar
  npm run servers -- remove <id>            eliminar
  npm run servers -- default <s|t> <id>     marcar default
  npm run servers -- reset                  borrar BD
  npm start -- --help                       mostrar esta ayuda
`;

async function main() {
  const [, , ...args] = process.argv;

  // Sin argumentos -> arrancar TUI
  if (args.length === 0) {
    const { launchTui } = await import("./tui.js");
    await launchTui();
    return;
  }

  if (args[0] === "-h" || args[0] === "--help") {
    process.stdout.write(HELP);
    return;
  }

  const cmd = args[0];
  const rest = args.slice(1);

  switch (cmd) {
    case "backup":
      await runBackup(rest);
      break;
    case "restore":
      await runRestore(rest);
      break;
    case "migrate":
      await runBackup(["--yes", ...rest]);
      break;
    case "servers":
      await runServers(rest);
      break;
    case "config": {
      const { runConfig } = await import("./commands/config.js");
      await runConfig(rest);
      break;
    }
    default:
      process.stderr.write(`Comando desconocido: ${cmd}\n${HELP}`);
      process.exitCode = 2;
  }
}

main().catch((err) => {
  if (String((err as Error).message).includes("User force closed")) {
    // Ctrl-C en prompts
    process.stdout.write("\n");
    process.exit(0);
  }
  process.stderr.write(`\nERROR: ${(err as Error).message}\n`);
  if (process.env.DEBUG) {
    process.stderr.write(`\n${(err as Error).stack}\n`);
  }
  process.exit(1);
});
