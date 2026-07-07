/**
 * Render-only test: imprime el estado de la BD + el banner + la tabla,
 * tal y como aparecerian al iniciar el TUI, sin entrar al REPL.
 *
 * npx tsx src/dev-tui-render.ts
 */
import chalk from "chalk";
import { loadDb, getDbPath } from "./db.js";
import { renderServersTable } from "./ui-render.js";

async function main() {
  const db = await loadDb();
  const servers = db.servers;

  // Banner
  const innerW = 64;
  const line = "─".repeat(innerW - 2);
  console.log("\n" + chalk.bold.cyan(`╭${line}╮`));
  console.log(
    chalk.bold.cyan("│") +
      "  " +
      chalk.bold("migrate-dokploy".padEnd(innerW - 2)) +
      chalk.bold.cyan("│")
  );
  console.log(
    chalk.bold.cyan("│") +
      "  " +
      chalk.gray("Multi-server backup + restore for Dokploy".padEnd(innerW - 2)) +
      chalk.bold.cyan("│")
  );
  console.log(
    chalk.bold.cyan("│") +
      "  " +
      chalk.dim("migrate-dokploy".padEnd(innerW - 2)) +
      chalk.bold.cyan("│")
  );
  console.log(chalk.bold.cyan(`╰${line}╯\n`));

  // Servers
  console.log(chalk.bold("Servidores registrados"));
  console.log(chalk.gray("─".repeat(56)));
  if (servers.length === 0) {
    console.log(
      chalk.yellow(
        "  Aun no hay servidores. Entra a 'Servidores' y agrega uno.\n"
      )
    );
  } else {
    console.log(renderServersTable(servers, db.defaults) + "\n");
  }

  // Bundles
  console.log(chalk.bold("\nBundles en ./backups"));
  console.log(chalk.gray("─".repeat(56)));
  console.log(chalk.gray("  (ninguno aun)\n"));

  // Menu (preview)
  console.log(chalk.bold("Menu principal"));
  console.log(chalk.gray("─".repeat(56)));
  const items = [
    { k: "📦 Backup automatico", d: "todo el VPS Viejo → bundle → VPS Nuevo (sin pausar)" },
    { k: "📦 Backup guiado", d: "te pregunto que incluir por cada servicio" },
    { k: "🔧 Backup DEBUG paso a paso", d: "confirma cada operacion antes de ejecutarla" },
    { k: "📥 Restore", d: "restaurar un bundle guardado al VPS Nuevo" },
    { k: "🔧 Restore DEBUG paso a paso", d: "confirma cada servicio/volumen/dump antes" },
    { k: "📋 Servidores", d: "agregar, listar, editar, eliminar, probar conexion" },
    { k: "📊 Bundles", d: "ver / restaurar / borrar bundles existentes" },
    { k: "🔌 Probar conexion SSH", d: "elegir un server y verificar conectividad + Docker" },
    { k: "↻ Refrescar estado", d: "volver a leer la BD" },
    { k: "❌ Salir", d: "salir" },
  ];
  for (const it of items) {
    const k = it.k.padEnd(34);
    console.log(`  ${chalk.cyan(k)}${chalk.gray(it.d)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
