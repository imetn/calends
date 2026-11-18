# App sync API (v1)

[Architecture](../ARCHITECTURE.md) · [Self-hosting](self-hosting.md)

Native apps keep a full local copy of the ledger and sync it with the server through two endpoints. The web app does not use them, and they change nothing about existing routes. Implementation: [worker/sync.ts](../worker/sync.ts) (request flow), [worker/sync-ops.ts](../worker/sync-ops.ts) (operations), [worker/sync-store.ts](../worker/sync-store.ts) (in-memory snapshot) and [shared/sync-check.ts](../shared/sync-check.ts) (shared constants). Schema: migration `0009_sync.sql`, which only adds tables and triggers.

## Authentication

Requests must send `Authorization: Bearer <token>` with a sync token (`cal_sync_…`). The owner issues one under Settings → Security → Connected devices and apps (`GET`/`POST /api/sync/tokens`, `DELETE /api/sync/tokens/:id`, session-authenticated). The plain token is shown once, and only its SHA-256 is stored. Sync tokens are separate from MCP tokens. An MCP token, including a write-scope one, cannot call `/api/sync/*`, and a sync token cannot call `/mcp` or the web API. Cookies are not accepted, so the route skips the same-origin check. Without a valid sync token, `POST /sync` answers 401 with `WWW-Authenticate: Bearer`, and revoking a token takes effect on the next request. A hosting layer mounts `syncHandler` from [worker/hosting.ts](../worker/hosting.ts) and passes an identity it has already verified (`{ aud: 'sync' }`). The handler does not verify tokens itself in that case.

## `GET /api/sync/v1/hello`

Returns `{ protocol, minClientProtocol, ops, engine }`. `ops` maps each operation name to its supported version range. With a valid token the response also includes `counts: { sub, method, people }` and `ledgerId`, which the app uses on first connection to decide how to merge.

## `POST /api/sync/v1/sync`

Request body:

| Field       | Meaning                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------- |
| `protocol`  | Client protocol version (currently 1).                                                        |
| `reqId`     | Echoed back in the response.                                                                  |
| `installId` | Stable ID of one app install.                                                                 |
| `ledgerId`  | Ledger the install is bound to. `null` allows pull-only requests.                             |
| `drEpoch`   | Disaster-recovery epoch last seen. Only a first `register` may send `null`.                   |
| `register`  | `true` registers the install. A register request must carry no mutations.                     |
| `cookie`    | `{ gen, seq }` from the previous response, or `null` for a full download.                     |
| `ackedMid`  | Highest mutation ID whose result the client has stored. Rejections at or below it are pruned. |
| `mutations` | Up to 300 entries, each `{ mid, op }`, with `mid` strictly increasing from 1 per install.     |

The response is one of the following:

- Normal: `{ reqId, ledgerId, drEpoch, lastMutationId, expected, rejections, full, objects, cookie, more, fx }`. `objects` is a list of `[key, doc | null]` pairs, with keys `sub/<id>`, `method/<id>`, `kv/settings`, `kv/people` and `fx/<date>`; `null` marks a deletion. `full: true` means the client should replace its local copy. `more: true` means another page is waiting, so the client sends the returned cookie again. `expected` is set when a gap in `mid` stopped the batch. `fx` holds the current exchange rates.
- `{ ledgerMismatch: true, ledgerId }`: the server holds a different ledger.
- `{ ledgerId, drEpoch, gone: { lastMutationId, rejections } }`: this install is retired. This happens after disaster recovery, an unknown or stale epoch, a lost registration, or `ackedMid` running ahead of the server. The client must register again and resolve its pending changes.

Checks run in this order:

| Status | Code                                          | Condition                                                                                                       |
| ------ | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 400    | `invalid_request`                             | Malformed body or field.                                                                                        |
| 426    | `client_too_old` / `server_too_old`           | Protocol outside the supported range.                                                                           |
| 413    | `too_many_mutations`                          | More than 300 mutations.                                                                                        |
| 426    | `op_version`                                  | Operation name or version not in the whitelist.                                                                 |
| 400    | `register_with_mutations` / `ledger_required` | Register sent with mutations, or mutations sent without a `ledgerId`.                                           |
| 200    | `ledgerMismatch` or `gone`                    | Described above.                                                                                                |
| 503    | `conflict`                                    | The commit guard failed three times in a row because concurrent writes kept changing the snapshot. Retry later. |

Each mutation runs at most once. A mutation whose `mid` is at or below the install's `lastMutationId` is skipped, so retries are safe. A mutation that fails its semantic check is rolled back and recorded in `rejections` as `{ mid, code, detail }`, but it still advances `lastMutationId`. The rejection codes are `target_deleted`, `field_changed`, `expect_failed`, `id_conflict` and `invalid`. All accepted mutations and the cursor update commit in one D1 batch, guarded by a compare-and-set on the head sequence.

## Operations

Every operation name ends in a version, currently `@1` for all of them. Each operation carries `at: { date }`, the business date on which the user acted; only `noop` and `fx_fill` may omit it.

| Operation       | Effect                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `noop`          | Nothing. Used to advance the mutation sequence.                                                                                                                                                                                                                                                                                                                                              |
| `patch`         | `fields: { name: { from, to } }` on `sub/`, `method/` or `kv/settings`. A field whose current value no longer equals `from` is rejected with `field_changed`. Only the fields in `PATCH_FIELDS` and the synced settings are allowed; billing rules, `proxy` and `renewalOffsetDays` go through the write tools.                                                                              |
| `create`        | Creates an object with `doc`. Creating an object that already exists with identical content succeeds; different content gives `id_conflict`.                                                                                                                                                                                                                                                 |
| `delete`        | Deletes a subscription or method. For a method, `into` moves its subscriptions to another method and `clear` sets them to unassigned, as the web delete does.                                                                                                                                                                                                                                |
| `replace`       | Replaces the whole document. `expect: { hash }` is the SHA-256 of the canonical JSON the client last saw.                                                                                                                                                                                                                                                                                    |
| `set_member`    | Adds or removes one entry (`add` or `remove`) in `kv/settings.publicHidden`.                                                                                                                                                                                                                                                                                                                 |
| `fx_fill`       | Fills in a missing dated exchange rate. Dates that already have a rate are left alone.                                                                                                                                                                                                                                                                                                       |
| `import_ledger` | Replaces the whole ledger with a device copy (`objects`, `recoveryId`). This is the "restore the server from this device" action.                                                                                                                                                                                                                                                            |
| Write intents   | An explicit whitelist (`SYNC_INTENTS` in [worker/sync-ops.ts](../worker/sync-ops.ts), following sync-design §4.2) of MCP write tools with the same names and arguments, run through the same engine. New MCP write tools do not join automatically. `save_subscription`, an unguarded whole-record save, is excluded; whole-record restores only go through `replace` with an expected hash. |

### Locators and expectations

Operations that change an inner record by position must carry `locate: { date, match, count }`. These are payment replace and delete, transfer replace and delete, and top-up update and delete. The server finds same-day records whose fields equal `match`. It uses the first one only when the number of hits equals the frozen `count`. Zero hits gives `target_deleted`, any other count gives `expect_failed`, and there is no fallback to an index. These operations, plus `set_status`, `set_meters`, `add_readings` and balance edits, must also name the same record in `target`. They also need `expect`: `status`, `meters`, `readings` (each input and deleted reading as the device saw it, or `{ id | date, absent: true }`), or `balance` and `balanceAsOf`. A mismatch is `expect_failed`, and missing protection is `invalid`.

### Patch nulls and same-ID creates

`patch` with `to: null` clears a field only if it is nullable (for example icon, URL, notes, account, method or lead days on subscriptions, and color, notes or balance expiry on methods). A cleared field is stored in that field's own empty form: an empty string for text fields, 0 for lead days, and `null` for the other nullable fields. Required fields such as name, category, tags and public-page flags reject `null` as `invalid`. A `create` for an ID that already exists compares only the keys it provides, and an explicit `null` counts as absent. For a subscription it compares name, price, currency, cycle, start date and method. For a method it also compares the balance and balance date.

`import_ledger` overwrites dated exchange rates with the device's values, as backup restore does. `fx_fill` never overwrites.

## Settings, paging and generations

Only the synced settings fields in `SYNC_SETTINGS` (currency, categories, week start, time zone, reminder defaults, display name and similar) leave the server, and only those can be patched. Notification credentials, public-page and navigation preferences, and language stay on each side.

A page holds at most 2 MiB of objects, counted in UTF-8 bytes (`PAGE_BYTES`); a single larger object gets a page of its own. The cookie's `gen` is the server's data generation. Restoring a backup, a replace-mode import, `import_ledger` and disaster recovery all rotate the generation, and the next pull then returns `full: true`.

## Concurrency with the web app and MCP

Every existing read-modify-write path (web REST writes, MCP write tools, assistant confirmations) runs inside a write guard ([worker/write-guard.ts](../worker/write-guard.ts)). The guard records the ledger revision when the request starts. Each write batch then begins with a compare-and-set against `sync_cas`. If a sync, another tab or an MCP call wrote first, the batch rolls back and the whole request is recomputed once on fresh data. If it conflicts again, the web API returns `409 { error, code: 'write_conflict' }` and an MCP tool returns a tool error. Backup, assistant chat, FX refresh and notification test requests are not guarded, and neither are scheduled jobs or migrations. Their behavior is unchanged.

`PUT /api/subscriptions/:id` also accepts `If-Match: "<updatedAt>"` (or `"-"` for a record without one). The web app sends it for existing subscriptions. A stale snapshot, or a record deleted elsewhere, gets 409 instead of overwriting newer data. Requests without the header behave as before.

## Physical rollback

After the database is rolled back by D1 Time Travel or by restoring a Docker volume, run `disasterRecovery(env)` from [worker/hosting.ts](../worker/hosting.ts) once before serving traffic again. It marks every install as gone and rotates the generation and `drEpoch`. Changes confirmed after the restore point are lost from the server. A device that still holds them can push them back with `import_ledger`.

## Tests

[scripts/sync-contract.test.mjs](../scripts/sync-contract.test.mjs) runs the 61 fixed cases and 40 seeded random-fault rounds from the native app's reference simulator against this implementation. The server runs on in-memory SQLite behind the same D1 adapter as Docker, and every case uses fictional data. [shared/sync.test.ts](../shared/sync.test.ts) covers the HTTP layer and validation, and [shared/write-guard.test.ts](../shared/write-guard.test.ts) covers the write guard. [scripts/sync-workerd.test.mjs](../scripts/sync-workerd.test.mjs) runs the bundled Worker in workerd through Miniflare with real D1 and real HTTP. It covers D1 rollback when a guarded update hits zero rows or a later statement fails, per-database migration, sync-token authentication, concurrent duplicate and conflicting requests, and concurrent web writes. It also compares a sync batch containing failing operations against another instance that applies only the successful tools through `/mcp`.
