import { Injectable, Signal, WritableSignal, computed, inject, signal } from '@angular/core';
import {
  DisconnectedError,
  Identity,
  IdentityChangedError,
  UnknownCallResultError,
  type RowTypedQuery,
} from 'spacetimedb';
import { DbConnection, tables, type SubscriptionHandle } from '../../module_bindings';
import type {
  AlertEvent,
  AppUser,
  AuditLog,
  DriverAssignment,
  DriverMessage,
  Incident,
  Line,
  LineStop,
  OnlinePresence,
  SimConfig,
  Stop,
  StopEta,
  Vehicle,
  VehiclePosition,
} from '../../module_bindings/types';
import { DB_NAME, RETRIED_KEY, SPACETIMEDB_URI, TOKEN_KEY } from './config';
import { type IncidentKindTag, type RoleTag, incidentKind, role } from './labels';
import { ToastService } from './toast.service';

export type ConnStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error';

/** A query accepted by `subscribe()`: a typed table/query-builder expression, e.g. `tables.incident`. */
export type Query = RowTypedQuery<any, any>;

/** Handle returned by `subscribe()`. Call `dispose()` in `DestroyRef.onDestroy`. */
export interface ScreenSubscription {
  /** true once the initial rows have been applied (and again after each reconnect replay). */
  readonly ready: Signal<boolean>;
  dispose(): void;
}

/** Recent AlertEvent kept for UI (the event table itself is never cached by the SDK). */
export interface RecentAlert extends AlertEvent {
  /** client-side sequence number (stable key for @for track). */
  seq: number;
}

const MAX_RECENT_ALERTS = 20;

function safeGet(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}
function safeRemove(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** Turns "Reducer foo failed: Accès refusé…" / "Error: …" into the bare French server message. */
/**
 * True when a connect error means the server refused the saved token (HTTP 400/401/403 on
 * /v1/identity/websocket-token, surfaced by the SDK as `WebSocketTokenError`, which it does not
 * export). Network / refused-socket errors return false.
 */
export function isTokenRejected(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as { status?: unknown }).status;
  if (error.name === 'WebSocketTokenError' && typeof status === 'number') {
    return status === 400 || status === 401 || status === 403;
  }
  return /Failed to verify token: (400|401|403)\b/.test(error.message);
}

export function cleanServerMessage(raw: unknown): string {
  let msg = raw instanceof Error ? raw.message : String(raw ?? '');
  msg = msg
    .replace(/^.*?(reducer|procedure)[^:]*?(failed|error)[^:]*:\s*/i, '')
    .replace(/^(Error|SenderError|InternalError|Exception|System\.Exception):\s*/i, '')
    .trim();
  return msg || 'Erreur inconnue.';
}

/**
 * Single owner of the SpacetimeDB connection for the whole app (one per browser tab).
 *
 * - Token in sessionStorage (per tab, per database) → every tab gets its own identity.
 * - Every table/view the screens need is mirrored into a readonly-array signal (rebuilt from the
 *   SDK client cache with `iter()`, coalesced once per microtask = once per transaction).
 * - The app is zoneless: SDK callbacks only write signals, so change detection just works.
 */
@Injectable({ providedIn: 'root' })
export class SpacetimeService {
  private readonly toast = inject(ToastService);

  // ---------------------------------------------------------------- connection state
  readonly status = signal<ConnStatus>('connecting');
  readonly identity = signal<Identity | undefined>(undefined);
  readonly identityHex = computed(() => this.identity()?.toHexString());
  /** Last connection error message (French), for "Serveur injoignable" screens. */
  readonly lastError = signal<string | undefined>(undefined);
  readonly isConnected = computed(() => this.status() === 'connected');
  /** true once the base subscription (reference network + users + simConfig) is applied. */
  readonly baseReady = signal(false);

  readonly conn: DbConnection;

  // ---------------------------------------------------------------- table mirrors
  /** Base subscription (always present). */
  readonly lines = signal<readonly Line[]>([]);
  readonly stops = signal<readonly Stop[]>([]);
  readonly lineStops = signal<readonly LineStop[]>([]);
  readonly vehicles = signal<readonly Vehicle[]>([]);
  readonly users = signal<readonly AppUser[]>([]);
  readonly simConfigs = signal<readonly SimConfig[]>([]);
  /** Screen subscriptions (empty until a screen subscribes). */
  readonly positions = signal<readonly VehiclePosition[]>([]);
  readonly assignments = signal<readonly DriverAssignment[]>([]);
  readonly presence = signal<readonly OnlinePresence[]>([]);
  readonly incidents = signal<readonly Incident[]>([]);
  readonly stopEtas = signal<readonly StopEta[]>([]);
  /** Views (rows already filtered server-side for the caller). */
  readonly myMessages = signal<readonly DriverMessage[]>([]);
  readonly supervisorMessages = signal<readonly DriverMessage[]>([]);
  readonly auditTrail = signal<readonly AuditLog[]>([]);
  /** Event table: the last alerts received (newest first). */
  readonly recentAlerts = signal<readonly RecentAlert[]>([]);

  // ---------------------------------------------------------------- derived lookups
  readonly simConfig = computed<SimConfig | undefined>(() => this.simConfigs()[0]);
  readonly lineById = computed(() => new Map(this.lines().map((r) => [r.id, r])));
  readonly stopById = computed(() => new Map(this.stops().map((r) => [r.id, r])));
  readonly vehicleById = computed(() => new Map(this.vehicles().map((r) => [r.id, r])));
  readonly positionByVehicleId = computed(() => new Map(this.positions().map((r) => [r.vehicleId, r])));
  readonly assignmentByVehicleId = computed(() => new Map(this.assignments().map((r) => [r.vehicleId, r])));
  /** key = identity hex */
  readonly userByIdentity = computed(() => new Map(this.users().map((r) => [r.identity.toHexString(), r])));
  /** key = incident id (bigint) */
  readonly incidentById = computed(() => new Map(this.incidents().map((r) => [r.id, r])));
  /** Ordered stops per line (by Seq). key = lineId */
  readonly routeByLineId = computed(() => {
    const stopById = this.stopById();
    const map = new Map<number, { lineStop: LineStop; stop: Stop }[]>();
    for (const ls of [...this.lineStops()].sort((a, b) => a.seq - b.seq)) {
      const stop = stopById.get(ls.stopId);
      if (!stop) continue;
      if (!map.has(ls.lineId)) map.set(ls.lineId, []);
      map.get(ls.lineId)!.push({ lineStop: ls, stop });
    }
    return map;
  });
  /** Line ids serving each stop. key = stopId */
  readonly lineIdsByStopId = computed(() => {
    const map = new Map<number, Set<number>>();
    for (const ls of this.lineStops()) {
      if (!map.has(ls.stopId)) map.set(ls.stopId, new Set());
      map.get(ls.stopId)!.add(ls.lineId);
    }
    return map;
  });
  /** Identity hexes with at least one OnlinePresence row. */
  readonly onlineIdentities = computed(() => new Set(this.presence().map((p) => p.identity.toHexString())));
  /** Unresolved incidents (Open or InProgress). */
  readonly activeIncidents = computed(() => this.incidents().filter((i) => i.status.tag !== 'Resolved'));

  /** My AppUser row (undefined = not registered = anonymous passenger). */
  readonly me = computed<AppUser | undefined>(() => {
    const hex = this.identityHex();
    return hex ? this.userByIdentity().get(hex) : undefined;
  });
  readonly myRole = computed<RoleTag | undefined>(() => this.me()?.role.tag);
  readonly isSupervisor = computed(() => this.myRole() === 'Supervisor');
  readonly isDriver = computed(() => this.myRole() === 'Driver');
  /** My vehicle assignment (needs `tables.driverAssignment` subscribed). */
  readonly myAssignment = computed<DriverAssignment | undefined>(() => {
    const id = this.identity();
    return id ? this.assignments().find((a) => a.driverIdentity.isEqual(id)) : undefined;
  });
  readonly unreadMessageCount = computed(() => this.myMessages().filter((m) => !m.acknowledged).length);

  // ---------------------------------------------------------------- internals
  private readonly usedSavedToken: boolean;
  private readonly seenMessageIds = new Set<bigint>();
  private myMessagesBaselined = false;
  private alertSeq = 0;

  constructor() {
    const saved = safeGet(TOKEN_KEY) ?? undefined;
    this.usedSavedToken = !!saved;

    this.conn = DbConnection.builder()
      .withUri(SPACETIMEDB_URI)
      .withDatabaseName(DB_NAME)
      .withToken(saved)
      .withAutomaticReconnect()
      .onConnect((_conn, identity, token) => {
        safeSet(TOKEN_KEY, token);
        safeRemove(RETRIED_KEY);
        this.identity.set(identity);
        this.lastError.set(undefined);
        this.status.set('connected');
      })
      .onAutomaticReconnect((_conn, identity, token) => {
        safeSet(TOKEN_KEY, token);
        this.identity.set(identity);
        this.lastError.set(undefined);
        this.status.set('connected');
      })
      .onDisconnect((_ctx, error, nextAttempt) => {
        this.status.set(nextAttempt !== undefined ? 'reconnecting' : 'disconnected');
        if (error) this.lastError.set(cleanServerMessage(error));
        if (error instanceof IdentityChangedError) this.handleRejectedToken();
      })
      .onConnectError((_ctx, error, nextAttempt) => {
        this.lastError.set(cleanServerMessage(error));
        if (nextAttempt !== undefined) {
          this.status.set('reconnecting');
          return;
        }
        this.status.set('error');
        // Only drop the saved token when the server really rejected it. A merely unreachable server
        // (down, restarting, network blip) must keep the identity: "Réessayer" reloads with it.
        if (error instanceof IdentityChangedError || (this.usedSavedToken && isTokenRejected(error))) {
          this.handleRejectedToken();
        }
      })
      .build();

    this.bindAll();

    // Base subscription: small, rarely-changing data every screen needs. Registered once; the SDK
    // replays it after a reconnect.
    this.conn
      .subscriptionBuilder()
      .onApplied(() => {
        this.baseReady.set(true);
        this.refreshAll();
      })
      .onError((_ctx) => this.toast.error('Abonnement refusé', 'Données de base indisponibles.'))
      .subscribe([tables.line, tables.stop, tables.lineStop, tables.vehicle, tables.appUser, tables.simConfig]);
  }

  // ================================================================ subscriptions

  /**
   * Subscribe to extra queries for the lifetime of a screen. Call in the component constructor and
   * dispose in `DestroyRef.onDestroy`. Never re-subscribe base tables (line, stop, lineStop,
   * vehicle, appUser, simConfig).
   */
  subscribe(queries: Query[], label = 'écran'): ScreenSubscription {
    const ready = signal(false);
    let handle: SubscriptionHandle | undefined;
    let disposed = false;
    handle = this.conn
      .subscriptionBuilder()
      .onApplied(() => {
        if (disposed) {
          // Disposed before the server applied it: unsubscribe now, or it would leak for good.
          try {
            handle?.unsubscribe();
          } catch {
            /* already ended / connection gone */
          }
          return;
        }
        // Messages present at (re)subscription time are history: never toast them.
        for (const m of this.conn.db.myMessages.iter()) this.seenMessageIds.add(m.id);
        this.myMessagesBaselined = true;
        ready.set(true);
        this.refreshAll();
      })
      .onError((ctx) => {
        ready.set(false);
        const err = (ctx as { event?: unknown }).event;
        this.toast.error(`Abonnement ${label} refusé`, err ? cleanServerMessage(err) : undefined);
      })
      .subscribe(queries);
    return {
      ready: ready.asReadonly(),
      dispose: () => {
        if (disposed) return;
        disposed = true;
        ready.set(false);
        // Not active yet (pending, or being replayed after a reconnect): onApplied unsubscribes.
        try {
          if (handle?.isActive()) handle.unsubscribe();
        } catch {
          /* already ended / connection gone */
        }
      },
    };
  }

  /** Supervision screen queries (SPEC §7.2). */
  subscribeSupervision(): ScreenSubscription {
    return this.subscribe(
      [
        tables.vehiclePosition,
        tables.driverAssignment,
        tables.incident,
        tables.onlinePresence,
        tables.supervisorMessages,
        tables.auditTrail,
        tables.alertEvent,
      ],
      'supervision',
    );
  }

  /** Driver screen queries. `myMessages` is a per-identity view: only the caller's messages. */
  subscribeDriver(): ScreenSubscription {
    return this.subscribe(
      [tables.vehiclePosition, tables.driverAssignment, tables.incident, tables.myMessages, tables.alertEvent],
      'chauffeur',
    );
  }

  /**
   * Stop board queries: only the ETAs of one stop (server-side filter) + incidents for the banner.
   * When stopId changes: subscribe the new one first, then dispose the old one.
   */
  subscribeStopBoard(stopId: number): ScreenSubscription {
    return this.subscribe([tables.stopEta.where((r) => r.stopId.eq(stopId)), tables.incident], 'borne');
  }

  // ================================================================ identity

  /** Drop this tab's token and reload → brand-new anonymous identity. */
  newIdentity(): void {
    safeRemove(TOKEN_KEY);
    safeRemove(RETRIED_KEY);
    location.reload();
  }

  /** Retry after "Serveur injoignable" (initial connection failures are not retried by the SDK). */
  retryConnection(): void {
    location.reload();
  }

  private handleRejectedToken(): void {
    // Saved token rejected (e.g. server data wiped) → clear and reload ONCE (guarded against loops).
    if (safeGet(RETRIED_KEY)) return;
    safeSet(RETRIED_KEY, '1');
    safeRemove(TOKEN_KEY);
    location.reload();
  }

  // ================================================================ reducers
  // Each wrapper resolves to true on success, false on failure (an error toast is already shown with
  // the server's French message). Never auto-retried.

  registerUser(name: string, roleTag: RoleTag, accessCode = ''): Promise<boolean> {
    return this.call(() => this.conn.reducers.registerUser({ name, role: role(roleTag), accessCode }));
  }
  claimVehicle(vehicleId: number): Promise<boolean> {
    return this.call(() => this.conn.reducers.claimVehicle({ vehicleId }));
  }
  releaseVehicle(): Promise<boolean> {
    return this.call(() => this.conn.reducers.releaseVehicle({}));
  }
  reportIncident(kind: IncidentKindTag, description = ''): Promise<boolean> {
    return this.call(() => this.conn.reducers.reportIncident({ kind: incidentKind(kind), description }));
  }
  injectRandomIncident(): Promise<boolean> {
    return this.call(() => this.conn.reducers.injectRandomIncident({}));
  }
  takeIncident(incidentId: bigint): Promise<boolean> {
    return this.call(() => this.conn.reducers.takeIncident({ incidentId }));
  }
  resolveIncident(incidentId: bigint, note = ''): Promise<boolean> {
    return this.call(() => this.conn.reducers.resolveIncident({ incidentId, note }));
  }
  sendDriverMessage(vehicleId: number, body: string): Promise<boolean> {
    return this.call(() => this.conn.reducers.sendDriverMessage({ vehicleId, body }));
  }
  acknowledgeMessage(messageId: bigint): Promise<boolean> {
    return this.call(() => this.conn.reducers.acknowledgeMessage({ messageId }));
  }
  setSimSpeed(factor: 1 | 2 | 5 | 10): Promise<boolean> {
    return this.call(() => this.conn.reducers.setSimSpeed({ factor }));
  }
  setSimPaused(paused: boolean): Promise<boolean> {
    return this.call(() => this.conn.reducers.setSimPaused({ paused }));
  }
  forceReleaseVehicle(vehicleId: number): Promise<boolean> {
    return this.call(() => this.conn.reducers.forceReleaseVehicle({ vehicleId }));
  }
  resetDemo(): Promise<boolean> {
    return this.call(() => this.conn.reducers.resetDemo({}));
  }

  /** Generic reducer call wrapper (exposed for custom calls). */
  async call(fn: () => Promise<unknown>): Promise<boolean> {
    if (this.status() !== 'connected') {
      this.toast.error('Non connecté au serveur');
      return false;
    }
    try {
      await fn();
      return true;
    } catch (e) {
      if (e instanceof UnknownCallResultError) {
        this.toast.error('Résultat inconnu (connexion perdue)', "L'action a peut-être été appliquée.");
      } else if (e instanceof DisconnectedError) {
        this.toast.error('Non connecté au serveur');
      } else {
        this.toast.error('Action refusée', cleanServerMessage(e));
      }
      return false;
    }
  }

  // ================================================================ table binding

  private readonly refreshers: (() => void)[] = [];
  private readonly dirty = new Set<() => void>();
  private flushScheduled = false;

  private bindAll(): void {
    const db = this.conn.db;
    this.bindTable(db.line, this.lines);
    this.bindTable(db.stop, this.stops);
    this.bindTable(db.lineStop, this.lineStops);
    this.bindTable(db.vehicle, this.vehicles);
    this.bindTable(db.appUser, this.users);
    this.bindTable(db.simConfig, this.simConfigs);
    this.bindTable(db.vehiclePosition, this.positions);
    this.bindTable(db.driverAssignment, this.assignments);
    this.bindTable(db.onlinePresence, this.presence);
    this.bindTable(db.incident, this.incidents);
    this.bindTable(db.stopEta, this.stopEtas);
    this.bindTable(db.myMessages, this.myMessages);
    this.bindTable(db.supervisorMessages, this.supervisorMessages);
    this.bindTable(db.auditTrail, this.auditTrail);

    // Event table: rows are never cached → only onInsert. Toast + keep a short history.
    db.alertEvent.onInsert((_ctx, ev) => {
      const alert: RecentAlert = { ...ev, seq: ++this.alertSeq };
      this.recentAlerts.update((list) => [alert, ...list].slice(0, MAX_RECENT_ALERTS));
      const kind = (['incident', 'escalation', 'resolved', 'system'] as const).find((k) => k === ev.kind) ?? 'info';
      this.toast.push({ kind, title: ev.title, body: ev.body, severity: ev.severity.tag });
    });

    // New PCC message for this driver → toast + vibration, once per message id.
    db.myMessages.onInsert((ctx, m) => {
      const fromInitialLoad = ctx.event.tag === 'SubscribeApplied' || !this.myMessagesBaselined;
      const alreadySeen = this.seenMessageIds.has(m.id);
      this.seenMessageIds.add(m.id);
      if (fromInitialLoad || alreadySeen || m.acknowledged) return;
      this.toast.push({ kind: 'message', title: 'Nouveau message du PCC', body: m.body }, 10000);
      try {
        navigator.vibrate?.(200);
      } catch {
        /* unsupported */
      }
    });
  }

  /**
   * Mirror a client-cache table into a signal. Any insert/update/delete marks it dirty; one
   * microtask later the signal is rebuilt from `iter()` (one emission per transaction).
   */
  private bindTable<Row>(handle: unknown, sig: WritableSignal<readonly Row[]>): void {
    const h = handle as {
      iter(): Iterable<Row>;
      onInsert(cb: (...a: unknown[]) => void): void;
      onDelete(cb: (...a: unknown[]) => void): void;
      onUpdate?(cb: (...a: unknown[]) => void): void;
    };
    const refresh = () => sig.set([...h.iter()]);
    this.refreshers.push(refresh);
    const mark = () => this.markDirty(refresh);
    h.onInsert(mark);
    h.onDelete(mark);
    h.onUpdate?.(mark);
  }

  private markDirty(refresh: () => void): void {
    this.dirty.add(refresh);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      const list = [...this.dirty];
      this.dirty.clear();
      for (const r of list) r();
    });
  }

  private refreshAll(): void {
    for (const r of this.refreshers) this.markDirty(r);
  }
}
