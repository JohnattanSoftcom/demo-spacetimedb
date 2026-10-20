import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { SpacetimeService } from '../../core/spacetime.service';
import { SupervisionStore } from './supervision-store';

type Speed = 1 | 2 | 5 | 10;

/** Demo toolbar: inject incident, simulation speed / pause, reset (two-step confirmation). */
@Component({
  selector: 'app-demo-controls',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-slate-900 px-3 py-2 text-white">
      <span class="text-[10px] font-semibold tracking-wider text-white/50 uppercase">Démo</span>
      <button
        type="button"
        class="rounded-md bg-red-600 px-2.5 py-1 text-xs font-semibold shadow hover:bg-red-500 disabled:opacity-50"
        [disabled]="!stdb.isConnected() || store.isPending('inject')"
        (click)="injectIncident()"
      >
        ⚡ Injecter un incident
      </button>

      <div class="flex overflow-hidden rounded-md ring-1 ring-white/20" role="group" aria-label="Vitesse de simulation">
        @for (s of speeds; track s) {
          <button
            type="button"
            class="px-2 py-1 text-xs font-semibold tabular-nums transition-colors disabled:opacity-50"
            [class]="stdb.simConfig()?.speedFactor === s ? 'bg-white text-slate-900' : 'text-white/70 hover:bg-white/10'"
            [attr.aria-pressed]="stdb.simConfig()?.speedFactor === s"
            [disabled]="!stdb.isConnected() || store.isPending('speed')"
            (click)="setSpeed(s)"
          >
            ×{{ s }}
          </button>
        }
      </div>

      <button
        type="button"
        class="rounded-md px-2 py-1 text-xs font-semibold ring-1 ring-white/20 hover:bg-white/10 disabled:opacity-50"
        [class.bg-amber-500]="stdb.simConfig()?.paused"
        [class.text-slate-900]="stdb.simConfig()?.paused"
        [disabled]="!stdb.isConnected() || store.isPending('pause')"
        (click)="togglePause()"
      >
        {{ stdb.simConfig()?.paused ? '▶ Reprendre' : '❚❚ Pause' }}
      </button>

      <span class="text-[11px] text-white/50 tabular-nums" title="Tick de la table planifiée SimTick (1 s)">
        tick #{{ tick() }}
      </span>

      <div class="ml-auto flex items-center gap-1">
        @if (confirmReset()) {
          <span class="text-[11px] text-amber-300">Tout effacer ?</span>
          <button type="button" class="rounded px-2 py-1 text-xs text-white/70 hover:bg-white/10" (click)="confirmReset.set(false)">Non</button>
          <button
            type="button"
            class="rounded-md bg-amber-500 px-2 py-1 text-xs font-semibold text-slate-900 hover:bg-amber-400 disabled:opacity-50"
            [disabled]="!stdb.isConnected() || store.isPending('reset')"
            (click)="reset()"
          >
            Oui, réinitialiser
          </button>
        } @else {
          <button
            type="button"
            class="rounded-md px-2 py-1 text-xs text-white/70 ring-1 ring-white/20 hover:bg-white/10"
            (click)="confirmReset.set(true)"
          >
            ↺ Réinitialiser
          </button>
        }
      </div>
    </div>
  `,
})
export class DemoControls {
  protected readonly stdb = inject(SpacetimeService);
  protected readonly store = inject(SupervisionStore);
  protected readonly speeds: Speed[] = [1, 2, 5, 10];
  protected readonly confirmReset = signal(false);

  protected tick(): string {
    return String(this.stdb.simConfig()?.tickCount ?? 0n);
  }

  protected injectIncident(): void {
    void this.store.run('inject', 'Injecter un incident', () => this.stdb.conn.reducers.injectRandomIncident({})).then((ok) => {
      if (ok) this.store.tab.set('incidents');
    });
  }
  protected setSpeed(factor: Speed): void {
    void this.store.run('speed', 'Vitesse de simulation', () => this.stdb.conn.reducers.setSimSpeed({ factor }));
  }
  protected togglePause(): void {
    const paused = !this.stdb.simConfig()?.paused;
    void this.store.run('pause', 'Pause simulation', () => this.stdb.conn.reducers.setSimPaused({ paused }));
  }
  protected reset(): void {
    void this.store.run('reset', 'Réinitialiser la démo', () => this.stdb.conn.reducers.resetDemo({})).then(() => this.confirmReset.set(false));
  }
}
