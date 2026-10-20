import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRouteSnapshot, NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs';
import { SpacetimeService } from './core/spacetime.service';
import { ConnectionBadge } from './shared/connection-badge';
import { ToastHost } from './shared/toast-host';

function deepest(route: ActivatedRouteSnapshot): ActivatedRouteSnapshot {
  return route.firstChild ? deepest(route.firstChild) : route;
}

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, ConnectionBadge, ToastHost],
  templateUrl: './app.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  private readonly router = inject(Router);
  protected readonly stdb = inject(SpacetimeService);

  /** Routes with `data: { kiosk: true }` (stop board) render full screen without the top bar. */
  protected readonly kiosk = toSignal(
    this.router.events.pipe(
      filter((e) => e instanceof NavigationEnd),
      map(() => !!deepest(this.router.routerState.snapshot.root).data['kiosk']),
    ),
    { initialValue: false },
  );

  protected readonly links = [
    { path: '/', label: 'Accueil', exact: true },
    { path: '/supervision', label: 'Supervision PCC', exact: false },
    { path: '/chauffeur', label: 'Chauffeur', exact: false },
  ];
}
