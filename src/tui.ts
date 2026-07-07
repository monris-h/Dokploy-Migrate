import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { select, input, confirm } from "@inquirer/prompts";
import {
  listServers,
  getServer,
  loadDb,
  getDbPath,
  setDefault,
  removeServer,
  touchLastUsed,
  upsertServer,
  type Server,
} from "./db.js";
import { runBackup } from "./commands/backup.js";
import { runRestoreFlow } from "./commands/restore.js";
import { renderServersTable, renderServerDetail } from "./ui-render.js";
import { renderManifest } from "./ui-bundle.js";
import { log } from "./ui.js";
import { wizardServer, quickEditServer } from "./prompts-server.js";
import { setDebugMode, resetDebugMode } from "./step.js";
import { Ssh } from "./ssh.js";

type Crumb = { label: string };

function breadcrumb(crumbs: Crumb[]): string {
  if (crumbs.length === 0) return "migrate-dokploy";
  return "migrate-dokploy › " + crumbs.map((c) => c.label).join(" › ");
}

function banner(
  title: string,
  subtitle?: string,
  crumbs: Crumb[] = []
): void {
  const innerW = 64;
  const line = "─".repeat(innerW - 2);
  const pad = (s: string, color: (x: string) => string = (x) => x) =>
    color(s).padEnd(innerW - 2);

  process.stdout.write("\n");
  process.stdout.write(chalk.bold.cyan(`╭${line}╮\n`));
  process.stdout.write(
    chalk.bold.cyan("│") + "  " + pad(title, chalk.bold) + chalk.bold.cyan("│\n")
  );
  if (subtitle) {
    process.stdout.write(
      chalk.bold.cyan("│") +
        "  " +
        pad(subtitle, chalk.gray) +
        chalk.bold.cyan("│\n")
    );
  }
  if (crumbs.length > 0) {
    process.stdout.write(
      chalk.bold.cyan("│") +
        "  " +
        pad(breadcrumb(crumbs), chalk.dim) +
        chalk.bold.cyan("│\n")
    );
  }
  process.stdout.write(chalk.bold.cyan(`╰${line}╯\n`));
}

function separator(): void {
  process.stdout.write(
    chalk.gray("\n────────────────────────────────────────────────────────────\n")
  );
}

function sectionHeader(text: string): void {
  process.stdout.write("\n" + chalk.bold(text) + "\n");
  process.stdout.write(chalk.gray("─".repeat(56) + "\n"));
}

function out(s: string): void {
  process.stdout.write(s);
}

export async function launchTui(): Promise<void> {
  while (true) {
    const action = await mainMenu();
    switch (action) {
      case "backup_full":
        await runFlow("Backup automatico", async () => {
          resetDebugMode();
          await runBackup(["--yes"]);
        });
        break;
      case "backup_guided":
        await runFlow("Backup guiado", async () => {
          resetDebugMode();
          await runBackup([]);
        });
        break;
      case "backup_debug":
        await runFlow("Backup DEBUG paso a paso", async () => {
          setDebugMode(true);
          await runBackup(["--debug"]);
        });
        break;
      case "restore":
        await runFlow("Restore automatico", async () => {
          resetDebugMode();
          await runRestoreFlow({ parseArgs: [] });
        });
        break;
      case "restore_debug":
        await runFlow("Restore DEBUG paso a paso", async () => {
          setDebugMode(true);
          await runRestoreFlow({ parseArgs: ["--debug"] });
        });
        break;
      case "servers":
        await serversSubmenu();
        break;
      case "bundles":
        await bundlesSubmenu();
        break;
      case "test_connection":
        await testConnectionFlow();
        break;
      case "show_status":
        await showStatus(true);
        await anyKey();
        break;
      case "quit":
        log.out("Bye!");
        return;
    }
  }
}

async function mainMenu(): Promise<MainAction> {
  banner(
    "migrate-dokploy",
    "Multi-server backup + restore for Dokploy",
    []
  );
  await showStatus(false);
  return select<MainAction>({
    message: "¿Que quieres hacer?",
    choices: [
      {
        name: chalk.bold("Backup automatico") +
          chalk.gray("  todo el VPS Viejo → bundle → VPS Nuevo (sin pausar)"),
        value: "backup_full",
      },
      {
        name: chalk.bold("Backup guiado") +
          chalk.gray("  te pregunto que incluir por cada servicio"),
        value: "backup_guided",
      },
      {
        name: chalk.yellow("Backup DEBUG paso a paso") +
          chalk.gray("  confirma cada operacion antes de ejecutarla (mas seguro)"),
        value: "backup_debug",
      },
      {
        name: chalk.bold("Restore") +
          chalk.gray("  restaurar un bundle guardado al VPS Nuevo"),
        value: "restore",
      },
      {
        name: chalk.yellow("Restore DEBUG paso a paso") +
          chalk.gray("  confirma cada servicio/volumen/dump antes (mas seguro)"),
        value: "restore_debug",
      },
      { name: chalk.gray("─".repeat(56)), value: "show_status" },
      {
        name: chalk.bold("Servidores") +
          chalk.gray("  agregar, listar, editar, eliminar, probar conexion"),
        value: "servers",
      },
      {
        name: chalk.bold("Bundles") +
          chalk.gray("  ver / restaurar / borrar bundles existentes"),
        value: "bundles",
      },
      {
        name: chalk.bold("Probar conexion SSH") +
          chalk.gray("  elegir un server y verificar conectividad + Docker"),
        value: "test_connection",
      },
      { name: chalk.gray("↻  Refrescar estado"), value: "show_status" },
      { name: chalk.red("Salir"), value: "quit" },
    ],
    pageSize: 16,
  });
}

type MainAction =
  | "backup_full"
  | "backup_guided"
  | "backup_debug"
  | "restore"
  | "restore_debug"
  | "servers"
  | "bundles"
  | "test_connection"
  | "show_status"
  | "quit";

async function showStatus(verbose: boolean): Promise<void> {
  const db = await loadDb();
  const servers = db.servers;

  sectionHeader("Servidores registrados");
  if (servers.length === 0) {
    process.stdout.write(
      chalk.yellow(
        "  Aun no hay servidores. Entra a 'Servidores' y agrega uno.\n"
      )
    );
  } else {
    process.stdout.write(renderServersTable(servers, db.defaults) + "\n");
    if (verbose) {
      process.stdout.write(chalk.gray(`\nPath BD: ${getDbPath()}\n`));
    }
  }

  const files = await listBundleFiles();
  sectionHeader("Bundles en ./backups");
  if (files.length === 0) {
    process.stdout.write(chalk.gray("  (ninguno aun)\n"));
  } else {
    let total = 0;
    for (const f of files) {
      total += f.size;
      process.stdout.write(
        `  ${chalk.cyan(f.name.padEnd(48))}  ${chalk.gray(
          humanBytes(f.size) + "  " + f.mtime.toISOString().slice(0, 19).replace("T", " ")
        )}\n`
      );
    }
    process.stdout.write(
      chalk.dim(`  (${files.length} bundle(s), total ${humanBytes(total)})\n`)
    );
  }
}

async function testConnectionFlow(): Promise<void> {
  out(chalk.cyan("\n[test-connection] iniciando...\n"));
  const servers = await listServers();
  if (servers.length === 0) {
    out(chalk.yellow("  No hay servers registrados. Agrega uno primero.\n"));
    await anyKey();
    return;
  }
  const id = await selectServerId(servers, "Cual server quieres probar?");
  if (!id) return;
  const server = await getServer(id);
  if (!server) return;

  banner("Probar conexion SSH", undefined, [
    { label: "Servidores" },
    { label: `Probar ${server.label}` },
  ]);
  out(`Target:  ${server.ssh.username}@${server.ssh.host}:${server.ssh.port ?? 22}\n`);
  out(
    `Auth:    ${
      server.ssh.privateKeyPath
        ? `key ${server.ssh.privateKeyPath}`
        : "password (te la voy a pedir)"
    }\n\n`
  );

  let passwordSsh: string | undefined;
  let privateKeyPath = server.ssh.privateKeyPath;
  let passphrase = server.ssh.passphrase;
  if (privateKeyPath && !existsSync(privateKeyPath)) {
    out(chalk.yellow(`  La key ${privateKeyPath} no esta accesible. Pido password.\n`));
    privateKeyPath = undefined;
  }
  if (!privateKeyPath) {
    const { pPassword } = await import("./prompts.js");
    passwordSsh = await pPassword(
      `Password SSH para ${server.ssh.username}@${server.ssh.host}:`
    );
  }

  const t0 = Date.now();
  let ssh: Ssh | null = null;
  let lastErr: string | undefined;

  // Intento 1: con lo que tenemos (passphrase guardada o vacia)
  out(chalk.cyan("  -> Creando conexion SSH...\n"));
  {
    const trySsh = new Ssh({
      host: server.ssh.host,
      port: server.ssh.port ?? 22,
      username: server.ssh.username,
      privateKeyPath,
      passphrase,
      password: passwordSsh,
    });
    try {
      await trySsh.connect();
      ssh = trySsh;
    } catch (e) {
      lastErr = (e as Error).message;
    }
  }

  // Si fallo por passphrase y no tenemos una, la pedimos y reintentamos
  if (!ssh && lastErr && /passphrase|Encrypted/i.test(lastErr) && !passphrase) {
    out(chalk.yellow(`  La key esta cifrada. Necesito la passphrase.\n`));
    const { pPassword } = await import("./prompts.js");
    passphrase = await pPassword("Passphrase de la key:");
    if (passphrase) {
      out(chalk.cyan("  -> Reintentando con passphrase...\n"));
      const trySsh = new Ssh({
        host: server.ssh.host,
        port: server.ssh.port ?? 22,
        username: server.ssh.username,
        privateKeyPath,
        passphrase,
        password: passwordSsh,
      });
      try {
        await trySsh.connect();
        ssh = trySsh;
        // Ofrecer guardar la passphrase en el server
        const { confirm } = await import("@inquirer/prompts");
        const save = await confirm({
          message: `Conexion OK. Guardar la passphrase en este server (db.json)? Asi no te la pido cada vez.`,
          default: true,
        });
        if (save) {
          server.ssh.passphrase = passphrase;
          const { upsertServer } = await import("./db.js");
          await upsertServer(server);
          out(chalk.green("  Passphrase guardada en este server.\n"));
        }
      } catch (e) {
        lastErr = (e as Error).message;
      }
    }
  }

  if (!ssh) {
    out(chalk.red(`  FAIL: ${lastErr}\n`));
    out(chalk.gray(`    Tip: revisa que la key existe, el puerto es correcto, y el server permite SSH.\n`));
    await anyKey();
    return;
  }
  out(chalk.green(`  Conectado en ${Date.now() - t0}ms  (smoke test OK)\n\n`));

  sectionHeader("Informacion del host");
  await sshExecSafe(ssh, "hostname", "hostname");
  await sshExecSafe(ssh, "whoami", "user actual");
  await sshExecSafe(ssh, "uptime -p 2>/dev/null || uptime", "uptime");
  await sshExecSafe(ssh, "cat /etc/os-release | head -5", "OS");
  await sshExecSafe(ssh, "uname -r", "kernel");
  await sshExecSafe(ssh, "docker --version", "docker version");
  await sshExecSafe(
    ssh,
    "docker ps --format 'table {{.Names}}\\t{{.Status}}' 2>/dev/null | head -10",
    "containers"
  );
  await sshExecSafe(ssh, "df -h / | tail -1", "disco en /");
  await sshExecSafe(ssh, "free -h | head -2", "memoria");

  sectionHeader("Dokploy API");
  out(chalk.cyan(`  -> GET ${server.dokploy.url}/api/project.all\n`));
  try {
    const { listProjects } = await import("../lib/dokploy.js");
    const projects = await listProjects({
      url: server.dokploy.url,
      apiKey: server.dokploy.apiKey,
    });
    out(chalk.green(`  OK - ${projects.length} proyecto(s) encontrados:\n`));
    for (const p of projects.slice(0, 10)) {
      out(`    - ${p.name}\n`);
    }
    if (projects.length > 10) {
      out(chalk.gray(`    (y ${projects.length - 10} mas...)\n`));
    }
  } catch (e) {
    out(chalk.red(`  FAIL: ${(e as Error).message}\n`));
  }

  await ssh.disconnect();
  out(chalk.gray("\n  Desconectado.\n"));
  await anyKey();
}

async function sshExecSafe(
  ssh: Ssh,
  command: string,
  label: string
): Promise<void> {
  out(chalk.gray(`  ${label.padEnd(20)} `));
  try {
    const r = await ssh.exec(command);
    if (r.code !== 0) {
      out(chalk.yellow("no disponible\n"));
      return;
    }
    const trimmed = r.stdout.trim();
    const firstLine = trimmed.split(/\r?\n/)[0] ?? "";
    out(`${firstLine}\n`);
    const rest = trimmed.split(/\r?\n/).slice(1);
    for (const l of rest) {
      out(chalk.gray(`  ${" ".repeat(20)} ${l}\n`));
    }
  } catch {
    out(chalk.yellow("error\n"));
  }
}

async function serversSubmenu(): Promise<void> {
  while (true) {
    banner("Servidores", "agregar, listar, editar, probar conexion", [
      { label: "Servidores" },
    ]);
    await showStatus(false);
    separator();

    const action = await select<ServersAction>({
      message: "¿Que quieres hacer con servidores?",
      choices: [
        { name: chalk.green("+ Agregar uno nuevo (wizard)"), value: "add" },
        { name: "  Listar todos (vista detallada uno por uno)", value: "list" },
        { name: "~ Editar uno existente", value: "edit" },
        { name: chalk.cyan("Probar conexion SSH de uno"), value: "test_one" },
        { name: chalk.red("- Eliminar uno"), value: "remove" },
        { name: "* Marcar como default source", value: "default_source" },
        { name: "* Marcar como default target", value: "default_target" },
        { name: chalk.gray("<- Volver al menu principal"), value: "back" },
      ],
    });

    switch (action) {
      case "add":
        await runFlow("Servidores > Agregar", async () => {
          const db = await loadDb();
          const takenIds = db.servers.map((s) => s.id);
          try {
            const draft = await wizardServer({
              defaults: {},
              takenIds,
            });
            await upsertServer(draft);
            log.ok(`Server "${draft.id}" guardado.`);

            if (draft.roles.length > 0) {
              if (draft.roles.includes("source")) {
                if (
                  await confirm({
                    message: `Marcar "${draft.id}" como default source?`,
                    default: !db.defaults.source,
                  })
                ) {
                  await setDefault("source", draft.id);
                  log.ok(`Default source = ${draft.id}`);
                }
              }
              if (draft.roles.includes("target")) {
                if (
                  await confirm({
                    message: `Marcar "${draft.id}" como default target?`,
                    default: !db.defaults.target,
                  })
                ) {
                  await setDefault("target", draft.id);
                  log.ok(`Default target = ${draft.id}`);
                }
              }
            }
          } catch (e) {
            log.warn(`Cancelado: ${(e as Error).message}`);
          }
        });
        break;

      case "list": {
        const db = await loadDb();
        banner("Servidores > Detalle", undefined, [
          { label: "Servidores" },
          { label: "Detalle" },
        ]);
        if (db.servers.length === 0) {
          process.stdout.write(
            chalk.gray("  (no hay servers. Agrega uno primero.)\n")
          );
        } else {
          for (const s of db.servers) {
            process.stdout.write(renderServerDetail(s, db.defaults) + "\n\n");
          }
        }
        await anyKey();
        break;
      }

      case "edit":
        await runFlow("Servidores > Editar", async () => {
          const servers = await listServers();
          if (servers.length === 0) {
            log.warn("No hay servers para editar.");
            return;
          }
          const id = await selectServerId(servers, "Cual editar?");
          if (!id) return;
          const target = await getServer(id);
          if (!target) {
            log.err("Server no encontrado.");
            return;
          }
          const next = await quickEditServer(target, servers.map((x) => x.id));
          await upsertServer(next);
          log.ok(`Server "${id}" actualizado.`);
        });
        break;

      case "test_one":
        await runFlow("Servidores > Probar conexion", async () => {
          await testConnectionFlow();
        });
        break;

      case "remove":
        await runFlow("Servidores > Eliminar", async () => {
          const servers = await listServers();
          if (servers.length === 0) {
            log.warn("No hay servers para eliminar.");
            return;
          }
          const id = await selectServerId(servers, "Cual eliminar?");
          if (!id) return;
          const target = await getServer(id);
          if (!target) return;
          const ok = await confirm({
            message: `Eliminar "${target.label}" (${id})? Esto borra API key y SSH guardadas.`,
            default: false,
          });
          if (!ok) {
            log.out("Cancelado.");
            return;
          }
          await removeServer(id);
          log.ok(`Eliminado: ${id}`);
        });
        break;

      case "default_source": {
        const servers = await listServers();
        if (servers.length === 0) {
          log.warn("No hay servers. Agrega uno primero.");
          break;
        }
        const id = await selectServerId(servers, "Cual quieres como default source?");
        if (!id) break;
        await setDefault("source", id);
        log.ok(`Default source = ${id}`);
        break;
      }
      case "default_target": {
        const servers = await listServers();
        if (servers.length === 0) {
          log.warn("No hay servers. Agrega uno primero.");
          break;
        }
        const id = await selectServerId(servers, "Cual quieres como default target?");
        if (!id) break;
        await setDefault("target", id);
        log.ok(`Default target = ${id}`);
        break;
      }

      case "back":
        return;
    }
  }
}

type ServersAction =
  | "add"
  | "list"
  | "edit"
  | "test_one"
  | "remove"
  | "default_source"
  | "default_target"
  | "back";

async function selectServerId(
  servers: Server[],
  message: string
): Promise<string | null> {
  const id = await select<string>({
    message,
    choices: [
      ...servers.map((s) => ({
        name: `${s.id.padEnd(16)} - ${s.label}`,
        value: s.id,
      })),
      { name: "<- Cancelar", value: "__cancel__" },
    ],
  });
  return id === "__cancel__" ? null : id;
}

async function bundlesSubmenu(): Promise<void> {
  while (true) {
    const files = await listBundleFiles();
    banner("Bundles", "ver / restaurar / borrar", [{ label: "Bundles" }]);

    if (files.length === 0) {
      process.stdout.write(chalk.gray("  (no hay bundles en ./backups)\n"));
    } else {
      let total = 0;
      for (const f of files) {
        total += f.size;
        process.stdout.write(
          `  ${chalk.cyan(f.name.padEnd(48))}  ${chalk.gray(
            humanBytes(f.size) + "  " + f.mtime.toISOString().slice(0, 19).replace("T", " ")
          )}\n`
        );
      }
      process.stdout.write(
        chalk.dim(`  (${files.length} bundle(s), total ${humanBytes(total)})\n`)
      );
    }
    separator();

    const action = await select<BundlesAction>({
      message: "¿Que quieres hacer con los bundles?",
      choices: [
        { name: "Restaurar uno al VPS Nuevo (elegir)", value: "restore" },
        { name: "Ver manifest de uno (preview sin restaurar)", value: "manifest" },
        { name: chalk.red("Borrar uno"), value: "delete" },
        { name: chalk.gray("<- Volver al menu principal"), value: "back" },
      ],
    });

    if (action === "back") return;
    if (files.length === 0) {
      log.warn("No hay bundles.");
      continue;
    }

    const picked = await select<string>({
      message: "Cual bundle?",
      choices: [
        ...files.map((f) => ({
          name: `${f.name}   ${humanBytes(f.size)}  ${f.mtime.toISOString().slice(0, 10)}`,
          value: path.join("./backups", f.name),
        })),
        { name: "<- Cancelar", value: "__cancel__" },
      ],
    });
    if (picked === "__cancel__") continue;

    switch (action) {
      case "restore":
        await runFlow(`Bundles > Restaurar`, async () => {
          await runRestoreFlow({ bundlePath: picked, parseArgs: [] });
        });
        break;
      case "manifest": {
        await runFlow(`Bundles > Manifest`, async () => {
          const { extractBundle } = await import("./lib/bundle.js");
          const b = await extractBundle(picked);
          process.stdout.write(renderManifest(b.manifest) + "\n");
          await anyKey();
        });
        break;
      }
      case "delete": {
        const ok = await confirm({
          message: `Borrar ${path.basename(picked)} del PC local?`,
          default: false,
        });
        if (ok) {
          await fs.unlink(picked);
          log.ok(`Borrado: ${path.basename(picked)}`);
        } else {
          log.out("Cancelado.");
        }
        break;
      }
    }
  }
}

type BundlesAction = "restore" | "manifest" | "delete" | "back";

async function runFlow(label: string, fn: () => Promise<void>): Promise<void> {
  banner(label);
  separator();
  try {
    await fn();
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("User force closed") || msg.includes("AbortedByUserError")) {
      log.out("(cancelado por el usuario)");
    } else {
      log.err(`Error: ${msg}`);
    }
  }
  separator();
  log.out(chalk.gray("Volviendo al menu...\n"));
}

async function listBundleFiles(): Promise<
  { name: string; size: number; mtime: Date }[]
> {
  const dir = "./backups";
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out: { name: string; size: number; mtime: Date }[] = [];
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".tar.gz")) continue;
      const st = await fs.stat(path.join(dir, e.name));
      out.push({ name: e.name, size: st.size, mtime: st.mtime });
    }
    out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    return out;
  } catch {
    return [];
  }
}

async function anyKey(): Promise<void> {
  await input({ message: chalk.gray("Presiona ENTER para volver...") });
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let i = -1;
  let v = n;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(1)} ${units[i]}`;
}
