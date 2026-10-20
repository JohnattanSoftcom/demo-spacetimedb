import { Routes } from '@angular/router';
import { Landing } from './features/landing/landing';

export const routes: Routes = [
  { path: '', component: Landing, title: 'TransVille Live' },
  {
    path: 'supervision',
    loadComponent: () => import('./features/supervision/supervision').then((m) => m.Supervision),
    title: 'PCC – TransVille Live',
  },
  {
    path: 'chauffeur',
    loadComponent: () => import('./features/driver/driver').then((m) => m.Driver),
    title: 'Chauffeur – TransVille Live',
  },
  {
    // Stop board: kiosk mode (the App shell hides its top bar), `stopId` bound as input().
    path: 'arret/:stopId',
    loadComponent: () => import('./features/stop-board/stop-board').then((m) => m.StopBoard),
    title: 'Arrêt – TransVille Live',
    data: { kiosk: true },
  },
  { path: '**', redirectTo: '' },
];
