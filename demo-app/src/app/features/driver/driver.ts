import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import type { DriverMessage, Incident, Line, Vehicle } from '../../../module_bindings/types';
import {
  INCIDENT_KINDS,
  INCIDENT_KIND_LABELS,
  INCIDENT_STATUS_LABELS,
  SEVERITY_CLASSES,
  SEVERITY_LABELS,
  VEHICLE_STATUS_LABELS,
  byTimestampDesc,
  delayClass,
  formatAge,
  formatDelay,
  formatShortTime,
  type IncidentKindTag,
} from '../../core/labels';
import { SpacetimeService } from '../../core/spacetime.service';
import { ToastService } from '../../core/toast.service';

type Tab = 'drive' | 'report' | 'messages';

interface KindButton {
  tag: IncidentKindTag;
  label: string;
  icon: string;
  hint: string;
  classes: string;
}

const KIND_META: Record<IncidentKindTag, { icon: string; hint: string; classes: string }> = {
  Breakdown: { icon: '🔧', hint: 'Véhicule immobilisé', classes: 'bg-orange-50 border-orange-300 text-orange-900' },
  Accident: { icon: '💥', hint: 'Collision, dégâts', classes: 'bg-red-50 border-red-300 text-red-900' },
  Assault: { icon: '🛡️', hint: 'Agression, incivilité', classes: 'bg-rose-50 border-rose-300 text-rose-900' },
  PassengerIllness: { icon: '🩺', hint: 'Malaise à bord', classes: 'bg-sky-50 border-sky-300 text-sky-900' },
  Delay: { icon: '⏱️', hint: 'Trafic, travaux', classes: 'bg-amber-50 border-amber-300 text-amber-900' },
};

const STEPS = ['Identification', 'Véhicule', 'En service'] as const;

/** /chauffeur — simulated driver phone: register → claim a bus → drive, report, receive PCC messages. */
@Component({
  selector: 'app-driver',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: './driver.html',
  styles: `
    @keyframes drv-shake {
      0%, 100% { transform: translateX(0); }
      15%, 55% { transform: translateX(-5px) rotate(-0.6deg); }
      35%, 75% { transform: translateX(5px) rotate(0.6deg); }
    }
    @keyframes drv-glow {
      0%, 100% { box-shadow: 0 0 0 0 rgb(37 99 235 / 0.55); }
      50% { box-shadow: 0 0 0 10px rgb(37 99 235 / 0); }
    }
    .drv-fresh { animation: drv-shake 0.6s ease-in-out 2, drv-glow 1.4s ease-out 3; }
    .drv-badge-pulse { animation: drv-glow 1.4s ease-out infinite; }
  `,
})
export class Driver {
  protected readonly stdb = inject(SpacetimeService);
  private readonly toast = inject(ToastService);
  private readonly sub = this.stdb.subscribeDriver();

  protected readonly steps = STEPS;
  protected readonly kindLabels = INCIDENT_KIND_LABELS;
  protected readonly statusLabels = INCIDENT_STATUS_LABELS;
  protected readonly severityLabels = SEVERITY_LABELS;
  protected readonly severityClasses = SEVERITY_CLASSES;
  protected readonly vehicleStatusLabels = VEHICLE_STATUS_LABELS;
  protected readonly formatDelay = formatDelay;
  protected readonly delayClass = delayClass;
  protected readonly formatShortTime = formatShortTime;
  protected readonly kindButtons: KindButton[] = INCIDENT_KINDS.map((tag) => ({
    tag,
    label: INCIDENT_KIND_LABELS[tag],
    ...KIND_META[tag],
  }));

  /** Ticking clock for "il y a 2 min" and the fake phone status bar. */
  protected readonly now = signal(Date.now());

  // ------------------------------------------------------------- local UI state
  protected readonly nameDraft = signal('');
  protected readonly editingName = signal(false);
  protected readonly tab = signal<Tab>('drive');
  protected readonly selectedKind = signal<IncidentKindTag | null>(null);
  protected readonly description = signal('');
  /** Key of the reducer call in flight (disables the matching button). */
  protected readonly busy = signal<string | null>(null);
  /** Last server refusal, shown inline (also shown as toast by the service). */
  protected readonly inlineError = signal<string | null>(null);
  protected readonly confirmRelease = signal(false);
  /** Message ids that arrived live (not at subscription time) → shake/glow animation. */
  protected readonly freshIds = signal<ReadonlySet<bigint>>(new Set());

  // ------------------------------------------------------------- derived state
  protected readonly ready = computed(() => this.stdb.baseReady() && this.sub.ready());
  protected readonly isSupervisorTab = computed(() => this.stdb.myRole() === 'Supervisor');
  protected readonly needsRegistration = computed(() => !this.stdb.isDriver() || this.editingName());
  protected readonly assignment = this.stdb.myAssignment;

  protected readonly step = computed(() => {
    if (this.needsRegistration()) return 0;
    return this.assignment() ? 2 : 1;
  });

  protected readonly nameValid = computed(() => {
    const n = this.nameDraft().trim();
    return n.length >= 2 && n.length <= 40;
  });

  /** Vehicle picker rows grouped by line. */
  protected readonly vehicleGroups = computed(() => {
    const byLine = new Map<number, Vehicle[]>();
    for (const v of [...this.stdb.vehicles()].sort((a, b) => a.label.localeCompare(b.label, 'fr'))) {
      if (!byLine.has(v.lineId)) byLine.set(v.lineId, []);
      byLine.get(v.lineId)!.push(v);
    }
    const lineById = this.stdb.lineById();
    const assignments = this.stdb.assignmentByVehicleId();
    const positions = this.stdb.positionByVehicleId();
    const stops = this.stdb.stopById();
    return [...byLine.entries()]
      .map(([lineId, vehicles]) => ({
        line: lineById.get(lineId),
        lineId,
        vehicles: vehicles.map((v) => {
          const pos = positions.get(v.id);
          return {
            vehicle: v,
            takenBy: assignments.get(v.id)?.driverName,
            nextStop: pos ? stops.get(pos.nextStopId)?.name : undefined,
          };
        }),
      }))
      .sort((a, b) => (a.line?.code ?? '').localeCompare(b.line?.code ?? '', 'fr', { numeric: true }));
  });
  protected readonly freeCount = computed(
    () => this.stdb.vehicles().filter((v) => !this.stdb.assignmentByVehicleId().has(v.id)).length,
  );

  protected readonly vehicle = computed(() => {
    const a = this.assignment();
    return a ? this.stdb.vehicleById().get(a.vehicleId) : undefined;
  });
  protected readonly line = computed<Line | undefined>(() => {
    const v = this.vehicle();
    return v ? this.stdb.lineById().get(v.lineId) : undefined;
  });
  protected readonly position = computed(() => {
    const a = this.assignment();
    return a ? this.stdb.positionByVehicleId().get(a.vehicleId) : undefined;
  });
  protected readonly route = computed(() => {
    const v = this.vehicle();
    return v ? (this.stdb.routeByLineId().get(v.lineId) ?? []) : [];
  });
  protected readonly destination = computed(() => {
    const r = this.route();
    const p = this.position();
    if (!r.length) return undefined;
    return (p?.forward ?? true ? r[r.length - 1] : r[0]).stop.name;
  });
  protected readonly nextStop = computed(() => {
    const p = this.position();
    return p ? this.stdb.stopById().get(p.nextStopId) : undefined;
  });
  /** Route strip in driving direction, with the next stop highlighted and passed stops dimmed. */
  protected readonly routeStrip = computed(() => {
    const p = this.position();
    const r = p && !p.forward ? [...this.route()].reverse() : this.route();
    const nextIdx = p ? r.findIndex((x) => x.stop.id === p.nextStopId) : -1;
    return r.map((x, i) => ({
      id: x.stop.id,
      name: x.stop.name,
      state: nextIdx < 0 ? 'future' : i < nextIdx ? 'passed' : i === nextIdx ? 'next' : 'future',
    }));
  });

  protected readonly myIncidents = computed(() => {
    const me = this.stdb.identity();
    if (!me) return [];
    return this.stdb
      .incidents()
      .filter((i) => i.reportedBy.isEqual(me))
      .sort(byTimestampDesc((i: Incident) => i.reportedAt))
      .slice(0, 6);
  });
  /** Unresolved incidents on my bus (reported by me, the PCC or the simulation). */
  protected readonly vehicleIncidents = computed(() => {
    const a = this.assignment();
    if (!a) return [];
    return this.stdb.activeIncidents().filter((i) => i.vehicleId === a.vehicleId);
  });

  protected readonly messages = computed(() =>
    [...this.stdb.myMessages()].sort(byTimestampDesc((m: DriverMessage) => m.sentAt)),
  );
  protected readonly unread = this.stdb.unreadMessageCount;
  protected readonly latestUnread = computed(() => this.messages().find((m) => !m.acknowledged));

  protected readonly clock = computed(() =>
    new Intl.DateTimeFormat('fr-CH', { hour: '2-digit', minute: '2-digit' }).format(this.now()),
  );

  constructor() {
    const destroyRef = inject(DestroyRef);
    const timer = setInterval(() => this.now.set(Date.now()), 5000);
    destroyRef.onDestroy(() => {
      clearInterval(timer);
      this.sub.dispose();
    });

    // Prefill the name field with the registered name.
    effect(() => {
      const me = this.stdb.me();
      if (me && !untracked(this.nameDraft)) this.nameDraft.set(me.name);
    });

    // Detect messages that arrive live (after the subscription is applied) → highlight them.
    let known: Set<bigint> | null = null;
    effect(() => {
      const msgs = this.stdb.myMessages();
      if (!this.sub.ready()) {
        known = null;
        return;
      }
      if (known === null) {
        known = new Set(msgs.map((m) => m.id));
        return;
      }
      const fresh = msgs.filter((m) => !known!.has(m.id) && !m.acknowledged).map((m) => m.id);
      for (const m of msgs) known.add(m.id);
      if (!fresh.length) return;
      untracked(() => this.freshIds.update((s) => new Set([...s, ...fresh])));
      setTimeout(() => this.freshIds.update((s) => new Set([...s].filter((id) => !fresh.includes(id)))), 4000);
    });

    // A claimed bus drops back (released by role change / reset): go back to the drive tab.
    effect(() => {
      if (!this.assignment()) {
        untracked(() => {
          this.tab.set('drive');
          this.confirmRelease.set(false);
          this.selectedKind.set(null);
        });
      }
    });
  }

  // ------------------------------------------------------------- template helpers
  protected lineOf(lineId: number): Line | undefined {
    return this.stdb.lineById().get(lineId);
  }
  protected vehicleLabel(vehicleId: number): string {
    return this.stdb.vehicleById().get(vehicleId)?.label ?? `Bus ${vehicleId}`;
  }
  protected age(i: { reportedAt?: Incident['reportedAt']; sentAt?: DriverMessage['sentAt'] }): string {
    const ts = i.reportedAt ?? i.sentAt;
    return ts ? formatAge(ts, this.now()) : '';
  }
  protected statusChip(i: Incident): string {
    switch (i.status.tag) {
      case 'Open':
        return 'bg-red-100 text-red-800';
      case 'InProgress':
        return 'bg-blue-100 text-blue-800';
      default:
        return 'bg-emerald-100 text-emerald-800';
    }
  }
  protected onInput(target: EventTarget | null, sig: { set(v: string): void }): void {
    sig.set((target as HTMLInputElement | HTMLTextAreaElement).value);
  }

  // ------------------------------------------------------------- actions
  /** Runs a reducer wrapper; on refusal keeps the server's French message inline. */
  private async run(key: string, fn: () => Promise<boolean>): Promise<boolean> {
    if (this.busy()) return false;
    this.busy.set(key);
    this.inlineError.set(null);
    try {
      const ok = await fn();
      if (!ok) {
        const last = [...this.toast.toasts()].reverse().find((t) => t.kind === 'error');
        this.inlineError.set(last ? (last.body ?? last.title) : 'Action refusée.');
      }
      return ok;
    } finally {
      this.busy.set(null);
    }
  }

  protected async register(event?: Event): Promise<void> {
    event?.preventDefault();
    if (!this.nameValid()) return;
    const ok = await this.run('register', () => this.stdb.registerUser(this.nameDraft().trim(), 'Driver'));
    if (ok) {
      this.editingName.set(false);
      this.toast.success(`Bienvenue ${this.nameDraft().trim()}`, 'Choisissez votre véhicule.');
    }
  }

  protected async claim(v: Vehicle): Promise<void> {
    const ok = await this.run(`claim-${v.id}`, () => this.stdb.claimVehicle(v.id));
    if (ok) this.toast.success(`${v.label} pris en charge`, 'Bonne route !');
  }

  protected async release(): Promise<void> {
    const label = this.vehicle()?.label ?? 'Véhicule';
    const ok = await this.run('release', () => this.stdb.releaseVehicle());
    this.confirmRelease.set(false);
    if (ok) this.toast.success(`${label} libéré`, 'Fin de service enregistrée.');
  }

  protected selectKind(tag: IncidentKindTag): void {
    this.inlineError.set(null);
    this.selectedKind.set(this.selectedKind() === tag ? null : tag);
  }

  protected async sendReport(): Promise<void> {
    const kind = this.selectedKind();
    if (!kind) return;
    const ok = await this.run('report', () => this.stdb.reportIncident(kind, this.description().trim()));
    if (ok) {
      this.toast.success('Incident transmis au PCC', INCIDENT_KIND_LABELS[kind]);
      this.selectedKind.set(null);
      this.description.set('');
      this.tab.set('drive');
    }
  }

  protected async acknowledge(m: DriverMessage): Promise<void> {
    await this.run(`ack-${m.id}`, () => this.stdb.acknowledgeMessage(m.id));
  }
}
