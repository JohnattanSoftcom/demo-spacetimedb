import { ChangeDetectionStrategy, Component, computed, inject, linkedSignal } from '@angular/core';
import { DEMO_SUPERVISOR_CODE } from '../../core/config';
import { SpacetimeService } from '../../core/spacetime.service';

interface ScreenCard {
  path: string;
  title: string;
  icon: string;
  audience: string;
  text: string;
  points: string[];
}

interface Feature {
  feature: string;
  where: string;
  argument: string;
}

@Component({
  selector: 'app-landing',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './landing.html',
})
export class Landing {
  protected readonly stdb = inject(SpacetimeService);
  protected readonly supervisorCode = DEMO_SUPERVISOR_CODE;

  /** Stops sorted by name, with the lines serving each one. */
  protected readonly stopOptions = computed(() => {
    const lineIdsByStop = this.stdb.lineIdsByStopId();
    const lineById = this.stdb.lineById();
    return [...this.stdb.stops()]
      .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
      .map((s) => ({
        id: s.id,
        name: s.name,
        lines: [...(lineIdsByStop.get(s.id) ?? [])]
          .map((id) => lineById.get(id))
          .filter((l) => !!l)
          .sort((a, b) => a.code.localeCompare(b.code, 'fr', { numeric: true })),
      }));
  });

  /** Default: "Fribourg, Gare" (served by the 3 lines) or the first stop. */
  protected readonly selectedStopId = linkedSignal<number | undefined>(() => {
    const opts = this.stopOptions();
    return (opts.find((o) => o.lines.length >= 3) ?? opts[0])?.id;
  });

  protected readonly selectedStop = computed(() =>
    this.stopOptions().find((o) => o.id === this.selectedStopId()),
  );

  protected readonly lines = computed(() =>
    [...this.stdb.lines()].sort((a, b) => a.code.localeCompare(b.code, 'fr', { numeric: true })),
  );

  protected onStopChange(value: string): void {
    this.selectedStopId.set(Number(value));
  }

  protected readonly cards: ScreenCard[] = [
    {
      path: '/supervision',
      title: 'Supervision PCC',
      icon: '🖥️',
      audience: 'Opérateur du poste de commande centralisé',
      text: 'Carte temps réel du réseau, suivi des véhicules et des retards, gestion des incidents, messages aux chauffeurs et journal d’audit.',
      points: ['Carte Leaflet en direct', 'Incidents : ouvert → pris en charge → résolu', 'Contrôles de la simulation'],
    },
    {
      path: '/chauffeur',
      title: 'Chauffeur',
      icon: '🚌',
      audience: 'Application mobile du conducteur (simulée)',
      text: 'Le chauffeur prend un véhicule, voit sa ligne, son prochain arrêt et son retard, signale un incident et reçoit les messages du PCC.',
      points: ['Prise de véhicule transactionnelle', 'Signalement en un geste', 'Messages privés du PCC'],
    },
    {
      path: '/arret',
      title: 'Borne d’arrêt',
      icon: '🚏',
      audience: 'Écran voyageurs, sans connexion',
      text: 'Prochains départs par ligne calculés à partir des positions en direct, bandeau de perturbation dès qu’un incident touche une ligne.',
      points: ['Identité anonyme', 'Abonnement filtré à un seul arrêt', 'Mise à jour chaque seconde'],
    },
  ];

  protected readonly features: Feature[] = [
    {
      feature: 'Tables publiques + abonnements',
      where: 'Positions des bus, incidents, temps d’attente',
      argument: 'Pas d’API, pas de serveur WebSocket, pas de polling : les données sont poussées à chaque écran en quelques millisecondes.',
    },
    {
      feature: 'Abonnements filtrés',
      where: 'Borne : uniquement les départs de son arrêt',
      argument: 'Chaque appareil ne reçoit que sa part des données — essentiel pour des centaines de bornes.',
    },
    {
      feature: 'Tables privées',
      where: 'Code PCC, journal d’audit, messages, état interne de la simulation',
      argument: 'Les secrets et les données internes ne quittent jamais le serveur.',
    },
    {
      feature: 'Vues par utilisateur',
      where: 'Messages du chauffeur, journal d’audit (PCC uniquement)',
      argument: 'Confidentialité par construction : un chauffeur ne voit que ses messages (LPD/RGPD, cloisonnement de niveau police).',
    },
    {
      feature: 'Autorisation côté serveur (ctx.Sender + rôles)',
      where: 'Chaque action métier',
      argument: 'L’identité ne peut pas être falsifiée par le client ; les rôles sont stockés en base.',
    },
    {
      feature: 'Transactions atomiques + contraintes',
      where: 'Prise de véhicule, prise en charge d’incident',
      argument: 'Jamais deux chauffeurs sur le même bus, jamais deux superviseurs sur le même incident — sans verrou à écrire.',
    },
    {
      feature: 'Audit dans la même transaction',
      where: 'Toutes les actions métier',
      argument: 'Une piste d’audit complète et cohérente par conception (assureurs, police).',
    },
    {
      feature: 'Tables planifiées',
      where: 'Simulation chaque seconde, escalade automatique après 30 s',
      argument: 'Tâches de fond et règles de SLA dans la base, sans cron ni worker.',
    },
    {
      feature: 'Hooks de cycle de vie',
      where: 'Connexion / déconnexion → présence en ligne',
      argument: '« Chauffeur hors ligne » visible immédiatement, gratuitement.',
    },
    {
      feature: 'Table d’événements',
      where: 'Alertes « Nouvel incident », « Escalade »…',
      argument: 'Notifications instantanées sans stockage.',
    },
    {
      feature: 'Logique déterministe (ctx.Rng, ctx.Timestamp)',
      where: 'Retards simulés, incidents aléatoires',
      argument: 'Logique métier rejouable et testable.',
    },
    {
      feature: 'Republication à chaud',
      where: 'Pendant la démo',
      argument: 'Déployer une nouvelle logique sans déconnecter les clients.',
    },
  ];
}
