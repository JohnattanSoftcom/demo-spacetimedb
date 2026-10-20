import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { VEHICLE_STATUS_LABELS, delayClass, formatDelay } from '../../core/labels';
import { SpacetimeService } from '../../core/spacetime.service';
import type { DriverAssignment, Line, Vehicle, VehiclePosition } from '../../../module_bindings/types';
import { SupervisionStore } from './supervision-store';

interface VehicleRow {
  vehicle: Vehicle;
  line?: Line;
  pos?: VehiclePosition;
  assignment?: DriverAssignment;
  driverOnline: boolean;
  nextStop: string;
  direction: string;
  activeIncidents: number;
}

@Component({
  selector: 'app-vehicles-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ul class="divide-y divide-slate-100">
      @for (r of rows(); track r.vehicle.id) {
        <li>
          <div
            class="group flex cursor-pointer gap-3 px-4 py-3 transition-colors hover:bg-slate-50"
            [class.bg-sky-50]="store.selectedVehicleId() === r.vehicle.id"
            [class.ring-1]="store.selectedVehicleId() === r.vehicle.id"
            [class.ring-sky-300]="store.selectedVehicleId() === r.vehicle.id"
            [class.ring-inset]="store.selectedVehicleId() === r.vehicle.id"
            role="button"
            tabindex="0"
            (click)="store.selectVehicle(r.vehicle.id)"
            (keydown.enter)="store.selectVehicle(r.vehicle.id)"
            (keydown.space)="$event.preventDefault(); store.selectVehicle(r.vehicle.id)"
          >
            <div
              class="relative mt-0.5 grid size-10 shrink-0 place-items-center rounded-full text-sm font-bold text-white shadow-sm ring-2"
              [style.background]="r.line?.color ?? '#334155'"
              [class]="r.pos?.status?.tag === 'Immobilized' || r.activeIncidents ? 'ring-red-500 animate-pulse' : 'ring-white'"
            >
              {{ r.line?.code ?? '?' }}
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span class="font-semibold text-slate-900">{{ r.vehicle.label }}</span>
                <span class="text-xs text-slate-500">{{ r.vehicle.model }}</span>
                <span class="ml-auto rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums" [class]="delayCls(r)">{{ delayText(r) }}</span>
              </div>
              <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-slate-600">
                <span class="inline-flex items-center gap-1">
                  <span class="size-1.5 rounded-full" [class]="statusDot(r)"></span>
                  {{ statusText(r) }}
                </span>
                <span class="truncate">→ {{ r.direction }}</span>
              </div>
              <div class="mt-0.5 truncate text-xs text-slate-600">
                Prochain arrêt : <span class="font-medium text-slate-800">{{ r.nextStop }}</span>
              </div>
              <div class="mt-1.5 flex items-center gap-2 text-xs">
                @if (r.assignment; as a) {
                  <span
                    class="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5"
                    [class]="r.driverOnline ? 'bg-emerald-50 text-emerald-800' : 'bg-slate-100 text-slate-600'"
                  >
                    <span class="size-2 rounded-full" [class]="r.driverOnline ? 'bg-emerald-500' : 'bg-slate-400'"></span>
                    {{ a.driverName }} · {{ r.driverOnline ? 'en ligne' : 'chauffeur hors ligne' }}
                  </span>
                } @else {
                  <span class="rounded-full bg-slate-100 px-2 py-0.5 text-slate-500 italic">Sans chauffeur</span>
                }
                @if (r.activeIncidents) {
                  <span class="rounded-full bg-red-100 px-2 py-0.5 font-medium text-red-700">⚠ {{ r.activeIncidents }} incident(s)</span>
                }
                @if (r.assignment && !r.driverOnline) {
                  <button
                    type="button"
                    class="ml-auto rounded-md border border-amber-300 bg-amber-50 px-2 py-1 font-medium text-amber-800 shadow-sm hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-40"
                    [disabled]="store.isPending('force-release-' + r.vehicle.id)"
                    title="Le chauffeur est hors ligne : libérer le véhicule pour un autre chauffeur"
                    (click)="$event.stopPropagation(); forceRelease(r)"
                    (keydown.enter)="$event.stopPropagation()"
                    (keydown.space)="$event.stopPropagation()"
                  >
                    Libérer
                  </button>
                }
                <button
                  type="button"
                  [class.ml-auto]="!(r.assignment && !r.driverOnline)"
                  class="rounded-md border border-slate-300 bg-white px-2 py-1 font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                  [disabled]="!r.assignment"
                  [title]="r.assignment ? 'Écrire au chauffeur' : 'Aucun chauffeur sur ce véhicule'"
                  (click)="$event.stopPropagation(); store.writeTo(r.vehicle.id)"
                  (keydown.enter)="$event.stopPropagation()"
                  (keydown.space)="$event.stopPropagation()"
                >
                  ✉ Message
                </button>
              </div>
            </div>
          </div>
        </li>
      } @empty {
        <li class="p-6 text-center text-sm text-slate-500">Aucun véhicule.</li>
      }
    </ul>
  `,
})
export class VehiclesPanel {
  protected readonly stdb = inject(SpacetimeService);
  protected readonly store = inject(SupervisionStore);

  protected readonly rows = computed<VehicleRow[]>(() => {
    const lineById = this.stdb.lineById();
    const stopById = this.stdb.stopById();
    const posById = this.stdb.positionByVehicleId();
    const asgById = this.stdb.assignmentByVehicleId();
    const online = this.stdb.onlineIdentities();
    const routes = this.stdb.routeByLineId();
    const incidentCount = new Map<number, number>();
    for (const i of this.stdb.activeIncidents()) {
      if (i.vehicleId) incidentCount.set(i.vehicleId, (incidentCount.get(i.vehicleId) ?? 0) + 1);
    }
    return [...this.stdb.vehicles()]
      .sort((a, b) => a.lineId - b.lineId || a.label.localeCompare(b.label))
      .map((vehicle) => {
        const pos = posById.get(vehicle.id);
        const assignment = asgById.get(vehicle.id);
        const route = routes.get(vehicle.lineId) ?? [];
        const terminus = pos ? (pos.forward ? route.at(-1) : route[0]) : undefined;
        return {
          vehicle,
          line: lineById.get(vehicle.lineId),
          pos,
          assignment,
          driverOnline: assignment ? online.has(assignment.driverIdentity.toHexString()) : false,
          nextStop: pos ? (stopById.get(pos.nextStopId)?.name ?? '—') : '—',
          direction: terminus ? `Direction ${terminus.stop.name}` : '—',
          activeIncidents: incidentCount.get(vehicle.id) ?? 0,
        };
      });
  });

  protected forceRelease(r: VehicleRow): void {
    const vehicleId = r.vehicle.id;
    void this.store.run(`force-release-${vehicleId}`, `Libérer le ${r.vehicle.label}`, () =>
      this.stdb.conn.reducers.forceReleaseVehicle({ vehicleId }),
    );
  }

  protected delayText(r: VehicleRow): string {
    return r.pos ? formatDelay(r.pos.delaySeconds) : '—';
  }
  protected delayCls(r: VehicleRow): string {
    return r.pos ? delayClass(r.pos.delaySeconds) : 'bg-slate-100 text-slate-500';
  }
  protected statusText(r: VehicleRow): string {
    return r.pos ? VEHICLE_STATUS_LABELS[r.pos.status.tag] : 'Position inconnue';
  }
  protected statusDot(r: VehicleRow): string {
    switch (r.pos?.status.tag) {
      case 'Immobilized':
        return 'bg-red-500';
      case 'AtStop':
        return 'bg-sky-500';
      case 'Layover':
        return 'bg-slate-400';
      case 'EnRoute':
        return 'bg-emerald-500';
      default:
        return 'bg-slate-300';
    }
  }
}
