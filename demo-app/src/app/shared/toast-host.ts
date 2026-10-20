import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ToastService, type Toast } from '../core/toast.service';

/** Fixed top-right toast stack (mounted once in the App root). */
@Component({
  selector: 'app-toast-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet],
  template: `
    <ng-template #toastTpl let-t>
      <div
        class="pointer-events-auto flex items-start gap-3 rounded-lg border-l-4 bg-white p-3 text-sm shadow-lg ring-1 ring-black/5"
        [class]="accent(t)"
      >
        <span class="mt-0.5 text-base leading-none" aria-hidden="true">{{ icon(t) }}</span>
        <div class="min-w-0 flex-1">
          <p class="font-semibold text-slate-900">{{ t.title }}</p>
          @if (t.body) {
            <p class="mt-0.5 break-words text-slate-600">{{ t.body }}</p>
          }
        </div>
        <button type="button" class="text-slate-400 hover:text-slate-700" (click)="toast.dismiss(t.id)" aria-label="Fermer">
          ✕
        </button>
      </div>
    </ng-template>
    <!-- Two persistent live regions (one announcement per toast): errors and PCC messages are
         assertive, everything else polite. Individual toasts carry no live role of their own. -->
    <div class="pointer-events-none fixed top-14 right-3 z-[2000] flex w-[min(24rem,calc(100vw-1.5rem))] flex-col gap-2">
      <div class="flex flex-col gap-2" aria-live="assertive" aria-atomic="false">
        @for (t of urgent(); track t.id) {
          <ng-container *ngTemplateOutlet="toastTpl; context: { $implicit: t }" />
        }
      </div>
      <div class="flex flex-col gap-2" aria-live="polite" aria-atomic="false">
        @for (t of polite(); track t.id) {
          <ng-container *ngTemplateOutlet="toastTpl; context: { $implicit: t }" />
        }
      </div>
    </div>
  `,
})
export class ToastHost {
  protected readonly toast = inject(ToastService);
  protected readonly urgent = computed(() => this.toast.toasts().filter((t) => isUrgent(t)));
  protected readonly polite = computed(() => this.toast.toasts().filter((t) => !isUrgent(t)));

  protected accent(t: Toast): string {
    if (t.severity === 'Critical' || t.kind === 'error') return 'border-red-600';
    if (t.severity === 'High' || t.kind === 'escalation') return 'border-orange-500';
    if (t.kind === 'incident' || t.kind === 'warning') return 'border-amber-500';
    if (t.kind === 'resolved' || t.kind === 'success') return 'border-emerald-500';
    if (t.kind === 'message') return 'border-sky-600';
    return 'border-slate-400';
  }

  protected icon(t: Toast): string {
    switch (t.kind) {
      case 'error':
        return '⛔';
      case 'incident':
      case 'warning':
        return '⚠️';
      case 'escalation':
        return '🔺';
      case 'resolved':
      case 'success':
        return '✅';
      case 'message':
        return '✉️';
      default:
        return 'ℹ️';
    }
  }
}

function isUrgent(t: Toast): boolean {
  return t.kind === 'error' || t.kind === 'message';
}
