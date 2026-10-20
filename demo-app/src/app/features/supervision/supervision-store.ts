import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { DisconnectedError, UnknownCallResultError } from 'spacetimedb';
import { SpacetimeService, cleanServerMessage } from '../../core/spacetime.service';
import { ToastService } from '../../core/toast.service';

export type SupervisionTab = 'vehicles' | 'incidents' | 'messages' | 'audit' | 'online';

/** A reducer call refused by the server (shown inline, not only as a toast). */
export interface Refusal {
  id: number;
  action: string;
  message: string;
  at: number;
}

/** A point the map should fly to (incident "Localiser"). `seq` makes repeated clicks re-trigger. */
export interface MapFocus {
  lat: number;
  lon: number;
  seq: number;
}

/**
 * Screen-scoped state for /supervision (provided by the `Supervision` page component):
 * tab, selection, map focus, message composer target, a 1 s clock and the reducer-call helper
 * that keeps track of pending actions and server refusals.
 */
@Injectable()
export class SupervisionStore {
  private readonly stdb = inject(SpacetimeService);
  private readonly toast = inject(ToastService);

  readonly tab = signal<SupervisionTab>('vehicles');
  readonly selectedVehicleId = signal<number | undefined>(undefined);
  readonly focus = signal<MapFocus | undefined>(undefined);
  /** Vehicle preselected in the message composer. */
  readonly messageVehicleId = signal<number | undefined>(undefined);

  /** Client clock (ms), ticks every second: ages, SLA countdowns. */
  readonly now = signal(Date.now());

  /** Keys of actions currently awaiting the server (buttons show a spinner / are disabled). */
  readonly pending = signal<ReadonlySet<string>>(new Set());
  readonly refusals = signal<readonly Refusal[]>([]);
  readonly lastRefusal = computed(() => this.refusals()[0]);
  private refusalSeq = 0;
  private focusSeq = 0;

  constructor() {
    const t = setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(t));
  }

  isPending(key: string): boolean {
    return this.pending().has(key);
  }

  selectVehicle(id: number | undefined): void {
    this.selectedVehicleId.set(id);
  }

  focusOn(lat: number, lon: number): void {
    this.focus.set({ lat, lon, seq: ++this.focusSeq });
  }

  writeTo(vehicleId: number): void {
    this.messageVehicleId.set(vehicleId);
    this.tab.set('messages');
  }

  dismissRefusal(id: number): void {
    this.refusals.update((l) => l.filter((r) => r.id !== id));
  }

  /**
   * Call a reducer. Resolves true on success. On failure, the server's French message is shown in
   * a toast AND kept in `refusals` (inline banner), so the audience sees that the *server* refused.
   */
  async run(key: string, label: string, fn: () => Promise<unknown>): Promise<boolean> {
    if (!this.stdb.isConnected()) {
      this.toast.error('Non connecté au serveur');
      return false;
    }
    if (this.pending().has(key)) return false;
    this.pending.update((s) => new Set(s).add(key));
    try {
      await fn();
      return true;
    } catch (e) {
      if (e instanceof UnknownCallResultError) {
        this.toast.error('Résultat inconnu (connexion perdue)', "L'action a peut-être été appliquée.");
      } else if (e instanceof DisconnectedError) {
        this.toast.error('Non connecté au serveur');
      } else {
        const message = cleanServerMessage(e);
        this.toast.error('Action refusée par le serveur', message);
        const r: Refusal = { id: ++this.refusalSeq, action: label, message, at: Date.now() };
        this.refusals.update((l) => [r, ...l].slice(0, 5));
        setTimeout(() => this.dismissRefusal(r.id), 12000);
      }
      return false;
    } finally {
      this.pending.update((s) => {
        const n = new Set(s);
        n.delete(key);
        return n;
      });
    }
  }
}
