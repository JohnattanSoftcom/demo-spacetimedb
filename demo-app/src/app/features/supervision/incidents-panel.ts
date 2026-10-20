import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import {
  INCIDENT_KIND_LABELS,
  INCIDENT_STATUS_LABELS,
  SEVERITY_CLASSES,
  SEVERITY_LABELS,
  SEVERITY_RANK,
  byTimestampDesc,
  formatAge,
  formatShortTime,
  tsMicros,
} from '../../core/labels';
import { SpacetimeService } from '../../core/spacetime.service';
import type { Incident } from '../../../module_bindings/types';
import { SupervisionStore } from './supervision-store';

/** Real-time delay between automatic escalations (SPEC §3, EscalateIncident). */
const ESCALATION_DELAY_MS = 30_000;
const KIND_ICONS: Record<Incident['kind']['tag'], string> = {
  Breakdown: '🔧',
  Accident: '💥',
  Assault: '🚨',
  PassengerIllness: '🩺',
  Delay: '⏱',
};

type Column = 'Open' | 'InProgress' | 'Resolved';

@Component({
  selector: 'app-incidents-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="sticky top-0 z-10 grid grid-cols-3 gap-1 border-b border-slate-200 bg-white p-2">
      @for (c of columns; track c.key) {
        <button
          type="button"
          class="flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-semibold transition-colors"
          [class]="column() === c.key ? c.active : 'text-slate-600 hover:bg-slate-100'"
          (click)="column.set(c.key)"
        >
          {{ c.label }}
          <span class="rounded-full bg-black/10 px-1.5 tabular-nums">{{ counts()[c.key] }}</span>
        </button>
      }
    </div>

    <ul class="space-y-2 p-3">
      @for (i of visible(); track i.id) {
        <li
          class="rounded-lg border bg-white p-3 shadow-sm"
          [class]="i.status.tag === 'Open' ? 'border-l-4 border-red-200 border-l-red-500' : i.status.tag === 'InProgress' ? 'border-l-4 border-amber-200 border-l-amber-500' : 'border-slate-200 opacity-80'"
        >
          <div class="flex items-start gap-2">
            <span class="text-xl leading-none" aria-hidden="true">{{ icon(i) }}</span>
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-1.5">
                <span class="font-semibold text-slate-900">{{ kindLabel(i) }}</span>
                <span class="rounded px-1.5 py-0.5 text-[11px] font-semibold" [class]="sevClass(i)">{{ sevLabel(i) }}</span>
                @if (i.escalations > 0) {
                  <span
                    class="rounded bg-fuchsia-600 px-1.5 py-0.5 text-[11px] font-semibold text-white"
                    [class.animate-pulse]="i.status.tag === 'Open'"
                    title="Escaladé automatiquement par le serveur (table planifiée)"
                    >▲ Escaladé ×{{ i.escalations }}</span
                  >
                }
                <span class="ml-auto text-[11px] whitespace-nowrap text-slate-500" [title]="time(i)">{{ age(i) }}</span>
              </div>
              <div class="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-slate-600">
                @if (lineOf(i); as l) {
                  <span class="rounded px-1 text-[10px] font-bold text-white" [style.background]="l.color">{{ l.code }}</span>
                }
                <span>{{ vehicleLabel(i) }}</span>
                <span class="text-slate-400">·</span>
                <span>Signalé par {{ i.reporterName }}</span>
              </div>
              @if (i.description) {
                <p class="mt-1.5 rounded bg-slate-50 px-2 py-1 text-xs text-slate-700 italic">« {{ i.description }} »</p>
              }

              @if (i.status.tag === 'Open' && i.severity.tag !== 'Critical') {
                <div class="mt-2">
                  <div class="flex justify-between text-[11px] text-slate-500">
                    <span>Escalade automatique</span>
                    <span class="tabular-nums">dans {{ escalationIn(i) }} s</span>
                  </div>
                  <div class="mt-0.5 h-1 overflow-hidden rounded bg-slate-100">
                    <div class="h-full bg-red-400 transition-[width] duration-1000 ease-linear" [style.width.%]="escalationPct(i)"></div>
                  </div>
                </div>
              }

              @if (i.status.tag !== 'Open') {
                <p class="mt-1.5 text-xs" [class]="i.status.tag === 'Resolved' ? 'text-emerald-700' : 'text-amber-800'">
                  {{ statusLabel(i) }} par <span class="font-semibold">{{ i.assigneeName || '—' }}</span>
                  @if (i.resolvedAt) {
                    à {{ short(i.resolvedAt) }}
                  }
                </p>
              }

              @if (resolving() === i.id) {
                <div class="mt-2 space-y-2 rounded-md bg-emerald-50 p-2">
                  <label class="block text-xs font-medium text-emerald-900" [for]="'note-' + i.id">Note de clôture (facultatif)</label>
                  <textarea
                    [id]="'note-' + i.id"
                    rows="2"
                    maxlength="280"
                    class="w-full rounded border border-emerald-200 bg-white px-2 py-1 text-sm"
                    placeholder="Ex. dépanneuse sur place, véhicule remis en service"
                    [value]="note()"
                    (input)="note.set($any($event.target).value)"
                  ></textarea>
                  <div class="flex justify-end gap-2">
                    <button type="button" class="rounded px-2 py-1 text-xs text-slate-600 hover:bg-white" (click)="resolving.set(undefined)">Annuler</button>
                    <button
                      type="button"
                      class="rounded bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                      [disabled]="!stdb.isConnected() || store.isPending('resolve-' + i.id)"
                      (click)="resolve(i)"
                    >
                      Confirmer la résolution
                    </button>
                  </div>
                </div>
              }

              <div class="mt-2 flex flex-wrap gap-1.5">
                @if (i.status.tag === 'Open') {
                  <button
                    type="button"
                    class="rounded-md bg-red-600 px-2.5 py-1 text-xs font-semibold text-white shadow-sm hover:bg-red-700 disabled:opacity-50"
                    [disabled]="!stdb.isConnected() || store.isPending('take-' + i.id)"
                    (click)="take(i)"
                  >
                    {{ store.isPending('take-' + i.id) ? 'Envoi…' : 'Prendre en charge' }}
                  </button>
                }
                @if (i.status.tag !== 'Resolved' && resolving() !== i.id) {
                  <button
                    type="button"
                    class="rounded-md px-2.5 py-1 text-xs font-semibold shadow-sm disabled:opacity-50"
                    [class]="i.status.tag === 'InProgress' ? 'bg-emerald-600 text-white hover:bg-emerald-700' : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50'"
                    [disabled]="!stdb.isConnected()"
                    (click)="startResolve(i)"
                  >
                    Résoudre
                  </button>
                }
                @if (i.status.tag !== 'Resolved' && hasDriver(i)) {
                  <button
                    type="button"
                    class="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    (click)="store.writeTo(i.vehicleId)"
                  >
                    ✉ Contacter le chauffeur
                  </button>
                }
                <button
                  type="button"
                  class="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  (click)="store.focusOn(i.lat, i.lon)"
                >
                  ⌖ Localiser
                </button>
              </div>
            </div>
          </div>
        </li>
      } @empty {
        <li class="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
          @switch (column()) {
            @case ('Open') {
              Aucun incident ouvert. Utilisez « Injecter un incident » ou signalez-en un depuis le poste chauffeur.
            }
            @case ('InProgress') {
              Aucun incident pris en charge.
            }
            @default {
              Aucun incident résolu.
            }
          }
        </li>
      }
    </ul>
  `,
})
export class IncidentsPanel {
  protected readonly stdb = inject(SpacetimeService);
  protected readonly store = inject(SupervisionStore);

  protected readonly columns: { key: Column; label: string; active: string }[] = [
    { key: 'Open', label: 'Ouverts', active: 'bg-red-600 text-white' },
    { key: 'InProgress', label: 'Pris en charge', active: 'bg-amber-500 text-white' },
    { key: 'Resolved', label: 'Résolus', active: 'bg-emerald-600 text-white' },
  ];
  protected readonly column = signal<Column>('Open');
  protected readonly resolving = signal<bigint | undefined>(undefined);
  protected readonly note = signal('');

  protected readonly counts = computed(() => {
    const c: Record<Column, number> = { Open: 0, InProgress: 0, Resolved: 0 };
    for (const i of this.stdb.incidents()) c[i.status.tag]++;
    return c;
  });

  protected readonly visible = computed(() => {
    const col = this.column();
    const rows = this.stdb.incidents().filter((i) => i.status.tag === col);
    if (col === 'Resolved') return rows.sort(byTimestampDesc((i) => i.resolvedAt ?? i.updatedAt));
    // Active: most severe first, then most recent (ordering by timestamp, never by auto-inc id).
    const byTime = byTimestampDesc<Incident>((i) => i.reportedAt);
    return rows.sort((a, b) => SEVERITY_RANK[b.severity.tag] - SEVERITY_RANK[a.severity.tag] || byTime(a, b));
  });

  protected icon(i: Incident): string {
    return KIND_ICONS[i.kind.tag];
  }
  protected kindLabel(i: Incident): string {
    return INCIDENT_KIND_LABELS[i.kind.tag];
  }
  protected sevLabel(i: Incident): string {
    return SEVERITY_LABELS[i.severity.tag];
  }
  protected sevClass(i: Incident): string {
    return SEVERITY_CLASSES[i.severity.tag];
  }
  protected statusLabel(i: Incident): string {
    return INCIDENT_STATUS_LABELS[i.status.tag];
  }
  protected age(i: Incident): string {
    return formatAge(i.reportedAt, this.store.now());
  }
  protected time(i: Incident): string {
    return `Signalé à ${formatShortTime(i.reportedAt)}`;
  }
  protected short(ts: Incident['reportedAt']): string {
    return formatShortTime(ts);
  }
  protected lineOf(i: Incident) {
    return this.stdb.lineById().get(i.lineId);
  }
  protected vehicleLabel(i: Incident): string {
    return i.vehicleId ? (this.stdb.vehicleById().get(i.vehicleId)?.label ?? `Véhicule ${i.vehicleId}`) : 'Réseau';
  }
  protected hasDriver(i: Incident): boolean {
    return !!i.vehicleId && this.stdb.assignmentByVehicleId().has(i.vehicleId);
  }

  /** Open incidents escalate ESCALATION_DELAY after their last change (report or previous escalation). */
  private escalationRemainingMs(i: Incident): number {
    const due = Number(tsMicros(i.updatedAt) / 1000n) + ESCALATION_DELAY_MS;
    return Math.max(0, due - this.store.now());
  }
  protected escalationIn(i: Incident): number {
    return Math.ceil(this.escalationRemainingMs(i) / 1000);
  }
  protected escalationPct(i: Incident): number {
    return 100 - (this.escalationRemainingMs(i) / ESCALATION_DELAY_MS) * 100;
  }

  protected take(i: Incident): void {
    void this.store.run(`take-${i.id}`, 'Prendre en charge', () => this.stdb.conn.reducers.takeIncident({ incidentId: i.id })).then((ok) => {
      if (ok) this.column.set('InProgress');
    });
  }
  protected startResolve(i: Incident): void {
    this.note.set('');
    this.resolving.set(i.id);
  }
  protected resolve(i: Incident): void {
    const note = this.note().trim();
    void this.store
      .run(`resolve-${i.id}`, 'Résoudre', () => this.stdb.conn.reducers.resolveIncident({ incidentId: i.id, note }))
      .then((ok) => {
        if (ok) this.resolving.set(undefined);
      });
  }
}
