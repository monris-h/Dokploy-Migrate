import chalk from "chalk";

/**
 * Render bonito del manifest de un bundle extraido.
 */

export function renderManifest(m: import("../lib/bundle.js").Manifest): string {
  const out: string[] = [];
  out.push("");
  out.push(chalk.bold(`Proyecto: ${m.project.name}`) + chalk.gray(`   (id: ${m.project.id})`));
  out.push(chalk.gray(`Generado: ${m.generatedAt}`));
  out.push(chalk.gray(`Bundle: ${m.bundle}`));
  out.push("");
  out.push(chalk.bold("Servicios incluidos:"));
  for (const s of m.services) {
    const tag =
      s.kind === "db"
        ? `db/${s.databaseType ?? "?"}`
        : s.kind === "compose"
          ? "compose"
          : "app";
    const items: string[] = [];
    if (s.selection.compose) items.push("compose");
    if (s.selection.env) items.push("env");
    if (s.selection.volumes) items.push("vol");
    if (s.selection.database) items.push("dump");
    out.push(
      `  ${chalk.cyan(s.name.padEnd(28))}  [${tag}]  ${chalk.gray(items.join(" + "))}${s.image ? "  " + chalk.gray(s.image) : ""}`
    );
  }
  out.push("");
  if (m.notes?.length) {
    out.push(chalk.bold("Notas:"));
    for (const n of m.notes) out.push(`  - ${chalk.gray(n)}`);
    out.push("");
  }
  return out.join("\n");
}
