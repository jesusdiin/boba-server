# boba-server

Backend de sincronización y respaldo del POS **Boba & Co.** (`../boba_pos`).
Orquesta los dispositivos de cada sucursal: los dispositivos suben su outbox
(push) y bajan los eventos de su sucursal (pull). La tabla `events` es a la vez
el log de sync y el respaldo en la nube.

Arquitectura y contrato de eventos: `../boba_pos/docs/ARQUITECTURA.md` y
`../boba_pos/docs/EVENTOS.md`.

## Stack
Node 22 · TypeScript · Express 5 · PostgreSQL 15 · Prisma 7 (adapter `pg`) ·
zod · pino · Vitest + supertest.

## Puesta en marcha

```bash
createdb boba_dev && createdb boba_test   # Postgres local (Homebrew)
cp .env.example .env                       # ajustar DATABASE_URL y ADMIN_API_KEY
pnpm install                               # genera el cliente de Prisma
pnpm db:migrate                            # aplica migraciones a boba_dev
pnpm dev                                   # http://localhost:4000
```

`.env.test` apunta a `boba_test` (los tests se niegan a correr contra otra DB).

## Scripts

| Script | Qué hace |
|---|---|
| `pnpm dev` | Servidor con recarga (tsx watch) |
| `pnpm build` / `pnpm start` | Compila a `dist/` y lo corre |
| `pnpm test` | Tests de integración contra `boba_test` (aplica migraciones antes) |
| `pnpm lint` / `pnpm typecheck` / `pnpm format` | Calidad |
| `pnpm db:migrate` | Nueva migración / aplicar en dev (`prisma migrate dev`) |
| `pnpm db:deploy` | Aplicar migraciones en prod (`prisma migrate deploy`) |
| `pnpm cli …` | Alta de organizaciones, sucursales y códigos |

## CLI (mientras no hay panel del dueño)

Usa la API admin local con `ADMIN_API_KEY` (servidor corriendo):

```bash
pnpm cli org:create "Boba & Co."                 # → orgId
pnpm cli branch:create <orgId> "Sucursal Centro" [--tz America/Mexico_City]
pnpm cli pair-code <branchId>                    # → código de 8 caracteres + QR (15 min)
pnpm cli devices <branchId>                      # dispositivos emparejados
```

## API v1

Errores: `{ "error": { "code", "message" } }`.

### Admin — header `X-Admin-Key`
- `POST /v1/admin/organizations {name}`
- `POST /v1/admin/organizations/:orgId/branches {name, timezoneId?, currencyCode?}`
- `POST /v1/admin/branches/:branchId/pairing-codes` → `{code, expiresAt}`
- `GET  /v1/admin/branches/:branchId/devices`
- `POST /v1/admin/devices/:id/revoke`

### Emparejamiento
`POST /v1/devices/pair {code, deviceName, mode?: "staff"|"kiosk"}` →
`{deviceId, token, organizationId, branch: {id, name, timezoneId, currencyCode}}`.
El token solo se entrega aquí (el servidor guarda su hash). Códigos de un solo
uso, 15 min, con freno de intentos por IP.

### Sync — header `Authorization: Bearer <token>`
Organización, sucursal y dispositivo salen **solo** del token.

- `POST /v1/sync/push {events: [...]}` (máx. 500). Cada evento es la fila del
  outbox: `{eventId, type, aggregateType, aggregateId, payload: {v, …}, createdAtUtc}`.
  Responde `{accepted: [{eventId, serverSeq}], duplicates: [eventId], rejected: [{eventId, code, message}]}`.
  Un reenvío vuelve en `duplicates` (idempotente: es éxito). Rechazos:
  `invalid_event`, `unknown_type`, `unsupported_version`, `conflict_other_branch`.
- `GET /v1/sync/pull?after=<serverSeq>&limit=<1..500>` →
  `{events: [{serverSeq, eventId, deviceId, type, aggregateType, aggregateId, payload, createdAtUtc, receivedAt}], hasMore, lastServerSeq}`.
  Incluye los eventos del propio dispositivo (el cliente los ignora por
  `deviceId`). `serverSeq` viaja como string.

### Salud
`GET /healthz` → `{ok: true}` (verifica la DB).

## Ejemplo con curl

```bash
TOKEN=$(curl -s -X POST localhost:4000/v1/devices/pair \
  -H 'content-type: application/json' \
  -d '{"code":"FZQAG5EK","deviceName":"iPad caja"}' | jq -r .token)

curl -s -X POST localhost:4000/v1/sync/push -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"events":[{"eventId":"0192f0a0-0000-7000-8000-000000000001","type":"sale.created","aggregateType":"sale","aggregateId":"s1","createdAtUtc":"2026-08-20T18:00:00.000Z","payload":{"v":1,"sale":{"id":"s1"}}}]}'

curl -s "localhost:4000/v1/sync/pull?after=0" -H "authorization: Bearer $TOKEN"
```

## Agregar un tipo de evento
1. Registrar tipo y versión en `src/events/schema.ts` (espejo de
   `EventTypes` en la app y de `docs/EVENTOS.md`).
2. Si sube la versión del payload, desplegar el servidor antes que la app.
