import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { shortIdentity } from '../core/labels';
import { SpacetimeService } from '../core/spacetime.service';

/** "Connecté / Reconnexion… / Hors ligne" pill + short identity. `dark` for the stop board. */
@Component({
  selector: 'app-connection-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span
      class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium"
      [class]="dark() ? 'bg-white/10 text-white/80' : 'bg-slate-100 text-slate-700'"
      [title]="title()"
    >
      <span class="size-2 rounded-full" [class]="dotClass()"></span>
      {{ label() }}
      @if (showIdentity() && stdb.identityHex(); as hex) {
        <code class="opacity-60">{{ short(hex) }}</code>
      }
    </span>
  `,
})
export class ConnectionBadge {
  protected readonly stdb = inject(SpacetimeService);
  readonly dark = input(false);
  readonly showIdentity = input(true);

  protected readonly label = computed(() => {
    switch (this.stdb.status()) {
      case 'connected':
        return 'Connecté';
      case 'connecting':
        return 'Connexion…';
      case 'reconnecting':
        return 'Reconnexion…';
      case 'disconnected':
        return 'Hors ligne';
      default:
        return 'Serveur injoignable';
    }
  });

  protected readonly dotClass = computed(() => {
    switch (this.stdb.status()) {
      case 'connected':
        return 'bg-emerald-500';
      case 'connecting':
      case 'reconnecting':
        return 'bg-amber-400 animate-pulse';
      default:
        return 'bg-red-500';
    }
  });

  protected readonly title = computed(() => {
    const hex = this.stdb.identityHex();
    const err = this.stdb.lastError();
    return [hex ? `Identité : ${hex}` : '', err ?? ''].filter(Boolean).join('\n');
  });

  protected short = shortIdentity;
}
