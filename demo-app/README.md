# TransVille Live — client Angular

Client de la démo **TransVille Live** : le centre d'exploitation temps réel d'un opérateur de transport
**fictif** (géographie de Fribourg), dont tout le backend est un module SpacetimeDB
(`../spacetimedb`). Le guide complet du présentateur se trouve dans [`../DEMO.md`](../DEMO.md).

## Écrans

| Route | Écran |
|---|---|
| `/` | Accueil, liens vers les écrans, choix d'un arrêt |
| `/supervision` | PCC : carte Leaflet live, véhicules, incidents, messages, audit, présence, contrôles de démo (code d'accès `PCC2026`) |
| `/chauffeur` | Poste chauffeur (format mobile) : prise de véhicule, signalements, messages privés du PCC |
| `/arret/:stopId` | Borne d'arrêt (anonyme) : prochains départs et perturbations, ex. `/arret/5` |

Chaque onglet obtient sa propre identité (jeton en `sessionStorage`) : ouvrir plusieurs onglets simule
plusieurs appareils. Ne pas utiliser « Dupliquer l'onglet ».

## Démarrage

Prérequis : Node 24, CLI `spacetime` 2.12, SDK .NET 8 dans `~/.dotnet` avec le workload `wasi-experimental`
(détails dans `../DEMO.md`).

```bash
# 1. Serveur local (terminal dédié)
spacetime start

# 2. Module + bindings (depuis la racine du dépôt)
export DOTNET_ROOT=$HOME/.dotnet PATH=$HOME/.dotnet:$PATH
spacetime publish transit-demo --server local -p ./spacetimedb --yes
spacetime generate --lang typescript --out-dir ./demo-app/src/module_bindings -p ./spacetimedb --yes

# 3. Client (depuis demo-app/)
npm install
npm start            # http://localhost:4200
```

En développement, le client se connecte à `ws://127.0.0.1:3000`, base `transit-demo` (`src/app/core/config.ts`).
Le build de production se connecte à sa propre origine : voir « Déploiement serveur » dans [`../DEMO.md`](../DEMO.md#10-déploiement-serveur-transvillebaillodtech).

## Scripts

| Commande | Rôle |
|---|---|
| `npm start` | Serveur de développement |
| `npm run build` | Build de production (`dist/demo-app`) |
| `npm test` | Tests unitaires (Vitest) |
| `node scripts/e2e-smoke.mjs` | Test de bout en bout contre la base locale (3 identités réelles, nettoie après lui) |

## Organisation du code

- `src/module_bindings/` — bindings TypeScript **générés** par `spacetime generate` (ne pas modifier à la main).
- `src/app/core/spacetime.service.ts` — connexion unique, abonnements, tables exposées en signals, appels de réducteurs.
- `src/app/core/labels.ts` — libellés français des enums du module.
- `src/app/features/` — écrans `supervision`, `driver`, `stop-board`, `landing`.
- `src/app/shared/` — toasts, badge de connexion.

Stack : Angular 22 (composants standalone, signals, zoneless), Tailwind CSS v4, Leaflet, SDK `spacetimedb` 2.12.
