import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { DEMO_SUPERVISOR_CODE } from '../../core/config';
import { ROLE_LABELS, role } from '../../core/labels';
import { SpacetimeService } from '../../core/spacetime.service';
import { AuditPanel } from './audit-panel';
import { DemoControls } from './demo-controls';
import { IncidentsPanel } from './incidents-panel';
import { MessagesPanel } from './messages-panel';
import { OnlinePanel } from './online-panel';
import { SupervisionStore, type SupervisionTab } from './supervision-store';
import { TransitMap } from './transit-map';
import { VehiclesPanel } from './vehicles-panel';

/** /supervision — PCC operator screen: live map + tabs (vehicles, incidents, messages, audit, presence). */
@Component({
  selector: 'app-supervision',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [SupervisionStore],
  imports: [TransitMap, VehiclesPanel, IncidentsPanel, MessagesPanel, AuditPanel, OnlinePanel, DemoControls],
  templateUrl: './supervision.html',
})
export class Supervision {
  protected readonly stdb = inject(SpacetimeService);
  protected readonly store = inject(SupervisionStore);
  private readonly sub = this.stdb.subscribeSupervision();

  protected readonly demoCode = DEMO_SUPERVISOR_CODE;
  protected readonly name = signal('');
  protected readonly code = signal('');

  protected readonly tabs = computed<{ key: SupervisionTab; label: string; badge?: number; alert?: boolean }[]>(() => {
    const open = this.stdb.incidents().filter((i) => i.status.tag === 'Open').length;
    const unread = this.stdb.supervisorMessages().filter((m) => !m.acknowledged).length;
    return [
      { key: 'vehicles', label: 'Véhicules', badge: this.stdb.vehicles().length },
      { key: 'incidents', label: 'Incidents', badge: open || undefined, alert: open > 0 },
      { key: 'messages', label: 'Messages', badge: unread || undefined },
      { key: 'audit', label: "Journal d'audit" },
      { key: 'online', label: 'En ligne', badge: this.stdb.onlineIdentities().size },
    ];
  });

  protected readonly kpis = computed(() => {
    const positions = this.stdb.positions();
    const assignments = this.stdb.assignments();
    const online = this.stdb.onlineIdentities();
    const active = this.stdb.activeIncidents();
    const avgDelay = positions.length ? positions.reduce((s, p) => s + Math.max(0, p.delaySeconds), 0) / positions.length : 0;
    const late = positions.filter((p) => p.delaySeconds > 180).length;
    return {
      vehicles: positions.length,
      immobilized: positions.filter((p) => p.status.tag === 'Immobilized').length,
      driversOnline: assignments.filter((a) => online.has(a.driverIdentity.toHexString())).length,
      drivers: assignments.length,
      open: active.filter((i) => i.status.tag === 'Open').length,
      inProgress: active.filter((i) => i.status.tag === 'InProgress').length,
      avgDelayMin: Math.round(avgDelay / 6) / 10,
      late,
    };
  });

  /** A driver identity that registers as supervisor loses its bus (server-side rule). */
  protected readonly driverVehicle = computed(() => {
    const a = this.stdb.myAssignment();
    return a ? this.stdb.vehicleById().get(a.vehicleId)?.label : undefined;
  });
  protected readonly currentRoleLabel = computed(() => {
    const r = this.stdb.myRole();
    return r ? ROLE_LABELS[r] : undefined;
  });

  /** ARIA tabs pattern: arrows / Home / End move between tabs (roving tabindex, automatic activation). */
  protected onTabKeydown(event: KeyboardEvent): void {
    const keys = this.tabs().map((t) => t.key);
    const i = keys.indexOf(this.store.tab());
    let next: number;
    switch (event.key) {
      case 'ArrowRight':
        next = (i + 1) % keys.length;
        break;
      case 'ArrowLeft':
        next = (i - 1 + keys.length) % keys.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = keys.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    this.store.tab.set(keys[next]);
    document.getElementById(`sup-tab-${keys[next]}`)?.focus();
  }

  constructor() {
    inject(DestroyRef).onDestroy(() => this.sub.dispose());
  }

  protected register(): void {
    const name = this.name().trim();
    const accessCode = this.code().trim();
    void this.store.run('register', 'Connexion superviseur', () =>
      this.stdb.conn.reducers.registerUser({ name, role: role('Supervisor'), accessCode }),
    );
  }

  /** Demo of server-side authorization: the same reducer, called without the role, is refused. */
  protected tryWithoutRole(): void {
    void this.store.run('try-unauthorized', 'Injecter un incident (sans rôle)', () => this.stdb.conn.reducers.injectRandomIncident({}));
  }
}
