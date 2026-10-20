import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { formatAge, shortIdentity, tsMicros } from '../../core/labels';
import { SpacetimeService } from '../../core/spacetime.service';
import type { Timestamp } from 'spacetimedb';
import { SupervisionStore } from './supervision-store';

interface OnlineEntry {
  hex: string;
  name: string;
  connections: number;
  since: Timestamp;
  vehicle?: string;
  isMe: boolean;
}

@Component({
  selector: 'app-online-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p class="m-3 rounded-md bg-sky-50 px-3 py-2 text-[11px] leading-snug text-sky-900">
      Présence alimentée par les hooks <code>ClientConnected</code> / <code>ClientDisconnected</code> du module : aucune logique de
      « heartbeat » côté client.
    </p>
    @for (g of groups(); track g.title) {
      <section class="px-3 pb-3">
        <h3 class="mb-1.5 flex items-center gap-2 text-xs font-semibold tracking-wider text-slate-500 uppercase">
          {{ g.title }} <span class="rounded-full bg-slate-200 px-1.5 text-slate-700">{{ g.entries.length }}</span>
        </h3>
        <ul class="space-y-1">
          @for (e of g.entries; track e.hex) {
            <li class="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-sm">
              <span class="size-2 rounded-full bg-emerald-500"></span>
              <span class="font-medium text-slate-800">{{ e.name }}</span>
              @if (e.isMe) {
                <span class="rounded bg-slate-900 px-1 text-[10px] text-white">vous</span>
              }
              @if (e.vehicle) {
                <span class="rounded bg-sky-100 px-1.5 text-[11px] text-sky-800">{{ e.vehicle }}</span>
              }
              <span class="ml-auto text-[11px] text-slate-400">
                @if (e.connections > 1) {
                  {{ e.connections }} onglets ·
                }
                {{ age(e.since) }}
              </span>
            </li>
          } @empty {
            <li class="text-xs text-slate-400 italic">Personne.</li>
          }
        </ul>
      </section>
    }
    <section class="px-3 pb-4">
      <h3 class="mb-1.5 flex items-center gap-2 text-xs font-semibold tracking-wider text-slate-500 uppercase">
        Bornes / visiteurs anonymes <span class="rounded-full bg-slate-200 px-1.5 text-slate-700">{{ anonymous().length }}</span>
      </h3>
      <div class="flex flex-wrap gap-1">
        @for (e of anonymous(); track e.hex) {
          <code class="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600" [title]="e.hex">{{ e.name }}</code>
        } @empty {
          <span class="text-xs text-slate-400 italic">Aucune borne connectée.</span>
        }
      </div>
    </section>
  `,
})
export class OnlinePanel {
  private readonly stdb = inject(SpacetimeService);
  private readonly store = inject(SupervisionStore);

  private readonly entries = computed(() => {
    const users = this.stdb.userByIdentity();
    const vehicleById = this.stdb.vehicleById();
    const myHex = this.stdb.identityHex();
    const vehicleByDriver = new Map(this.stdb.assignments().map((a) => [a.driverIdentity.toHexString(), a.vehicleId]));
    const byHex = new Map<string, OnlineEntry & { role?: string }>();
    for (const p of this.stdb.presence()) {
      const hex = p.identity.toHexString();
      const cur = byHex.get(hex);
      if (cur) {
        cur.connections++;
        if (tsMicros(p.connectedAt) < tsMicros(cur.since)) cur.since = p.connectedAt;
        continue;
      }
      const u = users.get(hex);
      const vId = vehicleByDriver.get(hex);
      byHex.set(hex, {
        hex,
        name: u?.name ?? shortIdentity(hex),
        role: u?.role.tag,
        connections: 1,
        since: p.connectedAt,
        vehicle: vId !== undefined ? vehicleById.get(vId)?.label : undefined,
        isMe: hex === myHex,
      });
    }
    return [...byHex.values()].sort((a, b) => a.name.localeCompare(b.name));
  });

  protected readonly groups = computed(() => {
    const all = this.entries();
    return [
      { title: 'Superviseurs PCC', entries: all.filter((e) => e.role === 'Supervisor') },
      { title: 'Chauffeurs', entries: all.filter((e) => e.role === 'Driver') },
    ];
  });
  protected readonly anonymous = computed(() => this.entries().filter((e) => !e.role || e.role === 'Passenger'));

  protected age(ts: Timestamp): string {
    return `connecté ${formatAge(ts, this.store.now())}`;
  }
}
