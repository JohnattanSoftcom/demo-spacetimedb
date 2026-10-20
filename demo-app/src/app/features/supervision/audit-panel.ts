import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { byTimestampDesc, formatTime } from '../../core/labels';
import { SpacetimeService } from '../../core/spacetime.service';
import type { AuditLog } from '../../../module_bindings/types';

const ACTION_STYLES: { prefix: string; cls: string }[] = [
  { prefix: 'INCIDENT_ESCALATED', cls: 'bg-fuchsia-100 text-fuchsia-800' },
  { prefix: 'INCIDENT_RESOLVED', cls: 'bg-emerald-100 text-emerald-800' },
  { prefix: 'INCIDENT', cls: 'bg-red-100 text-red-800' },
  { prefix: 'VEHICLE', cls: 'bg-sky-100 text-sky-800' },
  { prefix: 'MESSAGE', cls: 'bg-indigo-100 text-indigo-800' },
  { prefix: 'USER', cls: 'bg-teal-100 text-teal-800' },
  { prefix: 'SIM', cls: 'bg-slate-200 text-slate-700' },
  { prefix: 'DEMO', cls: 'bg-slate-800 text-white' },
];

@Component({
  selector: 'app-audit-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="sticky top-0 z-10 space-y-2 border-b border-slate-200 bg-white p-3">
      <p class="rounded-md bg-slate-900 px-3 py-2 text-[11px] leading-snug text-slate-200">
        🔒 Table privée <code class="text-amber-300">AuditLog</code>, exposée uniquement aux superviseurs par la vue
        <code class="text-amber-300">AuditTrail</code>. Chaque ligne est écrite <b>dans la même transaction</b> que l'action métier, horodatée par
        <code class="text-amber-300">ctx.Timestamp</code>.
      </p>
      <input
        type="search"
        class="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
        placeholder="Filtrer (acteur, action, détail)…"
        aria-label="Filtrer le journal"
        [value]="filter()"
        (input)="filter.set($any($event.target).value)"
      />
    </div>
    <ol class="divide-y divide-slate-100 font-mono text-xs">
      @for (a of rows(); track a.id) {
        <li class="flex gap-2 px-3 py-2 hover:bg-slate-50">
          <time class="shrink-0 text-slate-400 tabular-nums">{{ time(a) }}</time>
          <div class="min-w-0 flex-1 font-sans">
            <div class="flex flex-wrap items-center gap-1.5">
              <span class="rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold" [class]="actionClass(a)">{{ a.action }}</span>
              <span class="font-semibold text-slate-800">{{ a.actorName }}</span>
            </div>
            <p class="mt-0.5 break-words text-slate-600">{{ a.details }}</p>
          </div>
        </li>
      } @empty {
        <li class="p-6 text-center font-sans text-sm text-slate-500">
          {{ filter() ? 'Aucune entrée ne correspond au filtre.' : 'Journal vide.' }}
        </li>
      }
    </ol>
  `,
})
export class AuditPanel {
  private readonly stdb = inject(SpacetimeService);
  protected readonly filter = signal('');

  protected readonly rows = computed(() => {
    const f = this.filter().trim().toLowerCase();
    const rows = f
      ? this.stdb.auditTrail().filter((a) => `${a.actorName} ${a.action} ${a.details}`.toLowerCase().includes(f))
      : [...this.stdb.auditTrail()];
    return rows.sort(byTimestampDesc((a) => a.at));
  });

  protected time(a: AuditLog): string {
    return formatTime(a.at);
  }
  protected actionClass(a: AuditLog): string {
    return ACTION_STYLES.find((s) => a.action.startsWith(s.prefix))?.cls ?? 'bg-slate-100 text-slate-700';
  }
}
