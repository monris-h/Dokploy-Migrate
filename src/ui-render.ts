import chalk from "chalk";
import type { Server, ServerRole } from "./db.js";

/**
 * Renderizado bonito (ASCII + chalk) para listas y detalles.
 */

const COL = {
  id: 18,
  label: 26,
  dokploy: 38,
  ssh: 30,
  roles: 18,
};

const TOTAL_W =
  COL.id + COL.label + COL.dokploy + COL.ssh + COL.roles + 12; // separadores

/** Muestra una tabla con todos los servers registrados y los defaults. */
export function renderServersTable(
  servers: Server[],
  defaults: { source?: string; target?: string }
): string {
  if (servers.length === 0) {
    return chalk.gray(
      "  (aun no hay servers. Agrega uno desde '📋 Servidores'.)\n"
    );
  }

  const header = (col: string, w: number) => padCol(col, w, chalk.bold);
  const sep = "─".repeat(TOTAL_W);

  const head = [
    header("ID", COL.id),
    header("LABEL", COL.label),
    header("DOKPLOY", COL.dokploy),
    header("SSH", COL.ssh),
    header("ROLES", COL.roles),
  ].join(" │ ");

  const out: string[] = [];
  out.push(`  ${head}`);
  out.push(`  ${chalk.gray(sep)}`);
  for (const s of servers) {
    const roles = s.roles.length
      ? s.roles.map((r) => marker(r, defaults)).join(" ")
      : chalk.dim("—");
    const dokploy = trunc(s.dokploy.url, COL.dokploy - 2);
    const ssh = `${s.ssh.username}@${s.ssh.host}:${s.ssh.port}`;
    const isDefSrc = defaults.source === s.id;
    const isDefTg = defaults.target === s.id;
    const tags =
      isDefSrc && isDefTg
        ? chalk.green(" *src *tg")
        : isDefSrc
          ? chalk.green(" *src")
          : isDefTg
            ? chalk.green(" *tg")
            : "";
    const idStr = s.id + tags;
    out.push(
      "  " +
        [
          padCol(idStr, COL.id, chalk.cyan),
          padCol(s.label, COL.label),
          padCol(dokploy, COL.dokploy),
          padCol(ssh, COL.ssh),
          padCol(roles, COL.roles),
        ].join(" │ ")
    );
  }
  out.push(`  ${chalk.gray(sep)}`);
  out.push(
    chalk.gray("  Leyenda: ") +
      chalk.green("*src") +
      chalk.gray(" = default source, ") +
      chalk.green("*tg") +
      chalk.gray(" = default target")
  );
  return out.join("\n");
}

function marker(
  r: ServerRole,
  defaults: { source?: string; target?: string }
): string {
  const isDefault = defaults[r] !== undefined;
  const base = r === "source" ? "source" : "target";
  return isDefault ? chalk.green(base) : chalk.dim(base);
}

function padCol(
  s: string,
  w: number,
  color: (x: string) => string = (x) => x
): string {
  const visible = stripAnsi(s);
  if (visible.length >= w) {
    return color(s.slice(0, w - 1) + "…");
  }
  return color(s) + " ".repeat(w - visible.length);
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function trunc(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

export function renderServerDetail(
  s: Server,
  defaults: { source?: string; target?: string } = {}
): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(
    chalk.bold(`${s.label}`) + chalk.gray(`  (id: ${s.id})`)
  );
  lines.push("");
  lines.push(`  ${chalk.cyan("id")}              ${s.id}`);
  lines.push(`  ${chalk.cyan("label")}           ${s.label}`);
  lines.push(
    `  ${chalk.cyan("roles")}           ${
      s.roles.length
        ? s.roles
            .map(
              (r) =>
                marker(r, defaults) +
                (defaults[r] === s.id ? chalk.gray(" (default)") : "")
            )
            .join(" ")
        : chalk.gray("(ninguno)")
    }`
  );
  if (s.lastUsedAt)
    lines.push(`  ${chalk.cyan("lastUsedAt")}      ${s.lastUsedAt}`);
  if (s.createdAt)
    lines.push(`  ${chalk.cyan("createdAt")}       ${s.createdAt}`);
  lines.push("");
  lines.push(chalk.bold("  Dokploy"));
  lines.push(`    ${chalk.cyan("url")}            ${s.dokploy.url}`);
  lines.push(`    ${chalk.cyan("apiKey")}         ${maskKey(s.dokploy.apiKey)}`);
  lines.push("");
  lines.push(chalk.bold("  SSH"));
  lines.push(
    `    ${chalk.cyan("host")}           ${s.ssh.username}@${s.ssh.host}:${s.ssh.port}`
  );
  lines.push(
    `    ${chalk.cyan("privateKeyPath")} ${
      s.ssh.privateKeyPath ? " " + s.ssh.privateKeyPath : chalk.gray("(password)")
    }`
  );
  return lines.join("\n");
}

function maskKey(s: string): string {
  if (!s) return chalk.gray("(vacio)");
  if (s.length <= 12) return chalk.gray("***");
  return chalk.gray(`${s.slice(0, 10)}…(${s.length} chars)`);
}

export function renderProjectsList(
  items: Array<{ id: string; name: string; description?: string }>
): string {
  if (items.length === 0) return chalk.gray("(sin proyectos)");
  const out: string[] = [];
  for (const p of items) {
    const desc = p.description ? chalk.gray(`  -  ${p.description}`) : "";
    out.push(`  ${chalk.cyan(p.name)}${desc}`);
  }
  return out.join("\n");
}
