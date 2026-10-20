import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  ViewEncapsulation,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import * as L from 'leaflet';
import { MAP_CENTER, MAP_ZOOM } from '../../core/config';
import { INCIDENT_KIND_LABELS, SEVERITY_COLORS, SEVERITY_LABELS, VEHICLE_STATUS_LABELS, formatDelay } from '../../core/labels';
import { SpacetimeService } from '../../core/spacetime.service';
import { SupervisionStore } from './supervision-store';

interface VehicleMarker {
  marker: L.Marker;
  key: string;
}

/**
 * Live Leaflet map: line polylines, stops, moving buses (markers are created once and moved with
 * `setLatLng`; a CSS transform transition interpolates between 1 s ticks), unresolved incidents.
 */
@Component({
  selector: 'app-transit-map',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styles: `
    .tv-veh { transition: transform 1s linear; }
    .tv-map-zooming .tv-veh { transition: none !important; }
    .tv-veh-b { position: relative; width: 34px; height: 34px; display: grid; place-items: center; }
    .tv-veh-c { width: 30px; height: 30px; border-radius: 9999px; background: var(--c); color: #fff;
      font: 800 10.5px/26px ui-sans-serif, system-ui, sans-serif; text-align: center; letter-spacing: -.02em;
      border: 2px solid #fff; box-shadow: 0 0 0 1px rgb(15 23 42 / .5), 0 2px 6px rgb(0 0 0 / .4); position: relative; z-index: 1; }
    .tv-veh-a { position: absolute; inset: 0; transition: transform .6s ease; }
    .tv-veh-a::before { content: ''; position: absolute; left: 50%; top: -3px; transform: translateX(-50%);
      border: 6px solid transparent; border-bottom: 8px solid var(--c); border-top: 0; }
    .tv-veh.is-sel .tv-veh-c { outline: 3px solid #0f172a; outline-offset: 1px; }
    .tv-veh.is-late .tv-veh-c { border-color: #f59e0b; }
    .tv-veh.is-nodriver .tv-veh-c { border-style: dashed; filter: saturate(.75); }
    .tv-veh.is-alert .tv-veh-c { border-color: #dc2626; }
    .tv-veh.is-alert .tv-veh-b::after { content: ''; position: absolute; inset: 0; border-radius: 9999px;
      border: 3px solid #dc2626; animation: tv-pulse 1.2s ease-out infinite; }
    .tv-veh-d { position: absolute; right: 0; bottom: 1px; width: 10px; height: 10px; border-radius: 9999px;
      border: 2px solid #fff; z-index: 2; }
    .tv-inc { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 6px; transform: rotate(45deg);
      background: var(--c); border: 2px solid #fff; box-shadow: 0 1px 4px rgb(0 0 0 / .4); }
    .tv-inc span { transform: rotate(-45deg); color: #fff; font: 800 14px/1 ui-sans-serif, system-ui; }
    .tv-inc.is-open { animation: tv-blink 1s steps(2, start) infinite; }
    @keyframes tv-pulse { from { transform: scale(.9); opacity: 1; } to { transform: scale(1.9); opacity: 0; } }
    @keyframes tv-blink { 50% { filter: brightness(1.35); } }
  `,
  template: `
    <div class="relative size-full">
      <div #mapEl class="size-full bg-slate-200" role="application" aria-label="Carte du réseau en temps réel"></div>

      <!-- Legend -->
      <div class="pointer-events-none absolute top-3 left-14 z-[1000] flex flex-wrap gap-1.5">
        @for (l of stdb.lines(); track l.id) {
          <span
            class="pointer-events-auto inline-flex items-center gap-1.5 rounded-full bg-white/95 px-2.5 py-1 text-xs font-medium text-slate-800 shadow ring-1 ring-black/5"
            [title]="l.name"
          >
            <span class="grid h-4 min-w-4 place-items-center rounded px-1 text-[10px] font-bold text-white" [style.background]="l.color">{{ l.code }}</span>
            {{ l.name }}
          </span>
        }
      </div>

      <!-- Event-table feed -->
      @if (alerts().length) {
        <div class="pointer-events-none absolute bottom-6 left-3 z-[1000] flex w-72 flex-col gap-1.5">
          <p class="text-[10px] font-semibold tracking-wider text-slate-700 uppercase drop-shadow-sm">Fil d'alertes (table événementielle)</p>
          @for (a of alerts(); track a.seq) {
            <div class="rounded-md bg-slate-900/85 px-2.5 py-1.5 text-xs text-white shadow backdrop-blur">
              <span class="mr-1 inline-block size-2 rounded-full" [style.background]="sevColor(a.severity.tag)"></span>
              <span class="font-semibold">{{ a.title }}</span>
              @if (a.body) {
                <span class="text-white/70"> — {{ a.body }}</span>
              }
            </div>
          }
        </div>
      }

      @if (!stdb.baseReady()) {
        <div class="absolute inset-0 z-[1000] grid place-items-center bg-slate-100/70 text-sm text-slate-600">Chargement du réseau…</div>
      }
    </div>
  `,
})
export class TransitMap {
  protected readonly stdb = inject(SpacetimeService);
  private readonly store = inject(SupervisionStore);
  private readonly mapEl = viewChild.required<ElementRef<HTMLDivElement>>('mapEl');

  private readonly map = signal<L.Map | undefined>(undefined);
  private networkLayer?: L.LayerGroup;
  private readonly vehicleMarkers = new Map<number, VehicleMarker>();
  private readonly incidentMarkers = new Map<string, { marker: L.Marker; key: string }>();
  private fitted = false;

  protected readonly alerts = computed(() => this.stdb.recentAlerts().slice(0, 3));
  protected sevColor(tag: keyof typeof SEVERITY_COLORS): string {
    return SEVERITY_COLORS[tag];
  }

  /** vehicleId → has an unresolved, blocking incident. */
  private readonly alertVehicleIds = computed(() => {
    const s = new Set<number>();
    for (const i of this.stdb.activeIncidents()) if (i.vehicleId && i.kind.tag !== 'Delay') s.add(i.vehicleId);
    return s;
  });

  constructor() {
    const destroyRef = inject(DestroyRef);

    afterNextRender(() => {
      const el = this.mapEl().nativeElement;
      const map = L.map(el, { zoomControl: true, attributionControl: true }).setView(MAP_CENTER, MAP_ZOOM);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap',
      }).addTo(map);
      map.on('zoomstart', () => el.classList.add('tv-map-zooming'));
      map.on('zoomend', () => requestAnimationFrame(() => el.classList.remove('tv-map-zooming')));
      map.on('click', () => this.store.selectVehicle(undefined));
      const ro = new ResizeObserver(() => map.invalidateSize());
      ro.observe(el);
      destroyRef.onDestroy(() => {
        ro.disconnect();
        map.remove();
      });
      this.map.set(map);
    });

    // Network (lines + stops): rebuilt only when reference data changes (rare).
    effect(() => {
      const map = this.map();
      const routes = this.stdb.routeByLineId();
      const lines = this.stdb.lines();
      const stops = this.stdb.stops();
      const lineIdsByStop = this.stdb.lineIdsByStopId();
      const lineById = this.stdb.lineById();
      if (!map) return;
      this.networkLayer?.remove();
      const group = L.layerGroup();
      for (const line of lines) {
        const route = routes.get(line.id);
        if (!route?.length) continue;
        const pts = route.map((r) => [r.stop.lat, r.stop.lon] as L.LatLngTuple);
        L.polyline(pts, { color: '#ffffff', weight: 9, opacity: 0.9, interactive: false }).addTo(group);
        L.polyline(pts, { color: line.color, weight: 5, opacity: 0.9 })
          .bindTooltip(`Ligne ${line.code} · ${line.name}`, { sticky: true })
          .addTo(group);
      }
      for (const stop of stops) {
        const served = [...(lineIdsByStop.get(stop.id) ?? [])]
          .map((id) => lineById.get(id))
          .filter((l) => !!l)
          .map((l) => `<span style="background:${l!.color};color:#fff;border-radius:3px;padding:0 4px;font-weight:700">${l!.code}</span>`)
          .join(' ');
        L.circleMarker([stop.lat, stop.lon], {
          radius: 5,
          color: '#0f172a',
          weight: 2,
          fillColor: '#ffffff',
          fillOpacity: 1,
        })
          .bindTooltip(`<b>${escapeHtml(stop.name)}</b> ${served}<br><span style="color:#64748b">Clic : ouvrir la borne d'arrêt</span>`, {
            direction: 'top',
            offset: [0, -4],
          })
          .on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            window.open(`/arret/${stop.id}`, '_blank', 'noopener');
          })
          .addTo(group);
      }
      group.addTo(map);
      this.networkLayer = group;

      if (!this.fitted && stops.length) {
        this.fitted = true;
        map.fitBounds(L.latLngBounds(stops.map((s) => [s.lat, s.lon] as L.LatLngTuple)), { padding: [40, 40] });
      }
    });

    // Vehicles: diffed by id, moved in place each tick.
    effect(() => {
      const map = this.map();
      const positions = this.stdb.positions();
      const vehicleById = this.stdb.vehicleById();
      const lineById = this.stdb.lineById();
      const stopById = this.stdb.stopById();
      const assignments = this.stdb.assignmentByVehicleId();
      const online = this.stdb.onlineIdentities();
      const alertIds = this.alertVehicleIds();
      const selected = this.store.selectedVehicleId();
      if (!map) return;

      const seen = new Set<number>();
      for (const p of positions) {
        seen.add(p.vehicleId);
        const vehicle = vehicleById.get(p.vehicleId);
        const line = lineById.get(p.lineId);
        const color = line?.color ?? '#334155';
        const shortLabel = vehicle?.label.replace(/^\D+/, '') || String(p.vehicleId);
        let vm = this.vehicleMarkers.get(p.vehicleId);
        const iconKey = `${color}|${shortLabel}`;
        if (!vm || vm.key !== iconKey) {
          vm?.marker.remove();
          const icon = L.divIcon({
            className: 'tv-veh',
            html: `<div class="tv-veh-b" style="--c:${color}"><div class="tv-veh-a"></div><div class="tv-veh-c">${escapeHtml(shortLabel)}</div><span class="tv-veh-d" hidden></span></div>`,
            iconSize: [34, 34],
            iconAnchor: [17, 17],
            tooltipAnchor: [16, 0],
          });
          const id = p.vehicleId;
          const marker = L.marker([p.lat, p.lon], { icon, riseOnHover: true, zIndexOffset: 500 })
            .bindTooltip('', { direction: 'right' })
            .on('click', (e) => {
              L.DomEvent.stopPropagation(e);
              this.store.selectVehicle(id);
              this.store.tab.set('vehicles');
            })
            .addTo(map);
          vm = { marker, key: iconKey };
          this.vehicleMarkers.set(p.vehicleId, vm);
        } else {
          const cur = vm.marker.getLatLng();
          if (cur.lat !== p.lat || cur.lng !== p.lon) vm.marker.setLatLng([p.lat, p.lon]);
        }

        const a = assignments.get(p.vehicleId);
        const driverOnline = a ? online.has(a.driverIdentity.toHexString()) : false;
        const isAlert = p.status.tag === 'Immobilized' || alertIds.has(p.vehicleId);
        const el = vm.marker.getElement();
        if (el) {
          el.classList.toggle('is-alert', isAlert);
          el.classList.toggle('is-late', !isAlert && p.delaySeconds > 180);
          el.classList.toggle('is-nodriver', !a);
          el.classList.toggle('is-sel', selected === p.vehicleId);
          const arrow = el.querySelector<HTMLElement>('.tv-veh-a');
          if (arrow) arrow.style.transform = `rotate(${Math.round(p.heading)}deg)`;
          const dot = el.querySelector<HTMLElement>('.tv-veh-d');
          if (dot) {
            dot.hidden = !a;
            dot.style.background = driverOnline ? '#22c55e' : '#94a3b8';
          }
        }
        vm.marker.setZIndexOffset(selected === p.vehicleId ? 1000 : isAlert ? 800 : 500);
        const next = stopById.get(p.nextStopId)?.name ?? '—';
        vm.marker.setTooltipContent(
          `<b>${escapeHtml(vehicle?.label ?? 'Bus')}</b> · Ligne ${escapeHtml(line?.code ?? '?')}<br>` +
            `${VEHICLE_STATUS_LABELS[p.status.tag]} · ${formatDelay(p.delaySeconds)}<br>` +
            `Prochain arrêt : ${escapeHtml(next)}<br>` +
            (a ? `Chauffeur : ${escapeHtml(a.driverName)} ${driverOnline ? '(en ligne)' : '(hors ligne)'}` : 'Sans chauffeur'),
        );
      }
      for (const [id, vm] of this.vehicleMarkers) {
        if (!seen.has(id)) {
          vm.marker.remove();
          this.vehicleMarkers.delete(id);
        }
      }
    });

    // Unresolved incidents.
    effect(() => {
      const map = this.map();
      const incidents = this.stdb.activeIncidents();
      const vehicleById = this.stdb.vehicleById();
      if (!map) return;
      const seen = new Set<string>();
      for (const i of incidents) {
        const id = String(i.id);
        seen.add(id);
        const color = SEVERITY_COLORS[i.severity.tag];
        const key = `${color}|${i.status.tag}|${i.lat}|${i.lon}`;
        const existing = this.incidentMarkers.get(id);
        if (existing?.key === key) continue;
        existing?.marker.remove();
        const icon = L.divIcon({
          className: '',
          html: `<div class="tv-inc ${i.status.tag === 'Open' ? 'is-open' : ''}" style="--c:${color}"><span>!</span></div>`,
          iconSize: [26, 26],
          iconAnchor: [13, 30],
        });
        const veh = i.vehicleId ? vehicleById.get(i.vehicleId)?.label : undefined;
        const marker = L.marker([i.lat, i.lon], { icon, zIndexOffset: 300 })
          .bindTooltip(
            `<b>${INCIDENT_KIND_LABELS[i.kind.tag]}</b> · ${SEVERITY_LABELS[i.severity.tag]}` +
              (veh ? `<br>${escapeHtml(veh)}` : '') +
              (i.assigneeName ? `<br>Pris en charge par ${escapeHtml(i.assigneeName)}` : '<br>Non pris en charge'),
            { direction: 'top', offset: [0, -28] },
          )
          .on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            this.store.tab.set('incidents');
          })
          .addTo(map);
        this.incidentMarkers.set(id, { marker, key });
      }
      for (const [id, im] of this.incidentMarkers) {
        if (!seen.has(id)) {
          im.marker.remove();
          this.incidentMarkers.delete(id);
        }
      }
    });

    // Fly to a selected vehicle (only when the selection changes, not on every tick).
    effect(() => {
      const map = this.map();
      const id = this.store.selectedVehicleId();
      if (!map || id === undefined) return;
      const p = untracked(() => this.stdb.positionByVehicleId().get(id));
      if (p) map.flyTo([p.lat, p.lon], Math.max(map.getZoom(), 15), { duration: 0.6 });
    });

    // Fly to an explicit focus point (incident "Localiser").
    effect(() => {
      const map = this.map();
      const f = this.store.focus();
      if (map && f) map.flyTo([f.lat, f.lon], 16, { duration: 0.6 });
    });
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
