import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import type { Incident, Line, StopEta } from '../../../module_bindings/types';
import { INCIDENT_KIND_LABELS, SEVERITY_RANK } from '../../core/labels';
import { type ScreenSubscription, SpacetimeService } from '../../core/spacetime.service';
import { ConnectionBadge } from '../../shared/connection-badge';

const MAX_ROWS = 8;

export interface DepartureRow {
  key: string;
  line: Line | undefined;
  lineCode: string;
  color: string;
  textColor: string;
  destination: string;
  vehicleLabel: string;
  eta: string;
  /** 'dock' | 'near' | 'min' | 'disrupted' — drives the styling of the ETA cell. */
  etaKind: 'dock' | 'near' | 'min' | 'disrupted';
  lateMinutes: number;
}

export interface Perturbation {
  id: bigint;
  critical: boolean;
  text: string;
}

/** Black or white text depending on the badge colour's luminance. */
function contrastText(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return '#ffffff';
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? '#0f172a' : '#ffffff';
}

/** Board ETA (SPEC §5): 0 → "À quai", < 60 s → "À l'approche", else ceil(min). */
function etaDisplay(e: StopEta): { eta: string; etaKind: DepartureRow['etaKind'] } {
  if (e.disrupted) return { eta: 'Perturbé', etaKind: 'disrupted' };
  if (e.etaSeconds <= 0) return { eta: 'À quai', etaKind: 'dock' };
  if (e.etaSeconds < 60) return { eta: "À l'approche", etaKind: 'near' };
  return { eta: `${Math.ceil(e.etaSeconds / 60)} min`, etaKind: 'min' };
}

const clockFmt = new Intl.DateTimeFormat('fr-CH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dateFmt = new Intl.DateTimeFormat('fr-CH', { weekday: 'long', day: 'numeric', month: 'long' });

/**
 * Passenger stop display ("borne d'arrêt"), kiosk mode, no login required (anonymous identity).
 * Subscribes only to its own stop's ETAs (server-side filtered) + incidents for the banner.
 */
@Component({
  selector: 'app-stop-board',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, ConnectionBadge],
  templateUrl: './stop-board.html',
  styles: `
    @keyframes sb-marquee { from { transform: translateX(0); } to { transform: translateX(-50%); } }
    .sb-marquee { animation: sb-marquee 22s linear infinite; }
    @keyframes sb-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
    .sb-blink { animation: sb-blink 1.2s ease-in-out infinite; }
    @keyframes sb-row-in { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
    .sb-row { animation: sb-row-in 0.4s ease-out; }
    @media (prefers-reduced-motion: reduce) {
      .sb-marquee, .sb-blink, .sb-row { animation: none; }
    }
  `,
})
export class StopBoard {
  protected readonly stdb = inject(SpacetimeService);
  private readonly router = inject(Router);

  /** Route param (bound by withComponentInputBinding), arrives as a string. */
  readonly stopId = input<string>();

  protected readonly numericStopId = computed(() => {
    const raw = this.stopId();
    if (raw == null || raw.trim() === '') return undefined;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 && n <= 0xffffffff ? n : undefined;
  });

  protected readonly stop = computed(() => {
    const id = this.numericStopId();
    return id === undefined ? undefined : this.stdb.stopById().get(id);
  });

  /** Unknown only once the base data is in (avoid flashing "Arrêt inconnu" while loading). */
  protected readonly unknownStop = computed(
    () => this.stdb.baseReady() && (this.numericStopId() === undefined || !this.stop()),
  );

  protected readonly sortedStops = computed(() =>
    [...this.stdb.stops()].sort((a, b) => a.name.localeCompare(b.name, 'fr')),
  );

  /** Lines serving this stop, sorted by code. */
  protected readonly servingLines = computed(() => {
    const id = this.numericStopId();
    if (id === undefined) return [];
    const ids = this.stdb.lineIdsByStopId().get(id) ?? new Set<number>();
    const byId = this.stdb.lineById();
    return [...ids]
      .map((l) => byId.get(l))
      .filter((l): l is Line => !!l)
      .sort((a, b) => a.code.localeCompare(b.code, 'fr', { numeric: true }))
      .map((l) => ({ ...l, textColor: contrastText(l.color) }));
  });

  private readonly handle = signal<ScreenSubscription | undefined>(undefined);
  private readonly subReady = computed(() => this.handle()?.ready() ?? false);

  protected readonly departures = computed<DepartureRow[]>(() => {
    const id = this.numericStopId();
    if (id === undefined) return [];
    const lineById = this.stdb.lineById();
    const vehicleById = this.stdb.vehicleById();
    return this.stdb
      .stopEtas()
      // While switching stop both subscriptions briefly overlap: keep only this stop's rows.
      .filter((e) => e.stopId === id)
      .sort((a, b) => a.etaSeconds - b.etaSeconds || a.key.localeCompare(b.key))
      .slice(0, MAX_ROWS)
      .map((e) => {
        const line = lineById.get(e.lineId);
        const color = line?.color ?? '#475569';
        return {
          key: e.key,
          line,
          lineCode: line?.code ?? '?',
          color,
          textColor: contrastText(color),
          destination: e.destination,
          vehicleLabel: vehicleById.get(e.vehicleId)?.label ?? '',
          lateMinutes: e.delaySeconds > 120 ? Math.round(e.delaySeconds / 60) : 0,
          ...etaDisplay(e),
        };
      });
  });

  /** Unresolved incidents on a line serving this stop, most severe first. */
  protected readonly perturbations = computed<Perturbation[]>(() => {
    const lines = new Map(this.servingLines().map((l) => [l.id, l]));
    if (lines.size === 0) return [];
    const vehicleById = this.stdb.vehicleById();
    return this.stdb
      .activeIncidents()
      .filter((i: Incident) => lines.has(i.lineId))
      .sort((a, b) => SEVERITY_RANK[b.severity.tag] - SEVERITY_RANK[a.severity.tag])
      .map((i) => {
        const vehicle = vehicleById.get(i.vehicleId)?.label;
        const kind = INCIDENT_KIND_LABELS[i.kind.tag];
        return {
          id: i.id,
          critical: i.severity.tag === 'High' || i.severity.tag === 'Critical',
          text: `Perturbation ligne ${lines.get(i.lineId)!.code} : ${kind}${vehicle ? ' – ' + vehicle : ''}. Retards possibles.`,
        };
      });
  });

  protected readonly bannerText = computed(() => this.perturbations().map((p) => p.text).join('   •   '));
  protected readonly bannerCritical = computed(() => this.perturbations().some((p) => p.critical));

  protected readonly speedFactor = computed(() => this.stdb.simConfig()?.speedFactor ?? 1);
  protected readonly paused = computed(() => this.stdb.simConfig()?.paused ?? false);

  // ---------------------------------------------------------------- client clock
  private readonly now = signal(new Date());
  protected readonly clock = computed(() => clockFmt.format(this.now()));
  protected readonly today = computed(() => dateFmt.format(this.now()));

  protected readonly loading = computed(() => !this.subReady() && this.stdb.status() !== 'error');

  constructor() {
    const destroyRef = inject(DestroyRef);
    const timer = setInterval(() => this.now.set(new Date()), 1000);

    // Re-subscribe when the stop changes: subscribe the new stop FIRST, then drop the old one.
    effect(() => {
      const id = this.numericStopId();
      untracked(() => {
        const previous = this.handle();
        this.handle.set(id === undefined ? undefined : this.stdb.subscribeStopBoard(id));
        previous?.dispose();
      });
    });

    destroyRef.onDestroy(() => {
      clearInterval(timer);
      this.handle()?.dispose();
      this.handle.set(undefined);
    });
  }

  protected switchStop(value: string): void {
    if (value) void this.router.navigate(['/arret', value]);
  }
}
