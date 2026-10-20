# TransVille Live — Implementation Spec

Real-time operations centre (PCC, *poste de commande centralisé*) of a **fictional** public-transport operator, "TransVille", running on the real geography of Fribourg (CH). It is built to show SpacetimeDB as the **entire backend** (database + server logic + realtime sync) to a company that builds business apps for public transport, police and insurers.

- Module: C# (`/Users/johnattan.baillod/dev/demo-spacetimedb/spacetimedb/Lib.cs`, may be split into several `partial class Module` files), net8.0, `SpacetimeDB.Runtime` 2.12.
- Client: Angular 22 (`/Users/johnattan.baillod/dev/demo-spacetimedb/demo-app`), standalone components, signals, Tailwind v4, Leaflet, `spacetimedb` TS SDK 2.12.
- Database name: `transit-demo` on the **local** server (`--server local`). Never maincloud.
- Code identifiers in English, **all UI text in French**. Server error messages (thrown exceptions) are in French because they are surfaced to the user verbatim.

---

## 0. Build / run cheat-sheet

```bash
export DOTNET_ROOT=$HOME/.dotnet PATH=$HOME/.dotnet:$PATH
cd /Users/johnattan.baillod/dev/demo-spacetimedb
spacetime build -p ./spacetimedb
spacetime publish transit-demo --server local -p ./spacetimedb --yes            # add --delete-data=always on breaking schema change
spacetime generate --lang typescript --out-dir ./demo-app/src/module_bindings -p ./spacetimedb --yes
spacetime logs --no-config transit-demo --server local -f
spacetime sql --no-config transit-demo --server local "SELECT * FROM sim_config"
spacetime call --no-config transit-demo --server local register_user '"Marie"' '{"supervisor":[]}' '"PCC2026"'
cd demo-app && npm start   # http://localhost:4200
```

Server-side canonical table/column names are **snake_case** (`sim_config`, `vehicle_position`, `stop_id`); the CLI SQL also accepts the PascalCase accessor (`SimConfig`), verified on 2.12. Private tables are readable from the CLI because the CLI identity owns the local database.

Note: `spacetime.json` defaults to maincloud and `spacetime.local.json` names another database (`demo-app-rwnqq`) — always pass `transit-demo --server local` explicitly, **and `--no-config` for `sql`/`call`/`logs`** (verified: without it `spacetime sql transit-demo ...` fails with `failed to find database demo-app-rwnqq`). In CLI JSON arguments, enum variants are **camelCase** (`{"driver":[]}`, `{"breakdown":[]}`, `{"passengerIllness":[]}`); in TS bindings tags stay PascalCase (`{ tag: 'Driver' }`). Do not edit `global.json`, do not retarget to net10.

---

## 1. Domain types (`[SpacetimeDB.Type]`)

```csharp
[SpacetimeDB.Type] public enum Role { Supervisor, Driver, Passenger }
[SpacetimeDB.Type] public enum IncidentKind { Breakdown, Accident, Assault, PassengerIllness, Delay }
[SpacetimeDB.Type] public enum IncidentSeverity { Low, Medium, High, Critical }
[SpacetimeDB.Type] public enum IncidentStatus { Open, InProgress, Resolved }
[SpacetimeDB.Type] public enum VehicleStatus { EnRoute, AtStop, Layover, Immobilized }
```

French labels (client side, `src/app/core/labels.ts`):

| Enum value | FR label |
|---|---|
| Role.Supervisor / Driver / Passenger | Superviseur PCC / Chauffeur / Voyageur |
| Breakdown / Accident / Assault / PassengerIllness / Delay | Panne / Accident / Agression / Voyageur malaise / Retard |
| Low / Medium / High / Critical | Faible / Moyenne / Haute / Critique |
| Open / InProgress / Resolved | Ouvert / Pris en charge / Résolu |
| EnRoute / AtStop / Layover / Immobilized | En ligne / À l'arrêt / Battement au terminus / Immobilisé |

TS bindings represent C# enums as tagged objects (`{ tag: 'Open' }`). Compare with `x.tag === 'Open'`; construct as `{ tag: 'Breakdown' }` (check the exact shape in the generated `module_bindings/types` before coding).

---

## 2. Tables

Conventions: `Accessor` = PascalCase struct name. Seeded reference ids are `uint` (→ `number` in TS). Auto-inc ids are `ulong` (→ `bigint` in TS) and are **never used for ordering** — every ordered table has a `Timestamp` column. In TS, generated row fields are camelCase (`LineId` → `lineId`). Subscribe with the typed query builder (`tables.vehiclePosition`) rather than raw SQL so name casing never matters.

### 2.1 Reference network (public, written only by Init/ResetDemo)

**Line** — `[Table(Accessor="Line", Public=true)]`
| Column | Type | Attr |
|---|---|---|
| Id | uint | PrimaryKey |
| Code | string | e.g. "1" |
| Name | string | e.g. "Marly – Saint-Léonard" |
| Color | string | hex "#D7263D" |

**Stop** — `[Table(Accessor="Stop", Public=true)]`
| Id uint PrimaryKey | Name string | Lat double | Lon double |

**LineStop** (ordered route) — `[Table(Accessor="LineStop", Public=true)]`
| Column | Type | Attr |
|---|---|---|
| Id | uint | PrimaryKey (seeded `LineId*100+Seq`) |
| LineId | uint | `[SpacetimeDB.Index.BTree]` |
| StopId | uint | `[SpacetimeDB.Index.BTree]` |
| Seq | uint | 0..n-1, ordering of stops on the line |
| DistanceToNextM | double | metres to Seq+1 (0 for last), precomputed at seed |

Server code loads a line's route with `ctx.Db.LineStop.LineId.Filter(lineId).OrderBy(s => s.Seq).ToList()`.

**Vehicle** (metadata, rarely changes) — `[Table(Accessor="Vehicle", Public=true)]`
| Id uint PrimaryKey | Label string ("Bus 101") | LineId uint BTree | Model string ("Articulé 18 m") |

### 2.2 Live vehicle state (access-pattern split)

**VehiclePosition** (hot, public, rewritten every tick) — `[Table(Accessor="VehiclePosition", Public=true)]`
| Column | Type | Notes |
|---|---|---|
| VehicleId | uint | PrimaryKey (= Vehicle.Id) |
| LineId | uint | denormalised for map filtering |
| Lat, Lon | double | |
| Heading | double | degrees, 0 = north (marker rotation, optional) |
| Status | VehicleStatus | |
| NextStopId | uint | |
| Forward | bool | true = Seq ascending |
| DelaySeconds | int | positive = late |
| UpdatedAt | Timestamp | ctx.Timestamp of last tick |

**VehicleSimState** (private, simulation internals clients never need) — `[Table(Accessor="VehicleSimState")]`
| Column | Type | Notes |
|---|---|---|
| VehicleId | uint | PrimaryKey |
| FromSeq | int | Seq of the stop the vehicle last left / is at |
| Forward | bool | |
| ProgressM | double | metres covered on segment FromSeq → FromSeq±1 |
| DwellRemainingS | double | >0 = standing at stop FromSeq |
| LayoverRemainingS | double | >0 = at terminus before turning |
| TripElapsedS | double | simulated seconds since trip start |
| PlannedElapsedS | double | timetable seconds for current position |

**DriverAssignment** (public; atomic claim) — `[Table(Accessor="DriverAssignment", Public=true)]`
| Column | Type | Attr |
|---|---|---|
| VehicleId | uint | PrimaryKey → one driver per bus |
| DriverIdentity | Identity | `[Unique]` → one bus per driver |
| DriverName | string | denormalised for lists |
| ClaimedAt | Timestamp | |

### 2.3 Users & presence

**AppUser** (public — names/roles are not sensitive in this demo) — `[Table(Accessor="AppUser", Public=true)]`
| Identity Identity PrimaryKey | Name string | Role Role | RegisteredAt Timestamp |

An identity without an `AppUser` row is an anonymous **passenger** (stop boards). `Role.Passenger` exists for completeness but the UI never registers it.

**OnlinePresence** (public) — `[Table(Accessor="OnlinePresence", Public=true)]`
| ConnectionId ConnectionId PrimaryKey | Identity Identity BTree | ConnectedAt Timestamp |

Online = at least one presence row for the identity. A driver with an assignment but no presence is shown as "Chauffeur hors ligne".

**DemoSetting** (private — never replicated, demonstrates private tables) — `[Table(Accessor="DemoSetting")]`
| Key string PrimaryKey | Value string |
Seeded: `("supervisor_code", "PCC2026")`.

### 2.4 Operations

**Incident** (public — map markers, stop-board banners) — `[Table(Accessor="Incident", Public=true)]`
| Column | Type | Attr / notes |
|---|---|---|
| Id | ulong | PrimaryKey, AutoInc |
| Kind | IncidentKind | |
| Severity | IncidentSeverity | |
| Status | IncidentStatus | |
| LineId | uint | BTree |
| VehicleId | uint | BTree; 0 = no vehicle |
| Lat, Lon | double | position at report time |
| Description | string | ≤ 280 chars, may be "" |
| ReportedBy | Identity | |
| ReporterName | string | |
| ReportedAt | Timestamp | ordering column |
| AssignedTo | Identity? | null until taken in charge |
| AssigneeName | string | "" until taken |
| Escalations | uint | number of automatic escalations |
| UpdatedAt | Timestamp | |
| ResolvedAt | Timestamp? | |

`Identity?` / `Timestamp?` columns are **verified** on 2.12: they compile, publish, and generate `t.option(...)` → `Identity | undefined` / `Timestamp | undefined` in TS. Use them as-is (no bool-flag fallback needed).

**Retention**: at most `MaxResolvedIncidents = 30` resolved incidents are kept. `ResolveIncident` deletes the oldest resolved ones (by `ResolvedAt`) beyond that, so a long demo with "Injecter un incident" spam keeps the board, map and the stop-board `incident` subscription small.

**IncidentEscalation** (private scheduled) — `[Table(Accessor="IncidentEscalation", Scheduled=nameof(EscalateIncident), ScheduledAt=nameof(ScheduledAt))]`
| ScheduledId ulong PrimaryKey AutoInc | ScheduledAt ScheduleAt | IncidentId ulong BTree |

**DriverMessage** (private; exposed through views) — `[Table(Accessor="DriverMessage")]`
| Column | Type | Attr |
|---|---|---|
| Id | ulong | PrimaryKey, AutoInc |
| ToDriver | Identity | BTree |
| VehicleId | uint | |
| FromName | string | supervisor name |
| Body | string | 1..280 chars |
| SentAt | Timestamp | BTree (ordering + range scan in views) |
| Acknowledged | bool | |
| AcknowledgedAt | Timestamp? | |

**Retention**: `SendDriverMessage` keeps at most `MaxMessages = 200` rows (deletes oldest by `SentAt` beyond that, same transaction).

**AuditLog** (private; exposed only to supervisors through a view) — `[Table(Accessor="AuditLog")]`
| Column | Type | Attr |
|---|---|---|
| Id | ulong | PrimaryKey, AutoInc |
| At | Timestamp | BTree — ordering + range scan |
| Actor | Identity | |
| ActorName | string | "Système" for scheduled reducers |
| Action | string | code, e.g. `INCIDENT_REPORTED` |
| Details | string | French human-readable sentence |

**Retention (mandatory — the demo may run for hours, and every AuditTrail re-evaluation range-scans this table)**: the `Audit()` helper trims the table in the same transaction: if `ctx.Db.AuditLog.Count > MaxAuditRows (500)`, materialise `ctx.Db.AuditLog.At.Filter((new Timestamp(0), new Timestamp(long.MaxValue))).OrderBy(a => a.At.MicrosecondsSinceUnixEpoch).ThenBy(a => a.Id)` and delete the oldest rows until Count == MaxAuditRows. (O(500) per business action — trivial; the tick never audits.)

**AlertEvent** (public **event table**, toasts) — `[Table(Accessor="AlertEvent", Public=true, Event=true)]`
| Kind string ("incident", "escalation", "resolved", "system") | Title string | Body string | Severity IncidentSeverity | LineId uint (0 = all) | At Timestamp |
No PK. Rows are never cached client-side; only `onInsert` fires (verified: `Event = true` publishes with `is_event: true` and the TS binding is generated with `event: true`). Clients must still **subscribe** to `tables.alertEvent` to receive inserts.
**Privacy rule**: AlertEvent is public and broadcast to every subscriber — never put driver-message bodies, reporter descriptions or anything per-user in it. There is deliberately **no "message" kind**: a driver learns about a new PCC message through the `MyMessages` view (§4), never through this table.

### 2.5 Simulation control

**SimConfig** (public singleton) — `[Table(Accessor="SimConfig", Public=true)]`
| Id uint PrimaryKey (always 0) | SpeedFactor uint (1, 2, 5, 10) | Paused bool | TickCount ulong | LastTickAt Timestamp |

**SimTick** (private scheduled, repeating) — `[Table(Accessor="SimTick", Scheduled=nameof(SimulationTick), ScheduledAt=nameof(ScheduledAt))]`
| ScheduledId ulong PrimaryKey AutoInc | ScheduledAt ScheduleAt |
Exactly one row, `new ScheduleAt.Interval(TimeSpan.FromSeconds(1))`.

**StopEta** (public, maintained by the tick) — `[Table(Accessor="StopEta", Public=true)]`
| Column | Type | Attr |
|---|---|---|
| Key | string | PrimaryKey — `$"{StopId}-{VehicleId}-{(Forward?"F":"B")}"` |
| StopId | uint | BTree (stop board subscribes `where stopId = X`) |
| VehicleId | uint | BTree (tick diffing) |
| LineId | uint | |
| Forward | bool | |
| Destination | string | name of last stop in that direction (*Direction …*) |
| EtaSeconds | int | simulated seconds, rounded down to 10 s |
| Disrupted | bool | vehicle immobilised |
| DelaySeconds | int | copy of vehicle delay |

---

## 3. Reducers

**Naming rule (verified, compile error `STDB0010`)**: reducer method names must **not** start with `On` (reserved prefix). Lifecycle reducers are therefore named `Init`, `ClientConnected`, `ClientDisconnected`.

**Determinism rule**: no `DateTime.Now`, `Stopwatch`, `Guid.NewGuid()`, `new Random()`, `Environment.TickCount`, file/network I/O in any reducer or view. Time = `ctx.Timestamp`, randomness = `ctx.Rng`. Iterate in an explicit order (`OrderBy(Id)`) before consuming `ctx.Rng`, never over a `Dictionary`/`HashSet` enumeration.

Helpers (not reducers, `private static`):
- `AppUser RequireRole(ReducerContext ctx, Role role)` — `ctx.Db.AppUser.Identity.Find(ctx.Sender)`; throws `"Accès refusé : rôle {label} requis."` if missing or wrong role.
- `void Audit(ReducerContext ctx, string actorName, string action, string details)` — inserts `AuditLog { Id=0, At=ctx.Timestamp, Actor=ctx.Sender, ... }`, then trims to `MaxAuditRows` (§2.4). **Called in the same reducer (thus same transaction) as every business mutation**; if the reducer throws, the audit row is rolled back too.
- `void Alert(ReducerContext ctx, string kind, string title, string body, IncidentSeverity sev, uint lineId)` — inserts into `AlertEvent`.
- `void RequireScheduler(ReducerContext ctx)` — `if (ctx.Sender != ctx.DatabaseIdentity) throw new Exception("Réservé au planificateur.");` (`ctx.DatabaseIdentity` verified to exist on 2.12). Scheduled reducers are omitted from generated client bindings but remain callable by name (e.g. `spacetime call`), hence the guard.
- `string CleanText(string s, int min, int max, string field)` — trims, validates length, throws French message.

| Reducer | Signature | Authorization | Validation | Side effects (all atomic) | Audit action |
|---|---|---|---|---|---|
| Init | `[Reducer(ReducerKind.Init)] Init(ctx)` | — | — | Seed Line, Stop, LineStop (with distances), Vehicle, VehicleSimState + VehiclePosition (via `SeedVehicles`), SimConfig{0,1,false,0,ctx.Timestamp}, SimTick (1 s interval), DemoSetting | `DEMO_INIT` |
| ClientConnected | `[Reducer(ReducerKind.ClientConnected)] ClientConnected(ctx)` | — | `ctx.ConnectionId` is `ConnectionId?`: return if null | Insert `OnlinePresence` (delete existing row with same ConnectionId first, defensive) | none (noise) |
| ClientDisconnected | `[Reducer(ReducerKind.ClientDisconnected)] ClientDisconnected(ctx)` | — | null check | Delete presence by ConnectionId. Assignment kept (driver can reconnect). | none |
| RegisterUser | `(ctx, string name, Role role, string accessCode)` | anyone, identity = `ctx.Sender` | name 2..40 chars; `Supervisor` requires `accessCode == DemoSetting["supervisor_code"]` else `"Code d'accès PCC invalide."`; `Passenger` allowed without code | Insert or update `AppUser` (key = `ctx.Sender`; the client never passes an identity). If role changes away from Driver, delete the caller's `DriverAssignment`. If role changes away from Supervisor, nothing else to clean (views re-check the role on every evaluation). **Documented demo rule**: Driver = self-service (anyone may become a driver); Supervisor = knowledge of the shared demo code stored in the private `DemoSetting` table. The role is decided and stored server-side only — the client's idea of its role is never trusted. | `USER_REGISTERED` "X s'est connecté(e) en tant que Superviseur PCC" |
| ClaimVehicle | `(ctx, uint vehicleId)` | Driver | vehicle exists; if `DriverAssignment.VehicleId.Find(vehicleId)` belongs to someone else → `"Le Bus 101 est déjà pris par {name}."` | If caller already holds another bus (`DriverIdentity.Find(ctx.Sender)`) delete it first, then insert assignment. PK + Unique constraints make double-claim impossible even under concurrency. | `VEHICLE_CLAIMED` |
| ReleaseVehicle | `(ctx)` | Driver | must hold a vehicle | Delete assignment | `VEHICLE_RELEASED` |
| ForceReleaseVehicle | `(ctx, uint vehicleId)` | Supervisor | vehicle exists; no assignment → `"Le Bus 101 n'a pas de chauffeur."` | Delete the bus's `DriverAssignment` (frees a bus held by an offline/ghost driver). UI: "Libérer" button on vehicle rows whose driver is offline. | `VEHICLE_RELEASED` "X a libéré le Bus 101 (retiré à Y)." |
| ReportIncident | `(ctx, IncidentKind kind, string description)` | Driver with an assignment (`"Vous devez d'abord prendre un véhicule."`) | description 0..280 | Insert `Incident{Status=Open, Severity=DefaultSeverity(kind), LineId/VehicleId from assignment, Lat/Lon from VehiclePosition, ReportedAt=ctx.Timestamp}`; insert `IncidentEscalation{ScheduledAt=Time(ctx.Timestamp + 30 s), IncidentId}`; Alert("incident", "Nouvel incident : Panne", "Bus 101 – Ligne 1 – {stop}") | `INCIDENT_REPORTED` |
| InjectRandomIncident | `(ctx)` | Supervisor | at least one vehicle | Pick vehicle `ctx.Rng.Next(0, n)` on ordered list, kind `ctx.Rng.Next(0,5)`, description from a fixed French list indexed by rng; same as ReportIncident (ReporterName "Simulation") | `INCIDENT_INJECTED` |
| TakeIncident | `(ctx, ulong incidentId)` | Supervisor | exists; `Status == Open` else `"Incident déjà pris en charge par {AssigneeName}."` (atomic: two supervisors clicking at once → exactly one wins) | Status=InProgress, AssignedTo=ctx.Sender, AssigneeName, UpdatedAt; delete its `IncidentEscalation` rows (`IncidentId.Filter`) | `INCIDENT_TAKEN` |
| ResolveIncident | `(ctx, ulong incidentId, string note)` | Supervisor | exists; not Resolved; note 0..280 | If still Open, also set AssignedTo/AssigneeName = caller (so a resolved incident always has an owner). Status=Resolved, ResolvedAt, UpdatedAt; delete pending escalations; trim resolved incidents to `MaxResolvedIncidents`; vehicle is released by the tick automatically (see §5); Alert("resolved") | `INCIDENT_RESOLVED` (note in Details) |
| EscalateIncident | `(ctx, IncidentEscalation row)` scheduled | `RequireScheduler` | incident exists and `Status == Open`, else no-op | Severity+1 (cap Critical), Escalations++, UpdatedAt; if still < Critical insert a new escalation +30 s; Alert("escalation", "Escalade : incident non pris en charge") | `INCIDENT_ESCALATED` actor "Système" |
| SendDriverMessage | `(ctx, uint vehicleId, string body)` | Supervisor | body 1..280; vehicle has an assignment else `"Aucun chauffeur sur ce véhicule."` | Insert `DriverMessage{ToDriver=assignment.DriverIdentity, SentAt=ctx.Timestamp}` (recipient resolved server-side from the assignment, never from an argument); trim to `MaxMessages`. No AlertEvent (privacy). | `MESSAGE_SENT` (Details contains vehicle, not the body) |
| AcknowledgeMessage | `(ctx, ulong messageId)` | Driver | message exists **and `ToDriver == ctx.Sender`** else `"Message introuvable."` (do not leak existence); idempotent | Acknowledged=true, AcknowledgedAt | `MESSAGE_ACK` |
| SetSimSpeed | `(ctx, uint factor)` | Supervisor | factor ∈ {1,2,5,10} | update SimConfig | `SIM_SPEED` |
| SetSimPaused | `(ctx, bool paused)` | Supervisor | — | update SimConfig | `SIM_PAUSE` |
| ResetDemo | `(ctx)` | Supervisor | — | Delete all Incident, IncidentEscalation, DriverMessage, StopEta, AuditLog; re-run `SeedVehicles` (overwrite SimState/Position); SimConfig speed 1, unpaused; ensure exactly one SimTick row exists. Keep AppUser and OnlinePresence. Delete every DriverAssignment whose DriverIdentity has no OnlinePresence row (closed driver tabs never come back: their identity lived in sessionStorage); online drivers keep their bus. Alert("system", "Démo réinitialisée") | `DEMO_RESET` (inserted after the wipe), plus `VEHICLE_RELEASED` "N véhicule(s) libéré(s) : chauffeur(s) hors ligne." when ghosts were freed |
| SimulationTick | `(ctx, SimTick row)` scheduled | `RequireScheduler` | — | §5 | none (would flood the log) |

`DefaultSeverity`: Accident, Assault → High; Breakdown, PassengerIllness → Medium; Delay → Low.

Deletion loops: materialise first (`.ToList()`) before deleting while iterating.

---

## 4. Views (per-user, read-only)

All views are `public static`, `Public = true`, and only use indexed `Find`/`Filter` (verified: `Iter()` does not exist on read-only handles — `CS1061 'XxxReadOnly' does not contain a definition for 'Iter'`). Result order from a view is **not** guaranteed — clients sort by timestamp.

Every view declares `PrimaryKey = nameof(Row.Id)` (verified to compile on 2.12). Without it the client sees a row change (e.g. `Acknowledged` flipping) as **delete + insert**, so `myMessages.onInsert` would fire again and re-toast an already-read message; with it the client receives `onUpdate`. **Verified on 2.12: the view `PrimaryKey` compiles and publishes, but the generated TS bindings list NO constraint/index for the view tables (`constraints: []`)** — so assume a changed view row arrives as delete + insert on the client. The client-side de-duplication of §7.2 (`seenMessageIds`) is therefore mandatory, and lists must be rebuilt from `iter()` rather than patched by id.

```csharp
// Driver privacy: a driver only ever receives their own messages.
[SpacetimeDB.View(Accessor = "MyMessages", Public = true, PrimaryKey = nameof(DriverMessage.Id))]
public static List<DriverMessage> MyMessages(ViewContext ctx)
    => ctx.Db.DriverMessage.ToDriver.Filter(ctx.Sender).ToList();

// Supervisors see the full message log (ack status); everyone else gets [].
[SpacetimeDB.View(Accessor = "SupervisorMessages", Public = true, PrimaryKey = nameof(DriverMessage.Id))]
public static List<DriverMessage> SupervisorMessages(ViewContext ctx)
{
    if (ctx.Db.AppUser.Identity.Find(ctx.Sender) is not { Role: Role.Supervisor }) return new();
    return ctx.Db.DriverMessage.SentAt
        .Filter((new Timestamp(0), new Timestamp(long.MaxValue)))
        .OrderByDescending(m => m.SentAt.MicrosecondsSinceUnixEpoch).Take(50).ToList();
}

// Audit trail: supervisors only, last 100 entries.
[SpacetimeDB.View(Accessor = "AuditTrail", Public = true, PrimaryKey = nameof(AuditLog.Id))]
public static List<AuditLog> AuditTrail(ViewContext ctx)
{
    if (ctx.Db.AppUser.Identity.Find(ctx.Sender) is not { Role: Role.Supervisor }) return new();
    return ctx.Db.AuditLog.At
        .Filter((new Timestamp(0), new Timestamp(long.MaxValue)))
        .OrderByDescending(a => a.At.MicrosecondsSinceUnixEpoch).Take(100).ToList();
}
```

Because the views read `AppUser`, a user who registers as supervisor sees the audit trail appear live without resubscribing.
The timestamp range `Filter((Timestamp, Timestamp))` on a read-only BTree index and the `is not { Role: Role.Supervisor }` pattern on a nullable row are **verified** to compile on 2.12. The range scan reads the whole table, which is why AuditLog/DriverMessage are capped (§2.4). (Historical fallback, should not be needed: add `[SpacetimeDB.Index.BTree] public byte Partition;` (always 0) to `AuditLog`/`DriverMessage` and use `.Partition.Filter((byte)0)`.)

`ClientVisibilityFilter` (RLS) is **not used**: in C# 2.12 it is behind `STDB_UNSTABLE` (verified: compile error unless `#pragma warning disable STDB_UNSTABLE`), and views express the role check more clearly. Mention it orally as the alternative (`SELECT * FROM DriverMessage WHERE ToDriver = :sender` would be the RLS equivalent; RLS SQL must be `SELECT * FROM t [JOIN ...] WHERE ...` selecting one whole table). Views must not read hot tables (`VehiclePosition`, `StopEta`, `SimConfig`): they would be re-evaluated for every subscriber on every tick.

---

## 5. Simulation algorithm (`SimulationTick`)

Constants: `NominalSpeedMps = 6.0` (21.6 km/h urban average), `PlannedDwellS = 20`, `LayoverS = 60`, `EtaHorizonS = 1800`, `EscalationDelay = 30 s` (real time).

Geometry: routes are straight segments between consecutive stops (no road snapping). Distance: equirectangular approximation, accurate enough at city scale:
`dx = (lon2-lon1) * 111_320 * cos(46.80° in rad)`, `dy = (lat2-lat1) * 110_540`, `d = sqrt(dx²+dy²)` → stored in `LineStop.DistanceToNextM` at seed.

Per tick:
1. `RequireScheduler`. Load SimConfig; if `Paused` return. `dt = SpeedFactor` simulated seconds. `TickCount++`, `LastTickAt = ctx.Timestamp`.
2. Cache routes: `Dictionary<uint, List<LineStop>>` per line (sorted by Seq), stop dictionary for names/coords.
3. For each `VehicleSimState s` (materialise `ctx.Db.VehicleSimState.Iter().OrderBy(v => v.VehicleId).ToList()` so Rng consumption order is deterministic):
   - **Blocking incidents**: find unresolved incidents of the vehicle (`ctx.Db.Incident.VehicleId.Filter(id)` where Status != Resolved). Kinds Breakdown/Accident/Assault/PassengerIllness → `immobilized`; Delay → `speedFactor = 0.5`.
   - `s.TripElapsedS += dt` (always, delay accrues while immobilised or dwelling longer than planned).
   - If immobilized: status Immobilized, no movement.
   - Else consume `budget = dt` seconds in a loop (handles large dt crossing several stops):
     - If `LayoverRemainingS > 0`: consume; when it hits 0 → flip `Forward`, start new trip (`TripElapsedS = PlannedElapsedS = 0`, FromSeq stays at terminus). Status Layover.
     - Else if `DwellRemainingS > 0`: consume. Status AtStop.
     - Else move: `v = NominalSpeedMps * speedFactor * (0.80 + 0.30 * ctx.Rng.NextDouble())` (drawn once per vehicle per tick). Advance `ProgressM += v * budgetSlice`. When `ProgressM >= segmentLength`: carry the excess time over, `FromSeq = next`, `ProgressM = 0`; if next is terminus → `LayoverRemainingS = LayoverS`, else `DwellRemainingS = 12 + ctx.Rng.NextDouble() * 18` (12–30 s, planned 20).
   - `PlannedElapsedS` = Σ planned segment times (`dist/NominalSpeedMps`) of completed segments in this trip + `PlannedDwellS` × stops served (excluding origin) + `ProgressM / NominalSpeedMps`.
   - `DelaySeconds = (int)Math.Round(TripElapsedS - PlannedElapsedS)`; on a new trip delay restarts at 0 (layover absorbs delay — say this in the demo).
   - Position: interpolate lat/lon between `FromSeq` stop and next stop by `ProgressM/segmentLength`; Heading = atan2 bearing. NextStopId = next stop (or the current stop while dwelling).
   - Update `VehicleSimState` and `VehiclePosition` (by PK `Update`), `UpdatedAt = ctx.Timestamp`.
4. **StopEta** for that vehicle (server-side so the stop board is a trivial subscription):
   - Walk forward from the vehicle's position: `t = time to finish current segment at nominal speed` (+ remaining dwell/layover). For each subsequent stop in the current direction add `segment/NominalSpeedMps` per segment and `PlannedDwellS` per intermediate stop. A stop where the vehicle is currently dwelling gets `t = 0` ("À quai").
   - Do **not** emit the last stop of a direction (no departures from the arrival terminus). At the terminus add `LayoverS` and continue with the reverse direction (emits the terminus as first departure of the other direction). Stop when `t > EtaHorizonS` or the reverse direction is complete.
   - `EtaSeconds = (int)(t / 10) * 10`; `Disrupted = immobilized`; `Destination` = last stop name of that direction.
   - Diff against existing rows `ctx.Db.StopEta.VehicleId.Filter(id).ToList()`: update by `Key` only when EtaSeconds/Disrupted/DelaySeconds changed, delete keys no longer present, insert new ones. Clients therefore receive `onUpdate` rather than delete+insert churn.
5. ETAs are in **simulated** seconds; at SpeedFactor 1 they equal wall-clock seconds. The board shows minutes `ceil(EtaSeconds/60)`; 0 → "À quai", < 60 → "Proche", Disrupted → "Perturbé".

`SeedVehicles(ctx)`: deterministic starting states (no Rng) so reset is reproducible:

| Vehicle | Line | Forward | FromSeq | ProgressM |
|---|---|---|---|---|
| 101 | 1 | true | 0 | 0 (layover 10 s) |
| 102 | 1 | false | 4 | 200 |
| 201 | 2 | true | 1 | 300 |
| 202 | 2 | false | 6 | 100 |
| 301 | 3 | true | 2 | 150 |

Delay colour code (client): ≤ 60 s green "À l'heure", 61–180 s orange "+N min", > 180 s red "+N min".

---

## 6. Seed data — Fribourg (fictional operator, approximate real coordinates)

Stops (shared stops make multi-line boards interesting — Gare serves 3 lines):

| Id | Name | Lat | Lon |
|---|---|---|---|
| 1 | Marly, Centre | 46.7765 | 7.1595 |
| 2 | Marly, Gérine | 46.7835 | 7.1555 |
| 3 | Pérolles, Université | 46.7935 | 7.1545 |
| 4 | Charmettes | 46.7985 | 7.1525 |
| 5 | Fribourg, Gare | 46.8030 | 7.1513 |
| 6 | Miséricorde | 46.8065 | 7.1495 |
| 7 | Saint-Léonard | 46.8165 | 7.1555 |
| 8 | Villars-sur-Glâne, Moncor | 46.7925 | 7.1215 |
| 9 | Hôpital cantonal | 46.7995 | 7.1325 |
| 10 | Beauregard | 46.7995 | 7.1435 |
| 11 | Place Georges-Python | 46.8048 | 7.1565 |
| 12 | Tilleul / Cathédrale | 46.8062 | 7.1625 |
| 13 | Pont de Zaehringen | 46.8080 | 7.1660 |
| 14 | Schoenberg | 46.8125 | 7.1775 |
| 15 | Jura | 46.8155 | 7.1440 |
| 16 | Guintzet | 46.8085 | 7.1430 |
| 17 | Basse-Ville, Planche | 46.8025 | 7.1650 |
| 18 | Bourguillon | 46.7990 | 7.1790 |

Lines:

| Id | Code | Name | Color | Stops (Seq order) |
|---|---|---|---|---|
| 1 | 1 | Marly – Saint-Léonard | #D7263D | 1, 2, 3, 4, 5, 6, 7 |
| 2 | 2 | Moncor – Schoenberg | #1B65A6 | 8, 9, 10, 5, 11, 12, 13, 14 |
| 3 | 3 | Jura – Bourguillon | #F18F01 | 15, 16, 6, 5, 11, 17, 18 |

Vehicles: 101 & 102 (line 1, "Articulé 18 m"), 201 & 202 (line 2, "Standard 12 m"), 301 (line 3, "Midibus 10 m"). Labels "Bus 101" etc.

---

## 7. Client architecture (Angular)

### 7.1 Files

```
src/app/
  core/config.ts                 SPACETIMEDB_URI = 'ws://127.0.0.1:3000', DB_NAME = 'transit-demo'
  core/spacetime.service.ts      SpacetimeService (below)
  core/labels.ts                 FR labels, delay/ETA formatters (pure, unit-tested with vitest)
  core/toast.service.ts          toast queue signal fed by AlertEvent + reducer errors
  shared/toast-host.component.ts fixed top-right toasts (in App root)
  shared/connection-badge.component.ts  "Connecté / Reconnexion… / Hors ligne" + short identity
  features/landing/landing.page.ts
  features/supervision/supervision.page.ts
  features/supervision/transit-map.component.ts
  features/supervision/vehicle-list.component.ts
  features/supervision/incident-board.component.ts
  features/supervision/message-panel.component.ts
  features/supervision/audit-log.component.ts
  features/supervision/online-users.component.ts
  features/supervision/demo-controls.component.ts
  features/chauffeur/chauffeur.page.ts
  features/arret/stop-board.page.ts
  module_bindings/               generated, never edited
```

Routes (`app.routes.ts`, all lazy):
```ts
{ path: '', loadComponent: () => import('./features/landing/landing.page').then(m => m.LandingPage) },
{ path: 'supervision', loadComponent: ... SupervisionPage, title: 'PCC – TransVille Live' },
{ path: 'chauffeur', loadComponent: ... ChauffeurPage, title: 'Chauffeur – TransVille Live' },
{ path: 'arret/:stopId', loadComponent: ... StopBoardPage, title: 'Arrêt – TransVille Live' },
{ path: '**', redirectTo: '' }
```
Use `withComponentInputBinding()` so `stopId` arrives as an `input()`.
Leaflet CSS: add `node_modules/leaflet/dist/leaflet.css` to `angular.json` `styles`. Use `L.circleMarker` / `L.divIcon` only (avoids default marker image path issues).

### 7.2 SpacetimeService (`providedIn: 'root'`)

The SDK ships `spacetimedb/angular` (`provideSpacetimeDB`, `injectTable`) but we write our own service to control the token storage, coalesce updates and surface reducer errors; this keeps the demo code explicit.

```ts
type ConnStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error';

@Injectable({ providedIn: 'root' })
export class SpacetimeService {
  readonly status = signal<ConnStatus>('connecting');
  readonly identity = signal<Identity | undefined>(undefined);
  readonly conn: DbConnection;

  // one readonly-array signal per table/view (see bindTable)
  readonly lines, stops, lineStops, vehicles, positions, assignments, users, presence,
           incidents, simConfig, stopEtas, myMessages, supervisorMessages, auditTrail;

  readonly me = computed(() => users().find(u => u.identity.isEqual(identity())));   // AppUser | undefined
  readonly myAssignment = computed(...);
  readonly onlineIdentities = computed(() => new Set(presence().map(p => p.identity.toHexString())));
}
```

Rules:
- **Token in `sessionStorage`**, key `transville:${SPACETIMEDB_URI}:${DB_NAME}:token` (per database, per tab → each tab gets its own identity). Read/write in try/catch. `withToken(saved ?? undefined)`; `onConnect((conn, identity, token) => { sessionStorage.setItem(key, token); identity.set(identity); status.set('connected'); })`.
- Builder: `DbConnection.builder().withUri(SPACETIMEDB_URI).withDatabaseName(DB_NAME).withToken(...).withAutomaticReconnect().onConnect(...).onAutomaticReconnect((_c, identity, token) => { save token; status.set('connected'); }).onDisconnect((_c, err, nextAttempt) => status.set(nextAttempt !== undefined ? 'reconnecting' : 'disconnected')).onConnectError((_c, err, nextAttempt) => ...).build()` — built once in the constructor. (Signatures verified in `node_modules/spacetimedb/dist/sdk/db_connection_builder.d.ts`: `onConnect` fires **only for the first connection**; reconnects fire `onAutomaticReconnect`, so without it the badge stays on "Reconnexion…" forever. Initial connection failures are not retried.)
- If the saved token is rejected (`onConnectError` with `nextAttempt === undefined` while a saved token was used), clear the key and reload **once** — guard with a `sessionStorage` flag `transville:...:retried` so a down server does not cause a reload loop; otherwise show "Serveur injoignable" + a "Réessayer" button. `IdentityChangedError` → same as token rejection.
- `newIdentity()`: clears the key and `location.reload()` — button "Nouvelle identité" on every screen.
- **Base subscription** (once, at construction, before connect completes — the SDK replays it): `[tables.line, tables.stop, tables.lineStop, tables.vehicle, tables.appUser, tables.simConfig]`. Ready flag `baseReady` set in `onApplied`.
- **Screen subscriptions**: `subscribe(queries): { ready: Signal<boolean>, dispose(): void }` wraps `conn.subscriptionBuilder().onApplied(...).onError(...).subscribe(queries)`; pages call it in their constructor and dispose via `DestroyRef.onDestroy` (`handle.unsubscribe()` guarded by `isActive()`). Do not overlap with base queries.
  - Supervision: `tables.vehiclePosition, tables.driverAssignment, tables.incident, tables.onlinePresence, tables.supervisorMessages, tables.auditTrail, tables.alertEvent`
  - Chauffeur: `tables.vehiclePosition, tables.driverAssignment, tables.incident, tables.myMessages, tables.alertEvent`
  - Arrêt: `tables.stopEta.where(r => r.stopId.eq(id)), tables.incident` (re-subscribe when `stopId` changes: subscribe new first, then dispose old)
- **bindTable(handle, sig)**: register `onInsert/onUpdate/onDelete` once; each callback schedules (via `queueMicrotask`, coalesced with a dirty flag) `sig.set([...handle.iter()])`. Also refresh on every `onApplied`. This turns one transaction of N row changes into one signal emission.
- **AlertEvent**: `conn.db.alertEvent.onInsert((_ctx, ev) => toast.push(ev))` — never read `iter()`/`count()` on it.
- **MyMessages**: `onInsert` → toast "Nouveau message du PCC" + short vibration (`navigator.vibrate?.(200)`) **only** for rows that are `!acknowledged` and whose `id` is not in a `seenMessageIds: Set<bigint>`; the set is filled with all current rows in the subscription's `onApplied` (initial load and every reconnect replay re-insert existing rows — they must not toast).
- **call(name, promise)**: `call(() => conn.reducers.claimVehicle({ vehicleId }))` awaits the promise; on rejection pushes an error toast with the server's French message (strip any "Reducer ... failed:" prefix). Handles `UnknownCallResultError` with "Résultat inconnu (connexion perdue)" and `DisconnectedError` with "Non connecté au serveur" (both exported from `spacetimedb`). Never auto-retries. Action buttons are disabled while `status() !== 'connected'`.
- The app is zoneless (Angular 22 default): SDK callbacks run outside Angular, so state must only flow through signals (no plain fields read by templates).
- Dependency direction: `SpacetimeService` → `ToastService` (never the reverse). The root `App` and `ToastHostComponent` only inject `ToastService`, so `app.spec.ts` (vitest) does not open a WebSocket; pages that inject `SpacetimeService` are lazy-loaded.
- bigint: Incident/message ids are `bigint` — keep them as bigint in code, `String(id)` in templates.
- Timestamps: `ts.toDate()` for display (`Intl.DateTimeFormat('fr-CH', { timeStyle: 'medium' })`), sort by `microsSinceUnixEpoch`.

### 7.3 Screens (French UI)

**Landing `/`** — title "TransVille Live", subtitle "Centre d'exploitation temps réel — démo SpacetimeDB". Three cards: "Supervision PCC", "Chauffeur", "Borne d'arrêt" with short explanations and links opening in a **new tab with `target="_blank" rel="noopener"`** (noopener prevents sessionStorage copy → new identity). Stop picker `<select>` of stops (sorted by name) + "Ouvrir la borne". Section "Ce que montre la démo" listing §8 in plain French. Shows the demo supervisor code "PCC2026". Tip: "Ouvrez chaque écran dans un onglet séparé (pas « Dupliquer l'onglet »)."

**Supervision `/supervision`** (desktop grid)
- Gate: if `me()?.role.tag !== 'Supervisor'` → card "Connexion superviseur": Nom, Code d'accès → `registerUser({ name, role: {tag:'Supervisor'}, accessCode })`.
- Left 2/3: map (Fribourg center `[46.803, 7.152]`, zoom 14, OSM tiles `https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png`, attribution "© OpenStreetMap"). Polylines per line in line colour (from LineStop order), stop circleMarkers with tooltip name (click → open borne in new tab), vehicle divIcons (line colour badge with number; red ring if Immobilized), incident markers (⚠ icon coloured by severity, only unresolved). Map created in `afterNextRender`, markers diffed by id inside an `effect()`; `map.remove()` on destroy. Optional: animate markers between ticks (CSS transition on divIcon is not possible — skip, 1 s steps are fine).
- Right column tabs/stack:
  - "Véhicules": label, ligne badge, statut, retard, prochain arrêt, chauffeur (name + pastille en ligne/hors ligne or "Sans chauffeur"), button "Message".
  - "Incidents": columns *Ouverts / Pris en charge / Résolus* (Kanban, sorted by ReportedAt desc), card shows kind, severity chip, Bus/Ligne, reporter, age ("il y a 2 min"), escalation badge "Escaladé ×N". Buttons "Prendre en charge" (Open) and "Résoudre" (InProgress, prompts note).
  - "Messages": composer (vehicle select with driver, textarea 280) + list from `supervisorMessages` with "Lu ✓ 10:42" / "Non lu".
  - "Journal d'audit": `auditTrail` sorted by At desc: time, actor, details.
  - "En ligne": presence grouped: Superviseurs, Chauffeurs, Bornes / visiteurs (anonymous identity count).
  - "Démo": "Injecter un incident aléatoire", speed buttons ×1 ×2 ×5 ×10 (active one highlighted from SimConfig), "Pause/Reprendre", "Réinitialiser la démo" (confirm dialog), tick counter.

**Chauffeur `/chauffeur`** (max-width 420px, centered, phone-like frame)
- Role-conflict guard: if `me()?.role.tag === 'Supervisor'` (same tab used for /supervision earlier), do **not** silently re-register: show "Cet onglet est connecté comme superviseur. Ouvrez le poste chauffeur avec une nouvelle identité." + button "Nouvelle identité". (Symmetrically, the supervision gate warns that an identity holding a bus will lose it.)
- Step 1: "Votre nom" → `registerUser({ role: Driver, accessCode: '' })`.
- Step 2: vehicle list with line colour; taken ones show "Pris par X" disabled; "Prendre ce véhicule" → `claimVehicle`. Errors (race) shown as toast.
- Step 3 (assigned): big header "Bus 101 · Ligne 1 → Direction Saint-Léonard", "Prochain arrêt : Gare", delay chip, status; button "Libérer le véhicule".
  - "Signaler un incident": 5 large buttons (Panne, Accident, Agression, Voyageur malaise, Retard) + optional description → `reportIncident`. Below: own incidents with status live (driver sees "Pris en charge par Marie").
  - "Messages du PCC": `myMessages` sorted desc; unread highlighted, button "Bien reçu" → `acknowledgeMessage`.

**Borne `/arret/:stopId`** (dark, full screen, large font, no login; `stopId` arrives as a string → `Number()`, invalid/unknown id → "Arrêt inconnu" + link to `/`)
- Header: stop name, clock (client `Date`, updated every second via `setInterval` in the component — client-side only), "TransVille".
- Rows from `stopEtas` sorted by EtaSeconds: line badge (colour, code), "Direction {Destination}", ETA ("À quai" / "Proche" / "N min" / "Perturbé" blinking amber), small "+N min de retard" when DelaySeconds > 120. Max 8 rows. Empty state "Aucun départ dans les 30 prochaines minutes".
- Perturbation banner (amber/red) if any unresolved Incident whose LineId is among lines serving this stop (derived from LineStop): "Perturbation ligne 2 : Panne – Bus 201. Retards possibles."
- Footer: connection badge (small), identity hidden.

---

## 8. SpacetimeDB features → where → business argument

| Feature | Where | Argument for the client |
|---|---|---|
| Public tables + subscriptions | VehiclePosition, Incident, StopEta → map, boards | No API layer, no websocket server, no polling: data is pushed to every screen in ~ms |
| Typed query-builder subscriptions with filter | `stopEta.where(stopId = X)` | Each device receives only its slice (bandwidth for 300 bornes) |
| Private tables | DemoSetting, AuditLog, DriverMessage, VehicleSimState | Secrets and internals never leave the server |
| Per-user Views | MyMessages, AuditTrail, SupervisorMessages | Privacy by construction (drivers see only their messages; audit only for PCC) — GDPR / police-grade compartmentalisation |
| Server-side authz via `ctx.Sender` + roles in AppUser | every reducer (`RequireRole`) | Identity cannot be forged by the client |
| Atomic transactions + constraints | ClaimVehicle (PK + Unique), TakeIncident (status check) | No double dispatch, no race conditions, no locks to write |
| Audit in same transaction | `Audit()` in every business reducer | Audit trail is complete and consistent by design (insurers, police) |
| Scheduled table (repeating) | SimTick → SimulationTick 1 s | Server-side jobs without cron/worker infrastructure |
| Scheduled table (one-shot, chained) | IncidentEscalation | SLA / escalation rules inside the DB |
| Deterministic `ctx.Rng`, `ctx.Timestamp` | tick jitter, dwell, random incidents | Replayable, testable business logic |
| Lifecycle hooks | ClientConnected / ClientDisconnected → OnlinePresence | Live presence ("chauffeur hors ligne") for free |
| Event table | AlertEvent → toasts | Fire-and-forget notifications without storing them |
| Init reducer | network seed | Database is ready on first publish |
| Access-pattern table split | Vehicle vs VehiclePosition vs VehicleSimState | Hot data is small; metadata isn't re-sent every second |
| Hot-swap publish | republish during demo | Deploy new logic without disconnecting clients |
| Anonymous identities | stop boards | Public displays without accounts |

---

## 9. Known limitations / risks

1. **Views cannot `Iter()`** read-only tables — always start from an index `Find`/`Filter` (timestamp range used for AuditTrail/SupervisorMessages). View result order is not guaranteed → sort on the client.
2. **View cost / retention**: views are re-evaluated per subscribed identity when their tables change; AuditTrail returns 100 rows, the tick never audits, and AuditLog (500), DriverMessage (200) and resolved Incidents (30) are trimmed inside the business transactions so the demo can run for hours.
3. **Event tables are not cached**: `alertEvent.iter()` is always empty; only `onInsert`. Toasts missed while disconnected are lost (by design).
4. **`ctx.ConnectionId` is nullable** in lifecycle reducers — unwrap before using as PK.
5. **Stale presence**: if the server restarts or the module is republished with `--delete-data`, `ClientDisconnected` may not run for old connections; presence rows could linger. ResetDemo does not clear presence; a `--delete-data` publish clears everything (clients then reconnect and re-register — their AppUser rows are gone, the UI shows the registration gate again).
6. **Scheduled reducers are callable by clients** (by name; they are absent from generated bindings) — guarded with `ctx.Sender == ctx.DatabaseIdentity`.
7. **Init runs only on first publish** (or `--delete-data`). Schema changes that break migration need `--delete-data=always`. ResetDemo re-creates the SimTick row if missing.
8. **sessionStorage**: "Duplicate tab" copies sessionStorage → same identity. Use links / new tabs (landing uses `rel="noopener"`) or the "Nouvelle identité" button. Closing the tab loses the identity (intended for the demo).
9. **Supervisor code** is a shared demo secret passed as a reducer argument and stored in a private table — not production auth (production would use OIDC claims via `ctx.SenderAuth`).
10. **Simulated time vs. real time**: ETAs/delays are in simulated seconds; escalation delay (30 s) is real time. At ×10 the board counts down 10× faster — expected.
11. **Geometry**: straight lines between stops, not road-snapped; coordinates are approximate.
12. **Nullable `Identity?` / `Timestamp?` columns**: verified (TS `T | undefined`). Reducer names starting with `On` are rejected at compile time (`STDB0010`).
13. **Enum shapes in TS bindings** (`{ tag }`) and accessor names (`tables.myMessages`, `conn.reducers.registerUser`) must be checked in the generated `module_bindings` after each `spacetime generate`.
14. **Reducer errors**: thrown `Exception` messages reach the client as promise rejections — keep them French and user-presentable; never include private data (e.g. AcknowledgeMessage says "introuvable" rather than "not yours").
15. Tick load: 5 vehicles × (1 position + ~10–20 ETA diffs) per second — trivial; do not raise the tick rate below 1 s. `SimConfig` (base subscription) changes every tick because of `TickCount`/`LastTickAt` → one tiny row update/s per client; acceptable, but nothing expensive may be `computed()` from `simConfig` alone.
16. **Same tab = same identity = one role.** Navigating inside one tab from /supervision to /chauffeur keeps the identity; registering as driver would demote the supervisor. Hence the role-conflict guard (§7.3) and the "one screen per tab" instruction on the landing page.
17. **Public incident descriptions**: `Incident.Description` is replicated to every client (including stop boards). The UI hint under the field says "Pas de données personnelles". Production would move it to a private table exposed through a supervisor-only view, like AuditLog.

---

## 10. Implementation notes (as built, verified by CLI smoke test)

Files: `spacetimedb/Lib.cs` (types + tables), `Reducers.cs`, `Simulation.cs`, `Seed.cs`, `Views.cs`.

Generated TS accessors (`module_bindings/index.ts`):
- Tables: `line, stop, lineStop, vehicle, vehiclePosition, driverAssignment, appUser, onlinePresence, incident, alertEvent (event: true), simConfig, stopEta`. Private tables (`vehicleSimState, demoSetting, incidentEscalation, driverMessage, auditLog, simTick`) are not in the bindings.
- Views: `myMessages, supervisorMessages, auditTrail` (rows typed `DriverMessage` / `AuditLog`).
- Reducers (`conn.reducers.*`, object args with camelCase keys; check the exact call shape of no-arg reducers in `node_modules/spacetimedb/dist/sdk/reducers.d.ts`): `registerUser({name, role, accessCode})`, `claimVehicle({vehicleId})`, `releaseVehicle({})`, `reportIncident({kind, description})`, `injectRandomIncident({})`, `takeIncident({incidentId})`, `resolveIncident({incidentId, note})`, `sendDriverMessage({vehicleId, body})`, `acknowledgeMessage({messageId})`, `setSimSpeed({factor})`, `setSimPaused({paused})`, `resetDemo({})`. Scheduled/lifecycle reducers (`simulationTick`, `escalateIncident`, `init`, `clientConnected`, `clientDisconnected`) are not exposed.

Behavioural details settled during implementation:
- **Layover direction**: a layover flips `Forward` only when the vehicle stands at the end terminus of its current direction (so the seeded Bus 101 at seq 0 forward with a 10 s layover simply departs forward). `VehiclePosition.Forward` is the **effective departure direction** (already flipped during a terminus layover), so the driver header "Direction …" is correct while laying over. `NextStopId` = current stop while dwelling or laying over.
- **Trip clock**: layover time is not counted in `TripElapsedS`; at layover end `TripElapsedS` restarts at 0 (plus any leftover tick budget). Seeded vehicles start with `TripElapsedS = PlannedElapsedS` (on time). Planned dwell of the stop being served is counted progressively (`PlannedDwellS - DwellRemainingS`), so the delay does not jump at each arrival. Expect a small positive drift (~+15 s per trip) because the speed jitter averages 0.95.
- **Immobilised vehicles**: their StopEta rows keep the frozen ETA computed from the stopped position with `Disrupted = true` (the board shows "Perturbé", not the minutes).
- **StopEta diff** also updates when `Destination` changes.
- `ClaimVehicle` on a bus the caller already holds is an idempotent no-op. `TakeIncident` on a resolved incident throws "Incident déjà résolu.". `RegisterUser` that demotes a driver releases the bus and audits `VEHICLE_RELEASED` before `USER_REGISTERED`.
- Scheduled reducers called from the CLI are rejected with "Réservé au planificateur." (verified).
- `spacetime sql` / `spacetime call` open a short connection → transient `OnlinePresence` rows for the CLI identity are normal.

