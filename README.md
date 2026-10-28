# TransVille Live — démo SpacetimeDB

Démo de **SpacetimeDB utilisé comme backend complet** : la base de données, la logique serveur et le
temps réel tiennent dans un seul module C#, sans API REST ni serveur applicatif.

Le scénario est celui d'un poste de commande (PCC) de transport public. Un opérateur fictif,
TransVille, exploite 3 lignes, 18 arrêts et 5 bus sur la géographie réelle de Fribourg. Trois écrans
Angular partagent la même base en temps réel :

| Écran | Route | Pour qui |
|---|---|---|
| Supervision PCC | `/supervision` | Superviseur (code d'accès `PCC2026`) |
| Poste chauffeur | `/chauffeur` | Chauffeur, format mobile |
| Borne d'arrêt | `/arret/:stopId` | Voyageur, anonyme |

Version en ligne : **https://transville.baillod.tech**

## Comment ça marche

```
 navigateur (Angular)                         SpacetimeDB (base transit-demo)
 ┌─────────────────────┐   WebSocket   ┌──────────────────────────────────────┐
 │ abonnements SQL ◄───┼───────────────┤ tables publiques + vues par client   │
 │ appels de reducers ─┼──────────────►│ reducers C# (transactions)           │
 └─────────────────────┘               │ simulation planifiée (1 tick/s)      │
                                       └──────────────────────────────────────┘
```

- **Écritures** : le client appelle des *reducers*, des fonctions C# transactionnelles exécutées
  dans la base (prise de service, signalement d'incident, message au chauffeur…). L'autorisation y
  est vérifiée avec `ctx.Sender`, l'identité authentifiée de l'appelant.
- **Lectures** : le client s'abonne à des requêtes SQL. La base envoie les lignes initiales puis
  chaque modification. Le client n'interroge jamais la base.
- **Données privées** : les tables sensibles, comme les messages chauffeur, sont privées. Les clients
  les lisent à travers des *vues* filtrées par identité (`MyMessages`, `SupervisorMessages`,
  `AuditTrail`). Les lignes des autres ne quittent pas le serveur.
- **Simulation** : une table planifiée déclenche un reducer chaque seconde, qui fait avancer les bus
  et calcule les retards.

## Organisation du dépôt

| Chemin | Contenu |
|---|---|
| `spacetimedb/` | Module serveur C# (.NET 8, compilé en WebAssembly) |
| ↳ `Lib.cs` | Types et tables |
| ↳ `Reducers.cs` | Reducers métier et cycle de vie (connexion, déconnexion) |
| ↳ `Views.cs` | Vues filtrées par identité |
| ↳ `Simulation.cs` | Tick de simulation et escalade automatique des incidents |
| ↳ `Seed.cs` | Réseau de Fribourg chargé à l'initialisation |
| `demo-app/` | Client Angular 22 (signals, Tailwind, Leaflet), voir [`demo-app/README.md`](demo-app/README.md) |
| ↳ `src/module_bindings/` | Bindings TypeScript **générés** par `spacetime generate`, à ne pas modifier |
| ↳ `src/app/core/spacetime.service.ts` | Connexion, abonnements et appels de reducers |
| ↳ `scripts/e2e-smoke.mjs` | Test de bout en bout contre une base réelle |
| `presentation/` | Présentation HTML (`index.html`), assemblée depuis `src/parts/` par `src/assemble.sh` |
| `Dockerfile`, `deploy/nginx.conf` | Image de l'app Angular servie par nginx |
| `docker-compose.yml` | Stack serveur : SpacetimeDB officiel + app, derrière Traefik |
| `.github/workflows/docker-publish.yml` | Publie l'image de l'app sur GHCR à chaque push sur `main` |
| `DEMO.md` | Guide du présentateur : prérequis, script de démo, dépannage, déploiement |
| `SPEC.md` | Spécification technique : tables, reducers, vues, simulation |

## Démarrage local

Prérequis : CLI `spacetime` 2.12, **.NET SDK 8** avec le workload `wasi-experimental`, Node.js 24.
Sur macOS, .NET 10 ne sait pas compiler le module : voir [`DEMO.md`](DEMO.md#1-prérequis).

```bash
# Terminal 1 : serveur SpacetimeDB local (http://127.0.0.1:3000)
spacetime start

# Terminal 2 : compilation et publication du module, puis génération des bindings
export DOTNET_ROOT=$HOME/.dotnet PATH=$HOME/.dotnet:$PATH
spacetime publish transit-demo --server local -p ./spacetimedb --yes
spacetime generate --lang typescript --out-dir ./demo-app/src/module_bindings -p ./spacetimedb --yes

# Terminal 3 : application Angular (http://localhost:4200)
cd demo-app && npm install && npm start
```

Vérification : `cd demo-app && node scripts/e2e-smoke.mjs` doit afficher 30 tests réussis.

Bon à savoir :
- `spacetime.json` vise maincloud par défaut. On passe donc toujours `--server local`, et
  `--no-config` pour `sql`, `call`, `logs` et `subscribe`.
- Pour repartir d'une base vierge, ajouter `--delete-data=always` au `publish`.

## Déploiement

- **App Angular** : chaque push sur `main` construit l'image
  `ghcr.io/johnattansoftcom/demo-spacetimedb-web:latest`. Sur le serveur, il suffit de la récupérer
  et de redéployer la stack dans Dockhand.
- **Serveur** : `docker-compose.yml` lance l'image officielle `clockworklabs/spacetime`. Traefik
  envoie `/v1` vers SpacetimeDB et le reste vers l'app, sur le même domaine.
- **Module** : il se publie à la main avec la CLI, en utilisant la config dédiée qui contient
  l'identité propriétaire de la base :

  ```bash
  spacetime --config-path ~/.config/spacetime/transville.toml \
    publish transit-demo --server transville -p ./spacetimedb --no-config --yes
  ```

Détails, sauvegarde et limites assumées : [`DEMO.md`, section 10](DEMO.md#10-déploiement-serveur-transvillebaillodtech).

## Présentation

Ouvrir `presentation/index.html` dans un navigateur. Pour la modifier, éditer les fichiers de
`presentation/src/parts/`, puis relancer `presentation/src/assemble.sh`.
