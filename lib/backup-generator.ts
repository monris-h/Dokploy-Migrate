import type { BackupPlan, DatabaseType } from "./types.js";

/**
 * Genera un script bash ejecutable que produce un bundle de backup tar.gz del
 * proyecto seleccionado. El script se ejecuta EN EL VPS HOSTINGER (donde vive
 * Dokploy y los contenedores), no en la maquina del usuario.
 *
 * READ-ONLY sobre Dokploy: no modifica proyectos, servicios, BDs ni containers.
 */

export function generateBackupScript(plan: BackupPlan): string {
  const { project, services, bundleName, generatedAt } = plan;
  const outDir = `./${bundleName}`;

  const lines: string[] = [];

  lines.push("#!/usr/bin/env bash");
  lines.push("# ============================================================");
  lines.push(`# Backup generado por migrate-dokploy`);
  lines.push(`# Proyecto: ${project.name} (${project.projectId})`);
  lines.push(`# Generado: ${generatedAt}`);
  lines.push("# Ejecutar DENTRO del VPS Hostinger como root (o con sudo).");
  lines.push("# READ-ONLY: no se modifica Dokploy, servicios ni datos.");
  lines.push("# ============================================================");
  lines.push("set -euo pipefail");
  lines.push("");
  lines.push(`PROJECT_ID="${project.projectId}"`);
  lines.push(`BUNDLE="${bundleName}"`);
  lines.push(`OUT="${outDir}"`);
  lines.push("");

  lines.push(`resolve_container() {
  local service="$1"
  local candidates=(
    "\${PROJECT_ID}-\${service}-1"
    "\${PROJECT_ID}-\${service}"
    "\${PROJECT_ID}_\${service}_1"
  )
  for c in "\${candidates[@]}"; do
    if docker ps -a --format '{{.Names}}' | grep -qx "$c"; then
      echo "$c"
      return 0
    fi
  done
  docker ps -a --format '{{.Names}}' | grep -E "^\${PROJECT_ID}.*\${service}" | head -n1 || true
}
`);
  lines.push("");

  lines.push(`mkdir -p "\${OUT}"
mkdir -p "\${OUT}/services"
mkdir -p "\${OUT}/volumes"
mkdir -p "\${OUT}/databases"

echo "==> Backup del proyecto: ${project.name} (\${PROJECT_ID})"
echo "==> Bundle: \${BUNDLE}.tar.gz"
echo ""`);
  lines.push("");

  for (const s of plan.services) {
    const sel = s.selection;
    if (!sel.compose && !sel.env && !sel.volumes && !sel.database) continue;
    const svcSlug = slugify(s.service.name);
    const dir = `\${OUT}/services/${svcSlug}`;
    lines.push("# ----------------------------------------------------------");
    lines.push(`# Servicio: ${s.service.name} (${s.service.kind}${s.service.databaseType ? "/" + s.service.databaseType : ""})`);
    lines.push("# ----------------------------------------------------------");
    lines.push(`mkdir -p "${dir}"`);
    lines.push(`CONTAINER="$(resolve_container '${s.service.name}' || true)"`);
    lines.push(`if [ -z "\${CONTAINER:-}" ]; then`);
    lines.push(`  echo "  [WARN] No encontre contenedor para '${s.service.name}'. Saltando."`);
    lines.push(`  echo "        Lo busque como: \${PROJECT_ID}-${s.service.name}-1 / \${PROJECT_ID}-${s.service.name}"`);
    lines.push(`else`);
    lines.push(`  echo "  -> Container: \${CONTAINER}"`);

    if (sel.compose) {
      lines.push(`  # Definicion del servicio desde el path interno de Dokploy`);
      lines.push(`  mkdir -p "${dir}/dokploy"`);
      lines.push(`  if [ -d "/etc/dokploy/compose/\${PROJECT_ID}" ]; then`);
      lines.push(`    cp -r /etc/dokploy/compose/\${PROJECT_ID}/* "${dir}/dokploy/" 2>/dev/null || true`);
      lines.push(`  fi`);
      lines.push(`  docker inspect "\${CONTAINER}" > "${dir}/docker-inspect.json" 2>/dev/null || true`);
      lines.push(`  for cf in \\`);
      lines.push(`    "/etc/dokploy/compose/\${PROJECT_ID}/docker-compose.yml" \\`);
      lines.push(`    "/etc/dokploy/compose/\${PROJECT_ID}/compose.yaml" \\`);
      lines.push(`    "/etc/dokploy/compose/\${PROJECT_ID}/docker-compose.yaml"; do`);
      lines.push(`    if [ -f "$cf" ]; then cp "$cf" "${dir}/docker-compose.yml"; break; fi`);
      lines.push(`  done`);
    }

    if (sel.env) {
      lines.push(`  # Variables de entorno del container`);
      lines.push(`  docker inspect "\${CONTAINER}" --format='{{json .Config.Env}}' > "${dir}/env.json" 2>/dev/null || true`);
      lines.push(`  for ef in \\`);
      lines.push(`    "/etc/dokploy/compose/\${PROJECT_ID}/${s.service.name}.env" \\`);
      lines.push(`    "/etc/dokploy/compose/\${PROJECT_ID}/.env"; do`);
      lines.push(`    if [ -f "$ef" ]; then cp "$ef" "${dir}/service.env"; break; fi`);
      lines.push(`  done`);
    }

    if (sel.volumes) {
      lines.push(`  # Volumenes montados en este container`);
      lines.push(`  mkdir -p "${dir}/volumes"`);
      lines.push(`  docker inspect "\${CONTAINER}" --format '{{json .Mounts}}' | jq -r '.[] | select(.Type=="bind") | .Source + " " + .Destination' \\`);
      lines.push(`    > "${dir}/volumes/_mounts.txt" 2>/dev/null || true`);
      lines.push(`  while read -r SRC DST; do`);
      lines.push(`    [ -z "$SRC" ] && continue`);
      lines.push(`    if [ -e "$SRC" ]; then`);
      lines.push(`      NAME=$(echo "$DST" | tr '/' '_' | sed 's/^_//')`);
      lines.push(`      echo "     tar mount: $SRC -> $DST"`);
      lines.push(`      tar -czf "${dir}/volumes/\${NAME}.tar.gz" -C "$SRC" .`);
      lines.push(`    fi`);
      lines.push(`  done < "${dir}/volumes/_mounts.txt"`);
      lines.push(`  docker inspect "\${CONTAINER}" --format '{{json .Mounts}}' | jq -r '.[] | select(.Type=="volume") | .Name + " " + .Destination' \\`);
      lines.push(`    > "${dir}/volumes/_named_mounts.txt" 2>/dev/null || true`);
      lines.push(`  while read -r VNAME DST; do`);
      lines.push(`    [ -z "$VNAME" ] && continue`);
      lines.push(`    if docker volume inspect "$VNAME" >/dev/null 2>&1; then`);
      lines.push(`      SAVE_DIR="\${OUT}/volumes/\${VNAME}"`);
      lines.push(`      mkdir -p "$SAVE_DIR"`);
      lines.push(`      docker run --rm -v "$VNAME":/from:ro -v "$SAVE_DIR":/to alpine sh -c 'cd /from && tar -cf - . | tar -xf - -C /to'`);
      lines.push(`      (cd "$SAVE_DIR" && tar -czf "${dir}/volumes/\${VNAME}.tar.gz" .)`);
      lines.push(`    fi`);
      lines.push(`  done < "${dir}/volumes/_named_mounts.txt"`);
    }

    if (sel.database && s.service.kind === "db") {
      const db = s.service.databaseType ?? inferDbFromName(s.service.name);
      const dbScript = dumpDbScript(db);
      lines.push(`  # Dump de base de datos (${db})`);
      lines.push(`  docker exec "\${CONTAINER}" sh -lc '${dbScript.shellCommand.replace(/'/g, "'\\''")}' \\`);
      lines.push(`    | gzip > "${dir}/dump.sql.gz" 2>/dev/null \\`);
      lines.push(`    || echo "  [WARN] Dump de BD fallo para ${s.service.name}"`);
    }

    lines.push(`fi`);
    lines.push("");
  }

  lines.push(`cat > "\${OUT}/manifest.json" <<JSON`);
  lines.push(JSON.stringify(buildManifest(plan), null, 2));
  lines.push(`JSON`);
  lines.push("");

  lines.push(`cat > "\${OUT}/RESTORE.md" <<'RESTORE_EOF'`);
  lines.push(restoreInstructions(plan));
  lines.push(`RESTORE_EOF`);
  lines.push("");

  lines.push(`tar -czf "\${BUNDLE}.tar.gz" "\${OUT}"`);
  lines.push(`echo ""`);
  lines.push(`echo "==> Listo. Bundle: \$(pwd)/\${BUNDLE}.tar.gz"`);
  lines.push(`ls -lh "\${BUNDLE}.tar.gz"`);
  lines.push("");

  return lines.join("\n");
}

type DbScript = { shellCommand: string };

function dumpDbScript(db: DatabaseType): DbScript {
  switch (db) {
    case "postgres":
      return { shellCommand: 'pg_dumpall -U "$POSTGRES_USER"' };
    case "mysql":
      return {
        shellCommand:
          'MYSQL_PWD="${MYSQL_ROOT_PASSWORD:-$MYSQL_PASSWORD}" mysqldump -u "${MYSQL_USER:-root}" --all-databases --single-transaction --quick',
      };
    case "mariadb":
      return {
        shellCommand:
          'MYSQL_PWD="${MARIADB_ROOT_PASSWORD:-$MYSQL_PASSWORD}" mariadb-dump -u "${MARIADB_USER:-root}" --all-databases --single-transaction --quick',
      };
    case "mongo":
      return { shellCommand: "mongodump --archive --gzip" };
    case "redis":
      return {
        shellCommand:
          'sh -c \'redis-cli -a "$REDIS_PASSWORD" BGSAVE && sleep 1 && cp /data/dump.rdb /tmp/dump.rdb && cat /tmp/dump.rdb\'',
      };
  }
}

function inferDbFromName(name: string): DatabaseType {
  const n = name.toLowerCase();
  if (n.includes("postgres") || n.includes("psql")) return "postgres";
  if (n.includes("mariadb")) return "mariadb";
  if (n.includes("mongo")) return "mongo";
  if (n.includes("redis")) return "redis";
  return "mysql";
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "service"
  );
}

function buildManifest(plan: BackupPlan) {
  return {
    project: { id: plan.project.projectId, name: plan.project.name },
    generatedAt: plan.generatedAt,
    bundle: plan.bundleName,
    services: plan.services
      .filter((s) => hasSelection(s.selection))
      .map((s) => ({
        name: s.service.name,
        kind: s.service.kind,
        databaseType: s.service.databaseType ?? null,
        image: s.service.image ?? null,
        selection: s.selection,
      })),
    notes: [
      "Ejecutar como root en el VPS Hostinger.",
      "El bundle tar.gz contiene ./" + plan.bundleName + "/ con manifest.json y RESTORE.md.",
      "Los .env del container estan en services/<slug>/env.json - NO los subas a un repo publico.",
      "READ-ONLY: el script no modifica Dokploy ni los servicios.",
    ],
  };
}

function hasSelection(s: {
  compose: boolean;
  env: boolean;
  volumes: boolean;
  database: boolean;
}) {
  return s.compose || s.env || s.volumes || s.database;
}

function restoreInstructions(plan: BackupPlan): string {
  return `# Como restaurar en Dokploy Contabo

Este bundle fue generado por migrate-dokploy para el proyecto **${plan.project.name}**.

## Contenido

\`\`\`
${plan.bundleName}/
├── manifest.json
├── services/
│   └── <slug-servicio>/
│       ├── docker-compose.yml    # si se selecciono
│       ├── docker-inspect.json   # inspeccion cruda del container
│       ├── env.json
│       ├── service.env
│       ├── volumes/              # tar.gz de cada mount
│       └── dump.sql.gz           # dump completo de la BD
├── volumes/                      # named volumes
└── RESTORE.md                    # este archivo
\`\`\`
`;
}
