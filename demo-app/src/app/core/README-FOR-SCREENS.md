# Client foundation — API for screen implementers

Read this before you build `/supervision`, `/chauffeur` or `/arret/:stopId`. The full spec is in `../../../../SPEC.md` (§7.3 describes the screens).

## Files

| File | Purpose |
|---|---|
| `core/config.ts` | `SPACETIMEDB_URI` (`ws://127.0.0.1:3000` in dev, the page origin in production), `DB_NAME` (`transit-demo`), `DEMO_SUPERVISOR_CODE` (`PCC2026`), `MAP_CENTER` (`[46.803, 7.152]`), `MAP_ZOOM` (14) |
| `core/spacetime.service.ts` | `SpacetimeService`: the single connection, signals that mirror the tables, reducer wrappers and subscriptions |
| `core/toast.service.ts` | `ToastService`: the toast queue, rendered by `<app-toast-host>` in the App root |
| `core/labels.ts` | French labels for the enums, plus formatters (delay, ETA, time, age) and sort helpers |
| `shared/connection-badge.ts` | `<app-connection-badge [dark]="true" [showIdentity]="false" />` |
| `features/supervision/supervision.ts` | `export class Supervision`, a placeholder for you to replace |
| `features/driver/driver.ts` | `export class Driver`, a placeholder for you to replace |
| `features/stop-board/stop-board.ts` | `export class StopBoard`, a placeholder for you to replace |

Keep the class names and file paths. `app.routes.ts` lazy-loads these exact files.

- **Routing:** `provideRouter(routes, withComponentInputBinding())`. On the stop board, declare `readonly stopId = input<string>()`. It arrives as a string, so convert it with `Number()`. An invalid or unknown id shows "Arrêt inconnu".
- **Kiosk route:** `arret/:stopId` has `data: { kiosk: true }`. The App shell hides its top bar there, so the stop board is full screen. Render your own small `<app-connection-badge [dark]="true" [showIdentity]="false" />` in the footer.
- **Top bar:** the shell already shows the brand, the nav links, the connection pill, `me().name` and a "Nouvelle identité" button. The bar is 48 px high (`h-12`) and `sticky`. For a full-height screen use `h-[calc(100vh-3rem)]`.
- **Zoneless app:** there is no zone.js. Templates must read signals only, never plain fields that SDK callbacks mutate. Use `ChangeDetectionStrategy.OnPush`.
- **Styling:** use Tailwind v4 utility classes. Keep component CSS tiny, because the `anyComponentStyle` budget warns at 8 kB.
- **Leaflet:** `leaflet.css` is already in the global `styles`. The default marker PNGs are copied to `/leaflet/`. Prefer `L.circleMarker` / `L.divIcon`. If you do use `L.marker` with the default icon, set `L.Icon.Default.imagePath = 'leaflet/'` first.
- **Leaflet import:** `import * as L from 'leaflet';`. It is listed in `allowedCommonJsDependencies`.
- **Leaflet layering:** keep the map below the top bar (`z-[1500]`) and the toasts (`z-[2000]`). Leaflet panes use z-index up to about 1000, so don't raise them.

## Using the service

```ts
private readonly stdb = inject(SpacetimeService);
private readonly sub = this.stdb.subscribeSupervision();   // or subscribeDriver() / subscribeStopBoard(id)
constructor() { inject(DestroyRef).onDestroy(() => this.sub.dispose()); }
```

### Connection and identity signals

| Member | Type | Notes |
|---|---|---|
| `status` | `Signal<'connecting' \| 'connected' \| 'reconnecting' \| 'disconnected' \| 'error'>` | |
| `isConnected` | `Signal<boolean>` | Disable action buttons while it is false |
| `identity` | `Signal<Identity \| undefined>` | |
| `identityHex` | `Signal<string \| undefined>` | |
| `lastError` | `Signal<string \| undefined>` | French message. On `status() === 'error'`, show "Serveur injoignable" and a "Réessayer" button that calls `retryConnection()` |
| `baseReady` | `Signal<boolean>` | The base subscription has been applied |
| `newIdentity()` | `void` | Clears this tab's token and reloads, which gives a new identity |
| `retryConnection()` | `void` | Reloads the page |
| `conn` | `DbConnection` | The raw SDK connection. Only use it for something the service does not cover |

The token is stored in **sessionStorage** under `transville:<SPACETIMEDB_URI>:transit-demo:token` (e.g. `transville:ws://127.0.0.1:3000:transit-demo:token` in dev). Each tab therefore has its own identity, except a tab made with "Dupliquer l'onglet". A rejected saved token is cleared and the page reloads once.

### Table signals

All of these are `Signal<readonly Row[]>`, rebuilt from the SDK cache once per transaction. Never mutate them: copy before sorting, as in `[...rows].sort(...)`. Row types come from `src/module_bindings/types.ts`.

| Signal | Row type | Filled by |
|---|---|---|
| `lines` | `Line {id, code, name, color}` | base (always) |
| `stops` | `Stop {id, name, lat, lon}` | base |
| `lineStops` | `LineStop {id, lineId, stopId, seq, distanceToNextM}` | base |
| `vehicles` | `Vehicle {id, label, lineId, model}` | base |
| `users` | `AppUser {identity, name, role, registeredAt}` | base |
| `simConfigs` | `SimConfig[]`. Use `simConfig()` for the singleton `{speedFactor, paused, tickCount, lastTickAt}` | base |
| `positions` | `VehiclePosition {vehicleId, lineId, lat, lon, heading, status, nextStopId, forward, delaySeconds, updatedAt}` | supervision, driver |
| `assignments` | `DriverAssignment {vehicleId, driverIdentity, driverName, claimedAt}` | supervision, driver |
| `presence` | `OnlinePresence {connectionId, identity, connectedAt}` | supervision |
| `incidents` | `Incident {id: bigint, kind, severity, status, lineId, vehicleId, lat, lon, description, reportedBy, reporterName, reportedAt, assignedTo?, assigneeName, escalations, updatedAt, resolvedAt?}` | all three screens |
| `stopEtas` | `StopEta {key, stopId, vehicleId, lineId, forward, destination, etaSeconds, disrupted, delaySeconds}` | stop board, server-filtered to one stop |
| `myMessages` | `DriverMessage {id: bigint, toDriver, vehicleId, fromName, body, sentAt, acknowledged, acknowledgedAt?}` | driver. This is a **view**: the server only returns the caller's messages |
| `supervisorMessages` | `DriverMessage` (last 50) | supervision. A view that returns `[]` unless the caller is a supervisor |
| `auditTrail` | `AuditLog {id: bigint, at, actor, actorName, action, details}` (last 100) | supervision. A view, supervisors only |
| `recentAlerts` | `RecentAlert` = `AlertEvent {kind, title, body, severity, lineId, at}` + `seq` (newest first, max 20) | from the event table `alertEvent`, which is in the supervision and driver subscriptions |

### Derived signals

| Member | Type |
|---|---|
| `simConfig` | `Signal<SimConfig \| undefined>` |
| `lineById` / `stopById` / `vehicleById` | `Signal<Map<number, Line / Stop / Vehicle>>` |
| `positionByVehicleId` / `assignmentByVehicleId` | `Signal<Map<number, VehiclePosition / DriverAssignment>>` |
| `userByIdentity` | `Signal<Map<string /*identity hex*/, AppUser>>` |
| `incidentById` | `Signal<Map<bigint, Incident>>` |
| `routeByLineId` | `Signal<Map<number, { lineStop: LineStop; stop: Stop }[]>>`, ordered by `seq` (use it for polylines) |
| `lineIdsByStopId` | `Signal<Map<number, Set<number>>>`, the lines serving each stop (stop-board banner) |
| `onlineIdentities` | `Signal<Set<string /*hex*/>>`. Use `onlineIdentities().has(a.driverIdentity.toHexString())` for "Chauffeur hors ligne" |
| `activeIncidents` | `Signal<Incident[]>`, status not Resolved |
| `me` | `Signal<AppUser \| undefined>`. Undefined means not registered (anonymous) |
| `myRole` | `Signal<'Supervisor' \| 'Driver' \| 'Passenger' \| undefined>` |
| `isSupervisor` / `isDriver` | `Signal<boolean>` |
| `myAssignment` | `Signal<DriverAssignment \| undefined>`. Needs `driverAssignment` subscribed (the driver and supervision subscriptions include it) |
| `unreadMessageCount` | `Signal<number>` |

### Subscriptions

The base subscription opens automatically when the service is constructed and covers `line, stop, lineStop, vehicle, appUser, simConfig`. Don't subscribe to those tables again.

| Method | Queries |
|---|---|
| `subscribeSupervision()` | `vehiclePosition, driverAssignment, incident, onlinePresence, supervisorMessages, auditTrail, alertEvent` |
| `subscribeDriver()` | `vehiclePosition, driverAssignment, incident, myMessages, alertEvent` |
| `subscribeStopBoard(stopId: number)` | `stopEta.where(stopId = X), incident` |
| `subscribe(queries: Query[], label?)` | Any typed queries, e.g. `[tables.incident]` (import `tables` from `src/module_bindings`) |

Each method returns `ScreenSubscription { ready: Signal<boolean>; dispose(): void }`. Call `dispose()` in `DestroyRef.onDestroy`.

On the stop board, when `stopId` changes, subscribe to the new stop **before** disposing the old one. You can do this in an `effect()`, keeping the previous handle in a local variable. Leaving a subscription removes its rows from the signals.

### Reducer wrappers

Every wrapper returns `Promise<boolean>`: `true` on success, `false` on failure. On failure the service has already shown an error toast with the server's French message, for example "Le Bus 101 est déjà pris par Paul." Calls are never retried, and each one fails immediately with "Non connecté au serveur" when the connection is down. Read results from the table signals, never from the reducer.

| Method | Server reducer / rules |
|---|---|
| `registerUser(name: string, role: 'Supervisor' \| 'Driver' \| 'Passenger', accessCode = '')` | `Supervisor` needs the code `PCC2026`. The name must be 2 to 40 characters. Leaving the Driver role releases the bus |
| `claimVehicle(vehicleId: number)` | Driver only. Atomic: one driver per bus and one bus per driver. Claiming your own bus again does nothing |
| `releaseVehicle()` | Driver holding a bus |
| `reportIncident(kind: 'Breakdown' \| 'Accident' \| 'Assault' \| 'PassengerIllness' \| 'Delay', description = '')` | Driver with a bus. The description is at most 280 characters and is **public** (UI hint: "Pas de données personnelles") |
| `injectRandomIncident()` | Supervisor |
| `takeIncident(incidentId: bigint)` | Supervisor. Only an Open incident can be taken; otherwise "Incident déjà pris en charge par X." |
| `resolveIncident(incidentId: bigint, note = '')` | Supervisor |
| `sendDriverMessage(vehicleId: number, body: string)` | Supervisor. The body is 1 to 280 characters. The bus needs a driver, otherwise "Aucun chauffeur sur ce véhicule." |
| `acknowledgeMessage(messageId: bigint)` | Driver who received the message |
| `setSimSpeed(factor: 1 \| 2 \| 5 \| 10)` | Supervisor |
| `setSimPaused(paused: boolean)` | Supervisor |
| `forceReleaseVehicle(vehicleId)` | Supervisor. Frees a bus held by an offline driver |
| `resetDemo()` | Supervisor. Ask for confirmation first |
| `call(() => promise)` | Generic wrapper, with the same toast handling as the others |

### Toasts and alerts (already wired, you don't need to do anything)

- **Alert events:** every `alertEvent` insert, i.e. "Nouvel incident", "Escalade", "Résolu" or "Démo réinitialisée", becomes a toast and is added to `recentAlerts`.
- **New driver messages:** a new **unread** `myMessages` row produces a "Nouveau message du PCC" toast and a 200 ms vibration. Messages loaded at subscription time or replayed after a reconnect don't trigger it, and a message only triggers it once per id.
- **Your own feedback:** `inject(ToastService).success('Véhicule pris')`, `.info(title, body?)`, `.error(title, body?)`, or `.push({ kind, title, body, severity })`.

## labels.ts quick reference

- **Enum labels** (keyed by the enum's `.tag`): `ROLE_LABELS`, `INCIDENT_KIND_LABELS`, `SEVERITY_LABELS`, `INCIDENT_STATUS_LABELS`, `VEHICLE_STATUS_LABELS`.
- **Example:** `INCIDENT_KIND_LABELS[i.kind.tag]`.
- **Incident kinds:** `INCIDENT_KINDS` is the ordered list for the five driver buttons.
- **Severity styling:** `SEVERITY_CLASSES` (Tailwind chip classes), `SEVERITY_COLORS` (hex values for map markers), `SEVERITY_RANK`.
- **Formatters:**
  - `formatDelay(s)` returns "À l'heure", "+2 min" or "-1 min".
  - `delayClass(s)` returns the Tailwind classes for the delay chip.
  - `formatEta(s)` returns "À quai" (under 30 s), "Proche" (under 60 s) or "N min".
  - `formatTime(ts)` returns "10:42:13" and `formatShortTime(ts)` returns "10:42".
  - `formatAge(ts, nowMs?)` returns "il y a 2 min". Pass a ticking clock signal's value so the text updates.
- **Sorting:** `byTimestampDesc(r => r.reportedAt)` is a comparator, and `tsMicros(ts)` gives the `bigint` microseconds.
- **Identity display:** `shortIdentity(hex)`.
- **Enum constructors** for raw calls: `role('Driver')`, `incidentKind('Breakdown')`.

## Gotchas

- **bigint values:** ids (`Incident.id`, `DriverMessage.id`, `AuditLog.id`) and `SimConfig.tickCount` are `bigint`. Use `String(x)` in templates, `track m.id` works, and compare with `===` between bigints.
- **Enums:** they are tagged objects, so compare with `x.status.tag === 'Open'`.
- **Identity comparison:** use `a.isEqual(b)` or compare `toHexString()`. Never compare objects with `===`.
- **Timestamp display:** use `ts.toDate()` to show a timestamp and `ts.microsSinceUnixEpoch` to sort by one. Never order rows by auto-inc ids.
- **Changed view rows:** a changed view row, such as an acknowledged message, may arrive as delete followed by insert. The signals are rebuilt from `iter()`, so this is handled.
- **Same tab, one role:** a tab has one identity and therefore one role. Before calling `registerUser`, the driver screen must check `myRole() === 'Supervisor'`, and the reverse check applies on the supervision screen (SPEC §7.3).
- **Stop board time:** the stop-board clock is client-side (`setInterval` updating a signal). ETAs are in simulated seconds.
