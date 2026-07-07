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
  const projectSlug = slugify(project.name);

  const lines: string[] = [];

  lines.push("#!/usr/bin/env bash");
  lines.push("# ============================================================");
  lines.push(`# Backup generado por migrate-dokploy`);
  lines.push(`# Proyecto: ${project.name} (${project.projectId})`);
  lines.push(`# Slug: ${projectSlug}`);
  lines.push(`# Generado: ${generatedAt}`);
  lines.push("# Ejecutar DENTRO del VPS Hostinger como root (o con sudo).");
  lines.push("# READ-ONLY: no se modifica Dokploy, servicios ni datos.");
  lines.push("# ============================================================");
  lines.push("set -euo pipefail");
  lines.push("");
  lines.push(`# Trabajar SIEMPRE en el mismo dir donde el CLI espera el bundle (/tmp).`);
  lines.push(`# Sin esto, los paths relativos './onefit-backup-...' se resuelven desde`);
  lines.push(`# el home del usuario SSH y el CLI no encuentra el .tar.gz final.`);
  lines.push(`WORK_DIR="\${REMOTE_TMP:-/tmp}"`);
  lines.push(`mkdir -p "\${WORK_DIR}"`);
  lines.push(`cd "\${WORK_DIR}"`);
  lines.push("");
  lines.push(`PROJECT_ID="${project.projectId}"`);
  lines.push(`PROJECT_SLUG="${projectSlug}"`);
  lines.push(`BUNDLE="${bundleName}"`);
  lines.push(`OUT="\${WORK_DIR}/${bundleName}"`);
  lines.push("");

// DEBUG: listar containers para entender la nomina que usa Dokploy en este VPS
  lines.push(`echo "==> Containers presentes en este VPS (para debug de nombres):"`);
  lines.push(`docker ps -a --format '  {{.Names}}' | head -50`);
  lines.push("");
  lines.push(`echo "==> Containers que parecen ser del proyecto '\${PROJECT_SLUG}':"`);
  lines.push(`docker ps -a --format '{{.Names}}' | grep -F "\${PROJECT_SLUG}-" || echo "  (ninguno por nombre)"`);
  lines.push(`docker ps -a --filter "label=com.docker.compose.project=\${PROJECT_SLUG}" --format '  {{.Names}}  (via label)' 2>/dev/null || true`);
  lines.push("");

  // resolve_container con muchas condiciones fallback.
  // Dokploy/Swarm usa nombres con hash aleatorio (onefit-web-wj4f0j.1.xxxxxx).
  // El appName de la API puede venir como 'web' (corto) o 'onefit-db-e19t4w'
  // (con slug+service+taskID). Filtramos primero por proyecto y despues
  // buscamos match por service/appname dentro de esa sublista.
  lines.push(`resolve_container() {
  local service="\$1"          # nombre legible (ej: "web" o "onefit-postgres")
  local appname="\${2:-}"      # appName/slug que devuelve la API
  local svc_id="\${3:-}"       # ID dokploy del service (applicationId/postgresId/etc.); opcional

  # Paso 1: filtrar containers que pertenecen al proyecto.
  #         Intentar por nombre primero, despues por label.
  local proj_containers
  proj_containers=$(docker ps -a --format '{{.Names}}' | grep -F "\${PROJECT_SLUG}-" || true)
  if [ -z "\${proj_containers}" ]; then
    proj_containers=$(docker ps -a --filter "label=com.docker.compose.project=\${PROJECT_SLUG}" --format '{{.Names}}' 2>/dev/null || true)
  fi
  if [ -z "\${proj_containers}" ]; then
    proj_containers=$(docker ps -a --format '{{.Names}}')
  fi

  # Paso 2: probar muchos patrones de match contra esa lista.
  local hit

  # E1: match exacto del nombre completo del container
  for cand in "\${appname}" "\${service}"; do
    if [ -n "\${cand}" ]; then
      hit=$(echo "\${proj_containers}" | grep -Fx "\${cand}" | head -n1 || true)
      [ -n "\${hit}" ] && { echo "\${hit}"; return 0; }
    fi
  done

  # E2: el service/appname aparece como TOKEN separado por '-' o '.' en el nombre
  #     (ej: onefit-db-e19t4w.1.xxxxxx matchea token 'db' o 'e19t4w')
  for cand in "\${appname}" "\${service}"; do
    if [ -n "\${cand}" ]; then
      hit=$(echo "\${proj_containers}" | grep -E "[-.]\${cand}([-.]|\$)" | head -n1 || true)
      [ -n "\${hit}" ] && { echo "\${hit}"; return 0; }
    fi
  done

  # E3: empieza con <slug>-<cand>
  for cand in "\${appname}" "\${service}"; do
    if [ -n "\${cand}" ]; then
      hit=$(echo "\${proj_containers}" | grep -F "^\${PROJECT_SLUG}-\${cand}" | head -n1 || true)
      [ -n "\${hit}" ] && { echo "\${hit}"; return 0; }
    fi
  done

  # E4: empieza con <slug><cand> (sin guion, por si estan concatenados)
  for cand in "\${appname}" "\${service}"; do
    if [ -n "\${cand}" ]; then
      hit=$(echo "\${proj_containers}" | grep -F "^\${PROJECT_SLUG}\${cand}" | head -n1 || true)
      [ -n "\${hit}" ] && { echo "\${hit}"; return 0; }
    fi
  done

  # E5: empieza con <projectId>-<cand>
  for cand in "\${appname}" "\${service}"; do
    if [ -n "\${cand}" ]; then
      hit=$(echo "\${proj_containers}" | grep -F "^\${PROJECT_ID}-\${cand}" | head -n1 || true)
      [ -n "\${hit}" ] && { echo "\${hit}"; return 0; }
    fi
  done

  # E6: match por label Dokploy/Compose service (si existe)
  if [ -n "\${svc_id}" ]; then
    hit=$(docker ps -a --filter "label=dokploy.applicationId=\${svc_id}" --format '{{.Names}}' 2>/dev/null | head -n1 || true)
    [ -n "\${hit}" ] && { echo "\${hit}"; return 0; }
    hit=$(docker ps -a --filter "label=dokploy.postgresId=\${svc_id}" --format '{{.Names}}' 2>/dev/null | head -n1 || true)
    [ -n "\${hit}" ] && { echo "\${hit}"; return 0; }
    hit=$(docker ps -a --filter "label=com.docker.compose.service=\${appname}" --format '{{.Names}}' 2>/dev/null | head -n1 || true)
    [ -n "\${hit}" ] && { echo "\${hit}"; return 0; }
  fi

  # E7: case-insensitive substring (ultimo recurso)
  for cand in "\${appname}" "\${service}"; do
    if [ -n "\${cand}" ]; then
      hit=$(echo "\${proj_containers}" | grep -iF "\${cand}" | head -n1 || true)
      [ -n "\${hit}" ] && { echo "\${hit}"; return 0; }
    fi
  done

  # No encontrado
  return 1
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
    const appName = s.service.appName ?? svcSlug;
    const dir = `\${OUT}/services/${svcSlug}`;
    lines.push("# ----------------------------------------------------------");
    lines.push(`# Servicio: ${s.service.name} (${s.service.kind}${s.service.databaseType ? "/" + s.service.databaseType : ""}) - appName=${appName}`);
    lines.push("# ----------------------------------------------------------");
    lines.push(`mkdir -p "${dir}"`);
    lines.push(`CONTAINER="$(resolve_container '${s.service.name}' '${appName}' '${s.service.id}' || true)"`);
    lines.push(`if [ -z "\${CONTAINER:-}" ]; then`);
    lines.push(`  echo "  [WARN] No encontre contenedor para '${s.service.name}' (appName='${appName}', id='${s.service.id}'). Saltando."`);
    lines.push(`  echo "        Probe 7 estrategias (E1..E7) contra \$(echo "\${proj_containers}" | wc -l) containers del proyecto."`);
    lines.push(`else`);
    lines.push(`  echo "  -> Container: \${CONTAINER}"`);

    if (sel.compose) {
      lines.push(`  # Definicion del servicio desde el path interno de Dokploy`);
      lines.push(`  mkdir -p "${dir}/dokploy"`);
      lines.push(`  for base in "/etc/dokploy/compose/\${PROJECT_SLUG}" "/etc/dokploy/compose/\${PROJECT_ID}" "/etc/dokploy/compose/\${CONTAINER}"; do`);
      lines.push(`    if [ -d "$base" ]; then`);
      lines.push(`      cp -r "$base"/* "${dir}/dokploy/" 2>/dev/null || true`);
      lines.push(`      break`);
      lines.push(`    fi`);
      lines.push(`  done`);
      lines.push(`  docker inspect "\${CONTAINER}" > "${dir}/docker-inspect.json" 2>/dev/null || true`);
      lines.push(`  for cf in \\`);
      lines.push(`    "/etc/dokploy/compose/\${PROJECT_SLUG}/docker-compose.yml" \\`);
      lines.push(`    "/etc/dokploy/compose/\${PROJECT_SLUG}/compose.yaml" \\`);
      lines.push(`    "/etc/dokploy/compose/\${PROJECT_SLUG}/docker-compose.yaml" \\`);
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
      lines.push(`    "/etc/dokploy/compose/\${PROJECT_SLUG}/${s.service.name}.env" \\`);
      lines.push(`    "/etc/dokploy/compose/\${PROJECT_SLUG}/${appName}.env" \\`);
      lines.push(`    "/etc/dokploy/compose/\${PROJECT_SLUG}/.env" \\`);
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
      lines.push(`    if [ ! -e "$SRC" ]; then`);
      lines.push(`      echo "     [WARN] bind mount src no existe: $SRC -> $DST. Saltando."`);
      lines.push(`      continue`);
      lines.push(`    fi`);
      lines.push(`    NAME=$(echo "$DST" | tr '/' '_' | sed 's/^_//')`);
      lines.push(`    echo "     tar mount: $SRC -> $DST"`);
      lines.push(`    if ! tar -czf "${dir}/volumes/\${NAME}.tar.gz" -C "$SRC" . 2>"${dir}/volumes/\${NAME}.err"; then`);
      lines.push(`      echo "     [WARN] tar fallo para bind mount $SRC -> $DST. Continuando."`);
      lines.push(`      rm -f "${dir}/volumes/\${NAME}.tar.gz"`);
      lines.push(`    fi`);
      lines.push(`  done < "${dir}/volumes/_mounts.txt"`);
      lines.push(`  docker inspect "\${CONTAINER}" --format '{{json .Mounts}}' | jq -r '.[] | select(.Type=="volume") | .Name + " " + .Destination' \\`);
      lines.push(`    > "${dir}/volumes/_named_mounts.txt" 2>/dev/null || true`);
      lines.push(`  while read -r VNAME DST; do`);
      lines.push(`    [ -z "$VNAME" ] && continue`);
      lines.push(`    if ! docker volume inspect "$VNAME" >/dev/null 2>&1; then`);
      lines.push(`      echo "     [WARN] named volume no existe: $VNAME. Saltando."`);
      lines.push(`      continue`);
      lines.push(`    fi`);
      lines.push(`    SAVE_DIR="\${OUT}/volumes/\${VNAME}"`);
      lines.push(`    mkdir -p "$SAVE_DIR"`);
      lines.push(`    echo "     docker volume: $VNAME -> $DST"`);
      lines.push(`    if ! docker run --rm -v "$VNAME":/from:ro -v "$SAVE_DIR":/to alpine sh -c 'cd /from && tar -cf - . 2>/dev/null | tar -xf - -C /to' 2>"${dir}/volumes/\${VNAME}.err"; then`);
      lines.push(`      echo "     [WARN] docker run fallo para named volume $VNAME. Continuando."`);
      lines.push(`      continue`);
      lines.push(`    fi`);
      lines.push(`    # IMPORTANTE: usar -C en vez de (cd ... && tar) para que el path`);
      lines.push(`    # relativo de salida se resuelva desde el cwd del script, no desde SAVE_DIR.`);
      lines.push(`    if ! tar -czf "${dir}/volumes/\${VNAME}.tar.gz" -C "$SAVE_DIR" . 2>"${dir}/volumes/\${VNAME}.tar.err"; then`);
      lines.push(`      echo "     [WARN] tar fallo para named volume $VNAME. Continuando."`);
      lines.push(`      rm -f "${dir}/volumes/\${VNAME}.tar.gz"`);
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
