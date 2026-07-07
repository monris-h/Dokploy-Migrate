# migrate-dokploy

CLI en Node.js que migra proyectos entre servidores Dokploy desde tu PC local:

```
PC local --SSH--> VPS Viejo --tar.gz--> PC --SSH--> VPS Nuevo
        +--- Dokploy API (lee proyectos + servicios) ---+ aplica via API ---+
```

> **READ-ONLY sobre el VPS Viejo.** Esta herramienta **no elimina nada** alli.

## Que hace paso a paso

1. Conecta al **VPS Viejo** via Dokploy API + SSH. Credenciales guardadas en `%USERPROFILE%\.migrate-dokploy\db.json` (mode 0600).
2. Lista los proyectos del VPS Viejo, elegis uno.
3. Lista **todos** los servicios del proyecto (application, postgres, mysql, mongo, redis, compose, ...) y para cada uno elegis que respaldar (compose/env/volumenes/dump de BD).
4. Sube un script bash al VPS Viejo y lo ejecuta. **READ-ONLY** sobre Dokploy: `pg_dumpall`, `docker inspect`, copia de archivos.
5. Baja el `.tar.gz` del bundle a tu PC local en `./backups/`.
6. Si configuraste el **VPS Nuevo**, automaticamente:
   - Crea el proyecto con el mismo nombre.
   - **Recrea cada servicio como su propia unidad administrable** (`web` como `application`, `onefit-postgres` como `postgres`, etc.) - NO un solo compose.
   - Dispara el deploy de cada uno por separado.
   - Sube el `.tar.gz` al VPS Nuevo y restaura los volumenes.
   - Importa el dump de BD en cada container correspondiente.

## BD multi-server

El CLI guarda credenciales de **N** servidores Dokploy, no solo 2:

```
%USERPROFILE%\.migrate-dokploy\db.json
{
  "version": 1,
  "servers": [
    {
      "id": "hostinger",
      "label": "Hostinger OneFit",
      "dokploy": { "url": "...", "apiKey": "migrates_..." },
      "ssh": { "host": "...", "port": 22, "username": "root", "privateKeyPath": "..." },
      "roles": ["source"],
      "lastUsedAt": "...",
      "createdAt": "..."
    },
    { "id": "contabo", ... }
  ],
  "defaults": { "source": "hostinger", "target": "contabo" }
}
```

**Comandos para gestionar servers:**

```powershell
npm run servers                        # lista todos
npm run servers -- add                 # wizard para registrar uno nuevo
npm run servers -- show hostinger      # ver detalle (api key enmascarada)
npm run servers -- edit hostinger      # editar un campo
npm run servers -- remove contabo      # eliminar
npm run servers -- default source hostinger     # marcar como default source
npm run servers -- default target contabo       # marcar como default target
npm run servers -- reset               # borra toda la BD
```

El **wizard de `add`** pide en orden:
1. ID corto del server (`hostinger`, `contabo`, `do-nyc-1`, ...)
2. Nombre humano (label)
3. URL del panel Dokploy + API key
4. Host/IP del VPS + puerto + usuario SSH
5. Ruta de la SSH key (o password)
6. Roles: `source` (VPS del que saco backups) y/o `target` (VPS al que importo)

## Uso end-to-end

### Opcion recomendada: TUI (un solo comando)

```powershell
npm start
```

Abre el menu interactivo. Cada opcion te lleva a un sub-flujo y **al terminar vuelves al menu principal** - no sales de la app. Ctrl-C en cualquier prompt te regresa al menu o sale limpio.

```
╭────────────────────────────────────────────────────────────────╮
│  migrate-dokploy                                              │
│  Multi-server backup + restore for Dokploy                   │
╰────────────────────────────────────────────────────────────────╯

Servidores actuales
  hostinger  *src  Hostinger OneFit      https://dokploy.hostinger...  root@123.45.67.89:22
  contabo    *tg  Contabo nuevo         https://dokploy.contabo...    root@98.76.54.32:22

Bundles recientes en ./backups
  onefit-backup-2026-07-06T221800Z.tar.gz        24 MB   2026-07-06 22:18

? Que quieres hacer? ›
  Backup  desde el VPS Viejo y (opcional) importar al VPS Nuevo
  Backup (guiado)  preguntame que incluir por cada servicio
  Restore  restaurar un bundle .tar.gz al VPS Nuevo
  Servidores  agregar, editar, eliminar, marcar default  (2 registrados)
  Bundles  ver lista de .tar.gz en ./backups
  Refrescar estado
  Salir
```

### Opcion alternativa: comandos directos

```powershell
# Registrar servers (una sola vez por server)
npm run servers -- add     # wizard del VPS Viejo
npm run servers -- add     # wizard del VPS Nuevo

# Verificar
npm run servers            # tabla con defaults

# Migrar
npm run migrate            # backup + import encadenado
npm run backup             # backup solo
npm run restore -- --file ./backups/onefit-...tar.gz
```

Flags utiles:
- `--from <id>` server source especifico
- `--to <id>` server target especifico
- `--auto-select` / `--auto-import` / `--yes` (atajo de los dos)

## Por que cada servicio por separado

Replicar con UN solo docker compose lo vuelve una bola de barro: el panel no separa los servicios, los logs se mezclan, no podes reiniciar uno sin tocar al resto, y se pierde la paridad 1:1 con el server de origen. Aqui cada servicio se recrea como su **tipo nativo** (application, postgres, mysql, mariadb, mongo, redis) y queda administrado igual que en el server viejo.

## Que NO hace

- No elimina proyectos, servicios, bases de datos ni containers del VPS Viejo
- No borra volumenes
- No detiene containers (los servicios siguen corriendo durante el backup; `pg_dumpall` no bloquea)
- No empaqueta todos los servicios en un solo compose; cada uno se recrea como su propia unidad
- Deja el script y el `.tar.gz` en `/tmp/` del VPS Viejo sin borrarlos. Limpialos manualmente cuando quieras.

## Roadmap

- [x] BD multi-server con wizard y migracion automatica
- [x] Backup per-servicio via SSH (READ-ONLY)
- [x] Restore per-servicio en VPS Nuevo (cada uno como su tipo nativo)
- [x] Comando unico `migrate` que encadena backup + import
- [x] UI mejorada: tabla con chalk, defaults marcados, spinners en prompts largos
- [ ] Cifrado AES de la BD (con passphrase maestra opcional via `MIGRATE_DOKPLOY_KEY`)
- [ ] Modo incremental (solo delta desde ultimo backup)
- [ ] Subida directa a S3/R2/B2 sin pasar por Windows
