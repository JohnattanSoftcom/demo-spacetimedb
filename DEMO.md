# TransVille Live — guide du présentateur

Démo de **SpacetimeDB comme backend complet** (base de données + logique serveur + temps réel)
pour un éditeur d'applications métier (transport public, police, assurance).

TransVille est un **opérateur fictif** sur la géographie réelle de Fribourg : 3 lignes, 18 arrêts, 5 bus.
Trois écrans partagent la même base :

| Écran | URL | Public | Ce qu'il montre |
|---|---|---|---|
| PCC (supervision) | `/supervision` | Superviseur | Carte live, véhicules, incidents, messages, journal d'audit, présence, contrôles de démo |
| Poste chauffeur | `/chauffeur` | Chauffeur (format mobile) | Prise de service, prochain arrêt, retard, signalement d'incident, messages privés du PCC |
| Borne d'arrêt | `/arret/:stopId` | Voyageur (anonyme) | Prochains départs en minutes, bandeau de perturbation |

Code d'accès superviseur de la démo : **`PCC2026`**.

---

## 1. Prérequis

| Outil | Version vérifiée | Remarque |
|---|---|---|
| .NET SDK **8** | 8.0.426 dans `~/.dotnet` | **Obligatoire pour compiler le module C#** |
| Workload `wasi-experimental` | 8.0.x | Compile le C# vers WebAssembly |
| CLI `spacetime` | 2.12.0 | Fournit aussi le serveur local |
| Node.js | 24.x | Client Angular 22 |

### Pourquoi .NET 8 et pas .NET 10 ?

Le module C# est compilé en WebAssembly (WASI). Sur .NET 10, le SDK SpacetimeDB passe par
NativeAOT-LLVM, **non supporté sur macOS**. Sur Mac, on compile donc avec le SDK .NET 8 installé
localement dans `~/.dotnet` (le `global.json` du module épingle `8.0.100` en `rollForward: latestFeature`).
Un .NET 10 installé globalement (`/usr/local/share/dotnet`) ne gêne pas, à condition de mettre
`~/.dotnet` en tête du `PATH`. Ne pas modifier `global.json`, ne pas passer le projet en `net10.0`.

Installation (une seule fois) :

```bash
curl -sSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 8.0 --install-dir ~/.dotnet
export DOTNET_ROOT=$HOME/.dotnet PATH=$HOME/.dotnet:$PATH
dotnet workload install wasi-experimental
```

**Dans chaque terminal** qui lance `spacetime build` / `publish` / `generate` :

```bash
export DOTNET_ROOT=$HOME/.dotnet PATH=$HOME/.dotnet:$PATH
dotnet --list-sdks          # doit afficher 8.0.4xx [~/.dotnet/sdk]
dotnet workload list        # doit afficher wasi-experimental
```

CLI SpacetimeDB : `curl -sSf https://install.spacetimedb.com | sh`, puis `spacetime --version`.

> Le message « Could not find wasm-opt to optimise the module » au build est **sans conséquence**
> (module non optimisé, largement suffisant pour la démo).

---

## 2. Démarrage (≈ 2 minutes)

Toutes les commandes ciblent le serveur **local** (`--server local`), base **`transit-demo`**.
`spacetime.json` à la racine pointe par défaut vers maincloud et `spacetime.local.json` nomme une autre
base : on passe donc toujours le nom de base et `--server local` explicitement, et **`--no-config`
pour `sql`, `call`, `logs`, `subscribe`, `describe`** (sinon : `failed to find database demo-app-rwnqq`).

```bash
# Terminal 1 — serveur SpacetimeDB local (http://127.0.0.1:3000), à laisser ouvert
spacetime start

# Terminal 2 — compilation + publication du module, génération des bindings TypeScript
export DOTNET_ROOT=$HOME/.dotnet PATH=$HOME/.dotnet:$PATH
cd ~/dev/demo-spacetimedb
spacetime server ping local
spacetime publish transit-demo --server local -p ./spacetimedb --yes
spacetime generate --lang typescript --out-dir ./demo-app/src/module_bindings -p ./spacetimedb --yes

# Terminal 3 — application Angular (http://localhost:4200)
cd ~/dev/demo-spacetimedb/demo-app
npm install        # première fois uniquement
npm start
```

Repartir d'une base vierge (efface toutes les données, rejoue `Init`) :

```bash
spacetime publish transit-demo --server local -p ./spacetimedb --delete-data=always --yes
```

Vérification express avant de monter sur scène :

```bash
spacetime sql --no-config transit-demo --server local "SELECT * FROM sim_config"   # tick_count augmente d'1/s
cd demo-app && node scripts/e2e-smoke.mjs                                           # 30 passed, 0 failed
```

Le test de bout en bout (`scripts/e2e-smoke.mjs`) connecte un superviseur et deux chauffeurs avec de
vraies identités, rejoue le scénario (double prise de bus refusée, incident, messages privés…) puis
nettoie derrière lui.

Avant la démo, cliquer **Réinitialiser** dans le PCC (ou republier avec `--delete-data=always`) pour
avoir un tableau d'incidents vide.

---

## 3. Disposition des onglets recommandée

Chaque onglet a **sa propre identité** : le jeton est stocké en `sessionStorage` (par onglet et par base,
`demo-app/src/app/core/config.ts:5-8`, `demo-app/src/app/core/spacetime.service.ts:50-70`).
Ouvrir les onglets via la page d'accueil (liens « nouvel onglet ») ou en tapant l'URL.
**Ne pas utiliser « Dupliquer l'onglet »** : le navigateur copie le `sessionStorage`, donc l'identité.

Idéal : 2 fenêtres côte à côte sur un grand écran (ou 2 écrans).

| # | Onglet / fenêtre | URL | Rôle |
|---|---|---|---|
| 1 | Grande fenêtre gauche | `http://localhost:4200/supervision` | « Marie » — Superviseur PCC (code `PCC2026`) |
| 2 | Fenêtre étroite (~400 px) en haut à droite | `http://localhost:4200/chauffeur` | « Paul » — chauffeur, Bus 101 (ligne 1) |
| 3 | Fenêtre étroite en bas à droite | `http://localhost:4200/chauffeur` | « Léa » — chauffeur, Bus 201 (ligne 2) |
| 4 | Fenêtre sombre plein écran (ou 2ᵉ écran) | `http://localhost:4200/arret/5` | Borne « Fribourg, Gare » (desservie par les 3 lignes) |

Astuce : utiliser le mode « appareil mobile » des DevTools pour les onglets chauffeur.
Garder un **terminal** visible pour les moments `spacetime sql` / `logs` / `publish`, et l'éditeur ouvert
sur `spacetimedb/` pour les moments « montrer le code ».

---

## 4. Script de démo (20–30 min)

Légende : 🎤 ce qu'on dit · 🖱 ce qu'on fait · 💡 argument métier · 🧩 fonctionnalité SpacetimeDB · 📄 code à montrer.

### Étape 0 — Le pitch (2 min)

🎤 « Une appli métier temps réel, aujourd'hui, c'est : une base SQL, une API REST, un serveur
WebSocket/SignalR pour pousser les mises à jour, un cache, un ordonnanceur pour les tâches de fond, et
du code pour garder tout ça cohérent. Ici, il n'y a **qu'une seule chose** : une base SpacetimeDB qui
contient à la fois les données et la logique métier. Pas de serveur d'application. »

🖱 Montrer l'arborescence : `spacetimedb/` (5 fichiers C#, ~1 250 lignes, tout le backend) et `demo-app/` (Angular).

💡 Moins de briques = moins de code d'intégration, moins d'infra, moins de pannes possibles.
🧩 Module = tables + réducteurs + vues, compilé en WebAssembly et exécuté **dans** la base.

### Étape 1 — La carte vivante (3 min)

🖱 Onglet 1 : se connecter en superviseur (« Marie », code `PCC2026`). Montrer la carte de Fribourg,
les 3 lignes colorées, les bus qui bougent chaque seconde, la liste des véhicules avec statut et retard.

🎤 « Personne ne fait de polling. Le client s'est abonné à des tables, et chaque seconde le serveur lui
pousse **uniquement les lignes qui ont changé**. »

🧩 Tables publiques + abonnements. Ordonnanceur intégré : la simulation est un réducteur planifié.

📄 Code :
- `spacetimedb/Lib.cs:72-87` — `VehiclePosition`, table publique « chaude » réécrite à chaque tick,
  **séparée** des métadonnées `Vehicle` (`Lib.cs:59-68`) : on découpe par schéma d'accès, pas par entité.
- `spacetimedb/Lib.cs:89-102` — `VehicleSimState` : table **privée**, les clients ne la voient jamais.
- `spacetimedb/Lib.cs:249-260` — `SimTick`, table planifiée ; `Reducers.cs:185` l'arme toutes les 1 s dans `Init`.
- `spacetimedb/Simulation.cs:110-218` — `SimulationTick` : déplace les bus, calcule le retard,
  avec une gigue déterministe `ctx.Rng` (`Simulation.cs:143`, `Simulation.cs:199`).
- `spacetimedb/Simulation.cs:113` + `Reducers.cs:69-73` — `RequireScheduler` : seul le planificateur
  (`ctx.DatabaseIdentity`) peut appeler le tick.
- Côté client : `demo-app/src/app/core/spacetime.service.ts:307-320` (abonnements du PCC) et
  `demo-app/src/app/features/supervision/transit-map.ts:196-239` (les marqueurs suivent un simple signal).

🖱 Terminal, pour prouver que c'est bien la base qui pousse :

```bash
spacetime subscribe --no-config transit-demo --server local --anonymous \
  "SELECT * FROM vehicle_position WHERE vehicle_id = 101" -n 3 -t 15
```

### Étape 2 — Prise de service chauffeur : identité et transaction atomique (4 min)

🖱 Onglet 2 : nom « Paul » → liste des véhicules. Onglet 3 : « Léa ».
Montrer côté PCC que les deux apparaissent dans « En ligne » instantanément.

🎤 « Chaque onglet est un appareil différent, avec sa propre identité cryptographique. Le rôle n'est
**pas** envoyé par le client comme un paramètre de confiance : il est stocké côté serveur et vérifié à
chaque appel à partir de `ctx.Sender`. »

🖱 Paul prend le **Bus 101**. Dans l'onglet de Léa, le Bus 101 passe immédiatement en « 🔒 Pris par Paul ».
Puis, avec les deux onglets côte à côte sur un même bus libre (ex. **Bus 102**), cliquer « Prendre » dans
les deux le plus vite possible : un seul gagne, l'autre reçoit « Le Bus 102 est déjà pris par … ».
Léa finit sur le **Bus 201**.

💡 Pas de double affectation possible, même en cas de course : c'est garanti par la base, pas par un verrou applicatif.
🧩 Réducteurs transactionnels (ACID, sérialisés) + contraintes d'unicité + présence via hooks de cycle de vie.

📄 Code :
- `spacetimedb/Lib.cs:104-114` — `DriverAssignment` : `[PrimaryKey] VehicleId` (un chauffeur par bus) et
  `[Unique] DriverIdentity` (un bus par chauffeur). Les doublons sont **impossibles** par construction.
- `spacetimedb/Reducers.cs:238-260` — `ClaimVehicle` : vérification du rôle, du véhicule libre,
  insertion et audit **dans la même transaction**.
- `spacetimedb/Reducers.cs:62-67` — `RequireRole` : l'autorisation repose sur `ctx.Sender`.
- `spacetimedb/Reducers.cs:190-205` — `ClientConnected` / `ClientDisconnected` → table `OnlinePresence` (`Lib.cs:128-136`).

### Étape 3 — Autorisation côté serveur (2 min)

🖱 Ouvrir un **nouvel** onglet `/supervision` sans se connecter, cliquer
« ⚡ Injecter un incident sans être superviseur » → « ⛔ Refusé par le serveur — Accès refusé : rôle Superviseur PCC requis. »

🖱 Même chose depuis le terminal, avec une identité anonyme :

```bash
spacetime call --no-config transit-demo --server local --anonymous inject_random_incident
# Error: Response text: Accès refusé : rôle Superviseur PCC requis.
```

🎤 « Masquer un bouton dans l'UI n'est pas de la sécurité. Ici, la règle est dans la base : quel que soit
le client (Angular, script, CLI), l'appel est refusé. »

📄 `spacetimedb/Reducers.cs:209-234` — `RegisterUser` : le rôle Superviseur n'est accordé que si le code
fourni correspond à la valeur stockée dans la table **privée** `DemoSetting` (`Lib.cs:138-145`, valeur
semée dans `Reducers.cs:186`). **Règle de démo assumée** : en production, le rôle viendrait des claims
du jeton OIDC (voir Q&R).

### Étape 4 — Incident chauffeur → PCC → borne voyageur (5 min)

🖱 Onglet Paul (Bus 101, ligne 1) : « Signaler un incident » → **Panne**, description courte.

À montrer simultanément :
- PCC : toast « Nouvel incident : Panne », marqueur sur la carte, carte dans « Ouverts », Bus 101 « Immobilisé ».
- Borne `/arret/5` : bandeau « Perturbation ligne 1 : Panne – Bus 101 », départ du Bus 101 affiché « Perturbé ».
- Journal d'audit du PCC : nouvelle ligne `INCIDENT_REPORTED`.

🎤 « Un seul appel de réducteur a : créé l'incident, planifié son escalade, émis une alerte, écrit l'audit.
Soit tout passe, soit rien. Et trois écrans différents se sont mis à jour sans une ligne de code de
synchronisation. »

💡 Chaîne d'information terrain → PCC → voyageurs en moins d'une seconde.
🧩 Table événementielle (`AlertEvent`), audit transactionnel, données calculées côté serveur.

📄 Code :
- `spacetimedb/Reducers.cs:286-297` — `ReportIncident` ; `Reducers.cs:146-175` — `CreateIncident`.
- `spacetimedb/Lib.cs:224-234` — `AlertEvent`, `Event = true` : diffusée aux abonnés, **jamais stockée** dans le cache client.
  Côté client : `demo-app/src/app/core/spacetime.service.ts:448-455` (seul `onInsert` existe → toast).
- `spacetimedb/Reducers.cs:85-105` — `Audit(...)` : horodaté par `ctx.Timestamp`, écrit dans la transaction de l'action.
- `spacetimedb/Simulation.cs:129-140` — un incident non résolu immobilise le bus (un « Retard » le ralentit de moitié).
- `spacetimedb/Simulation.cs:220-304` + `Lib.cs:262-277` — `StopEta` : les temps d'attente sont calculés
  **dans la base** à chaque tick ; la borne ne s'abonne qu'à **son** arrêt :
  `demo-app/src/app/core/spacetime.service.ts:334-335` (`tables.stopEta.where(r => r.stopId.eq(stopId))`).

### Étape 5 — Escalade automatique (3 min)

🖱 Ne **pas** prendre en charge l'incident. Attendre 30 s (en parlant) : la gravité passe
« Moyenne » → « Haute » (toast « Escalade : incident non pris en charge », ligne `INCIDENT_ESCALATED`
signée « Système » dans l'audit). Pour aller plus vite : cliquer « ⚡ Injecter un incident » plusieurs fois.

🎤 « Pas de cron, pas de worker, pas de file de messages : le module a planifié sa propre tâche, dans la
même transaction que la création de l'incident. Si l'incident est pris en charge avant, la tâche est
annulée, toujours de façon transactionnelle. »

📄 Code :
- `spacetimedb/Lib.cs:175-189` — `IncidentEscalation`, table planifiée (exécution unique à une date).
- `spacetimedb/Reducers.cs:8` — `EscalationDelay = 30 s` (c'est la ligne qu'on modifiera à chaud à l'étape 9).
- `spacetimedb/Reducers.cs:135-143` — `ScheduleEscalation` ; `Reducers.cs:369-383` — `EscalateIncident`
  (rechaîne une escalade toutes les 30 s jusqu'à « Critique »).

### Étape 6 — Prise en charge concurrente (2 min)

🖱 Ouvrir un 2ᵉ onglet `/supervision` (« Jean », code `PCC2026`). Marie et Jean cliquent
« Prendre en charge » sur le même incident : l'un réussit, l'autre reçoit
« Incident déjà pris en charge par Marie. ». Puis Marie le **résout** avec une note de clôture.
La borne redevient normale, le Bus 101 repart.

🧩 Même garantie transactionnelle que la prise de bus.
📄 `spacetimedb/Reducers.cs:314-333` — `TakeIncident` (annule l'escalade planifiée) ;
`Reducers.cs:335-367` — `ResolveIncident` (rétention : 30 incidents résolus conservés).

### Étape 7 — Messages privés PCC → chauffeur (3 min)

🖱 PCC : « Message à un chauffeur » → Bus 101 → « Déviation par Pérolles, arrêt Charmettes non desservi. »
Onglet Paul : toast « Nouveau message du PCC ». Onglet Léa : **rien**. Paul accuse réception → le PCC voit
le statut passer de « Non lu » à lu.

🎤 « Le PCC ne choisit pas une identité : il choisit un bus, et c'est le serveur qui résout le destinataire.
Et surtout, les messages de Paul **ne quittent jamais le serveur** vers le navigateur de Léa. Ce n'est pas
un filtre côté client, c'est la base qui ne les envoie pas. »

💡 Confidentialité par conception (RGPD/LPD) — vital pour la police ou l'assurance.
🧩 Table privée + vues par utilisateur (`ViewContext`, filtrées par `ctx.Sender`).

📄 Code :
- `spacetimedb/Lib.cs:191-207` — `DriverMessage` : **privée** (pas de `Public = true`).
- `spacetimedb/Views.cs:5-8` — vue `MyMessages` : `DriverMessage.ToDriver.Filter(ctx.Sender)`.
- `spacetimedb/Views.cs:10-21` — vue `SupervisorMessages` : liste vide si l'appelant n'est pas superviseur.
- `spacetimedb/Reducers.cs:387-416` — `SendDriverMessage` (destinataire résolu ligne 398) ;
  `Reducers.cs:418-428` — `AcknowledgeMessage` (refuse un message qui n'est pas le vôtre, ligne 422).

🖱 Preuve dans le terminal — une identité anonyme ne peut pas lire une table privée :

```bash
spacetime sql --no-config transit-demo --server local --anonymous "SELECT * FROM driver_message"
# Error: no such table: `driver_message`. If the table exists, it may be marked private.
spacetime sql --no-config transit-demo --server local --anonymous "SELECT * FROM line"   # table publique : OK
```

### Étape 8 — Journal d'audit (2 min)

🖱 PCC : panneau « Journal ». Toutes les actions de la démo y sont, horodatées par le serveur, y compris
celles du « Système » (escalades).

🎤 « L'audit est écrit dans la **même transaction** que l'action : impossible d'avoir une action sans trace,
ou une trace sans action. Et il n'est lisible que par les superviseurs. »

📄 `spacetimedb/Lib.cs:209-222` (table privée `AuditLog`, index sur `At`) ;
`spacetimedb/Views.cs:23-34` (vue `AuditTrail`, superviseurs uniquement, 100 dernières entrées triées par
horodatage — jamais par ID auto-incrémenté, qui n'est pas séquentiel).

```bash
spacetime sql --no-config transit-demo --server local "SELECT at, actor_name, action, details FROM audit_log"
```

(Le CLI lit les tables privées parce que son identité est **propriétaire** de la base.)

### Étape 9 — Mise à jour à chaud du module (4 min) — le moment « waouh »

Voir le détail en section 5. En résumé : passer le délai d'escalade de 30 s à 10 s, republier, **sans
déconnecter** aucun des 4 écrans, et montrer qu'un nouvel incident s'escalade maintenant en 10 s.

💡 Déploiement continu sans interruption de service pour un PCC qui tourne 24/7.
🧩 Hot-swap de module avec migration automatique du schéma.

### Étape 10 — Contrôles de démo et conclusion (2 min)

🖱 Barre « Démo » du PCC : vitesse ×1/×2/×5/×10 (les bus accélèrent sur tous les écrans, les ETA de la
borne se recalculent), Pause/Reprendre, compteur « tick #… ». Puis « Réinitialiser » → « Oui, réinitialiser ».

📄 `spacetimedb/Reducers.cs:432-441` (`SetSimSpeed`), `Reducers.cs:452-496` (`ResetDemo` : remet tout à
zéro et libère les bus des chauffeurs hors ligne), `spacetimedb/Seed.cs:94-128` (positions de départ
déterministes, sans aléa : un reset est reproductible).

🎤 Conclusion : « Ce que vous avez vu — carte live, rôles, transactions, tâches planifiées, confidentialité,
audit, présence, alertes, déploiement à chaud — c'est **un** binaire WebAssembly de ~1 250 lignes de C#,
et un client qui ne fait que s'abonner et appeler des fonctions. »

---

## 5. Scénario de mise à jour à chaud (vérifié)

Changement **sûr** : une constante de code, aucun changement de schéma.

1. Terminal A — suivre les logs pendant l'opération :

   ```bash
   spacetime logs --no-config transit-demo --server local -f
   ```

2. Éditeur — `spacetimedb/Reducers.cs`, ligne 8 :

   ```csharp
   static readonly TimeDuration EscalationDelay = TimeDuration.FromSeconds(10);   // était 30
   ```

3. Terminal B :

   ```bash
   export DOTNET_ROOT=$HOME/.dotnet PATH=$HOME/.dotnet:$PATH
   cd ~/dev/demo-spacetimedb
   spacetime publish transit-demo --server local -p ./spacetimedb --yes
   ```

   Sortie attendue : `Database Migration Plan` **vide**, puis `Updated database with name: transit-demo`.
   Compter ~10–20 s (compilation + publication). Pendant ce temps, **les bus continuent de rouler** sur tous
   les écrans ; les abonnements restent ouverts, les identités et données sont conservées.

4. PCC : « ⚡ Injecter un incident » → il passe à la gravité supérieure au bout de **10 s** (et non plus 30).

5. Remettre `30` et republier après la démo (ou la laisser à 10 s, au choix).

Ce qui a été vérifié sur la version 2.12 (base de test jetable) :
- Le plan de migration est vide, `publish` sans `--delete-data` réussit, les données sont conservées.
- Un abonnement ouvert pendant la publication continue de recevoir chaque tick sans interruption.
- L'escalade se déclenche exactement 10 s après la création de l'incident.
- Les escalades **déjà planifiées** avant la publication gardent leur échéance d'origine (la ligne
  `IncidentEscalation` contient une date absolue) : le nouveau délai s'applique aux incidents créés ensuite.
  Pour une démonstration nette, injecter un **nouvel** incident après la publication.

Pas de régénération des bindings ni de redémarrage d'Angular : l'interface publique du module n'a pas changé.

### Variante avancée : nouveau type d'incident « Vandalisme »

Aussi vérifiée compatible : ajouter une variante **à la fin** de l'enum (`Lib.cs:13`)
`{ Breakdown, Accident, Assault, PassengerIllness, Delay, Vandalism }` → le plan de migration affiche
« Changed columns for table incident » et la publication réussit **sans perte de données**.
Mais elle demande davantage de travail en direct : libellé serveur (`KindLabel`, `Reducers.cs:24-31`),
`spacetime generate`, puis libellé client (`demo-app/src/app/core/labels.ts:23-38` — le `Record` typé fait
échouer la compilation tant que le libellé manque, ce qui est un bon argument « typage de bout en bout »).
À réserver à une démo de plus de 30 min. Ne jamais insérer une variante au milieu ni en supprimer une.

---

## 6. Commandes utiles pendant la démo

Toutes vérifiées sur le serveur local (2.12). Noms de tables/colonnes en `snake_case`.
`ORDER BY` / `LIMIT` ne sont **pas** supportés par `spacetime sql` (erreur `Unsupported`).

```bash
# État de la simulation (le tick_count avance d'1 par seconde)
spacetime sql --no-config transit-demo --server local "SELECT * FROM sim_config"

# Positions live et retards
spacetime sql --no-config transit-demo --server local "SELECT vehicle_id, lat, lon, status, delay_seconds FROM vehicle_position"

# Qui conduit quoi / qui est en ligne
spacetime sql --no-config transit-demo --server local "SELECT * FROM driver_assignment"
spacetime sql --no-config transit-demo --server local "SELECT * FROM online_presence"
spacetime sql --no-config transit-demo --server local "SELECT name, role FROM app_user"

# Incidents et escalades planifiées
spacetime sql --no-config transit-demo --server local "SELECT id, kind, severity, status, vehicle_id, escalations FROM incident"
spacetime sql --no-config transit-demo --server local "SELECT * FROM incident_escalation"
spacetime sql --no-config transit-demo --server local "SELECT * FROM sim_tick"

# Temps d'attente calculés pour la borne « Fribourg, Gare »
spacetime sql --no-config transit-demo --server local "SELECT * FROM stop_eta WHERE stop_id = 5"

# Tables privées (lisibles par le CLI car propriétaire de la base)
spacetime sql --no-config transit-demo --server local "SELECT at, actor_name, action, details FROM audit_log"
spacetime sql --no-config transit-demo --server local "SELECT * FROM demo_setting"
spacetime sql --no-config transit-demo --server local "SELECT COUNT(*) AS n FROM audit_log"

# ... mais pas par une identité anonyme
spacetime sql --no-config transit-demo --server local --anonymous "SELECT * FROM audit_log"

# Abonnement temps réel en ligne de commande
spacetime subscribe --no-config transit-demo --server local --anonymous "SELECT * FROM vehicle_position WHERE vehicle_id = 101" -n 3 -t 15

# Logs du module (les refus d'autorisation y apparaissent en ERROR)
spacetime logs --no-config transit-demo --server local -n 20
spacetime logs --no-config transit-demo --server local -f

# Schéma : réducteurs, tables, vues
spacetime describe --no-config transit-demo --server local reducers
spacetime describe --no-config transit-demo --server local tables

# Appels de réducteurs (l'identité du CLI devient superviseur après register_user)
spacetime call --no-config transit-demo --server local --anonymous inject_random_incident          # refusé : pas de rôle
spacetime call --no-config transit-demo --server local register_user '"Marie"' '{"supervisor":[]}' '"PCC2026"'
spacetime call --no-config transit-demo --server local inject_random_incident                      # accepté une fois superviseur
spacetime call --no-config transit-demo --server local set_sim_speed 5
```

Dans les arguments JSON du CLI, les variantes d'enum sont en camelCase (`{"supervisor":[]}`, `{"breakdown":[]}`).

---

## 7. Architecture classique vs SpacetimeDB

| Besoin | Architecture classique | TransVille sur SpacetimeDB |
|---|---|---|
| Stockage | PostgreSQL / SQL Server | Tables du module (`Lib.cs`), en mémoire + journal persistant |
| Logique métier & API | Backend .NET/Java + API REST (contrôleurs, DTO, validation) | Réducteurs C# (`Reducers.cs`), appelés directement par le client |
| Temps réel | SignalR / WebSocket + bus de messages (Redis pub/sub…) | Abonnements SQL : le serveur pousse les lignes modifiées |
| Cache | Redis / cache applicatif + invalidation | Cache client maintenu par le SDK, toujours cohérent |
| Tâches planifiées | Hangfire / Quartz / cron / worker | Tables planifiées (`SimTick`, `IncidentEscalation`) |
| Autorisation | Middleware + attributs + règles dupliquées front/back | `ctx.Sender` + rôles en base, vérifiés dans chaque réducteur |
| Confidentialité des données | Filtrage dans chaque endpoint, risque de fuite | Tables privées + vues par utilisateur : les lignes ne quittent pas le serveur |
| Cohérence | Transactions DB + outbox pour les notifications | Tout (données, audit, alerte, planification) dans une seule transaction |
| Présence en ligne | Hub SignalR + stockage de connexions | Hooks `ClientConnected` / `ClientDisconnected` |
| Contrat client/serveur | OpenAPI + génération de client + maintien de la synchro | `spacetime generate` : bindings TypeScript typés |
| Déploiement | Build, conteneurs, rolling update, migrations séparées | `spacetime publish` : hot-swap + migration automatique |
| Briques à opérer | 5 à 7 | 1 |

---

## 8. Questions-réponses anticipées

**Sécurité / authentification — on utilise Keycloak (ou Azure AD).**
SpacetimeDB accepte des jetons JWT émis par n'importe quel fournisseur OIDC (Keycloak, Auth0, Clerk, Google,
SpacetimeAuth intégré…). L'identité (`ctx.Sender`) est dérivée de l'émetteur et du sujet du jeton ; le
client passe le jeton via `withToken(...)`. Dans un réducteur, les claims sont accessibles via
`ctx.SenderAuth.Jwt` (`Issuer`, `Subject`, `Audience`, `RawPayload`) : on y lirait les rôles Keycloak
plutôt que notre code de démo `PCC2026`. Dans la démo, les identités sont anonymes et le jeton est en
`sessionStorage` uniquement pour simuler plusieurs appareils dans un même navigateur.

**Souveraineté des données / hébergement en Suisse.**
Le serveur (`spacetime start`) s'auto-héberge : on-premise, cloud suisse, réseau isolé. Maincloud (le cloud
de l'éditeur) est une option, pas une obligation — cette démo tourne entièrement en local. Vérifier les
conditions de licence de l'édition auto-hébergée pour un usage commercial en production.

**Intégration avec le SI existant (ERP, SAE/AVL, systèmes de billettique, GTFS-RT…).**
- Sortant : les **procédures** (API encore marquée instable) peuvent faire des appels HTTP (`ctx.Http`) puis
  écrire en base via `ctx.WithTx`.
- Entrant : **handlers HTTP** déclarés dans le module (webhooks, flux AVL, exposition d'un GTFS-RT).
- Toute application peut aussi être un client SpacetimeDB (SDK C#, TypeScript, Rust, Unity, Unreal) :
  un connecteur .NET existant peut s'abonner et appeler des réducteurs.
- `spacetime sql` / API HTTP pour les extractions ponctuelles.

**Montée en charge.**
Les données vivent en mémoire avec un journal de commit sur disque ; les réducteurs s'exécutent sans aller-retour
réseau vers la base, ce qui donne des latences très faibles. Le modèle est d'abord vertical (une base = un
nœud) : on dimensionne la machine et on découpe par domaine (une base par réseau / par client / par
région). Pour un PCC, quelques milliers de véhicules et quelques centaines d'écrans restent un volume modeste.
Bonne pratique visible dans la démo : séparer les données « chaudes » (`VehiclePosition`) des métadonnées.

**Reporting / BI / historique.**
SpacetimeDB est une base **opérationnelle** temps réel, pas un entrepôt analytique. Pour la BI, on exporte vers
un entrepôt (PostgreSQL, Snowflake, data lake) via un client abonné ou des procédures. La démo applique
d'ailleurs des règles de rétention (500 lignes d'audit, 200 messages, 30 incidents résolus) pour garder
l'état opérationnel petit. Un `spacetime sql` suffit pour les requêtes simples, mais pas d'`ORDER BY`/`LIMIT`
ni de SQL analytique complet.

**Déterminisme : pourquoi pas `DateTime.Now` ou `Random` ?**
Les réducteurs doivent être déterministes : l'heure vient de `ctx.Timestamp`, l'aléa de `ctx.Rng`. C'est ce qui
rend l'exécution reproductible et l'audit fiable (horodatage serveur, pas client).

**Tests.**
La logique est du C# normal : testable en unitaire. La démo inclut un test de bout en bout réel
(`demo-app/scripts/e2e-smoke.mjs`, 30 assertions) qui pilote 3 identités contre la base locale.

**Limites et maturité (à dire honnêtement).**
- Produit jeune (v2.x) : certaines API sont marquées instables (procédures, plusieurs commandes CLI).
- Le module C# se compile en WebAssembly : .NET 8 + workload `wasi-experimental` ; sur macOS, pas de .NET 10.
- Pas d'appels réseau dans un réducteur (il faut passer par une procédure).
- SQL du CLI limité ; pas un remplaçant d'un entrepôt de données.
- Les IDs auto-incrémentés ne sont pas séquentiels : on trie par horodatage.
- Écosystème et compétences sur le marché encore restreints ; modèle de scalabilité à valider sur un vrai
  volume avant un engagement de production.
- Migrations automatiques limitées aux changements compatibles (ajouts) ; un changement cassant demande une
  stratégie de migration explicite.

**Et si le serveur redémarre ?**
Les données sont persistées (journal de commit). Les clients se reconnectent automatiquement
(`withAutomaticReconnect`, `demo-app/src/app/core/spacetime.service.ts:200-237`) avec la même identité.

---

## 9. Dépannage

| Symptôme | Cause probable | Solution |
|---|---|---|
| Écran « Serveur injoignable » | `spacetime start` non lancé | Lancer `spacetime start`, puis `spacetime server ping local`, cliquer « Réessayer » |
| `failed to find database demo-app-rwnqq` | `spacetime.local.json` est lu | Ajouter `--no-config` aux commandes `sql`/`call`/`logs`/`subscribe`/`describe` |
| `publish` cible maincloud / demande un login | `--server local` oublié (`spacetime.json` vise maincloud) | Toujours `--server local`. Ne jamais publier sur maincloud |
| Build : erreur NativeAOT / SDK introuvable | Mauvais `dotnet` dans le `PATH` (.NET 10) | `export DOTNET_ROOT=$HOME/.dotnet PATH=$HOME/.dotnet:$PATH`, vérifier `dotnet --list-sdks` |
| Build : workload manquant | `wasi-experimental` absent | `dotnet workload install wasi-experimental` (avec le .NET 8 en tête du PATH) |
| « Could not find wasm-opt » | Outil d'optimisation absent | Sans conséquence, ignorer |
| `publish` refusé pour changement de schéma cassant | Migration non automatique | `spacetime publish transit-demo --server local -p ./spacetimedb --delete-data=always --yes` (efface tout) |
| Erreurs TypeScript après modification du module | Bindings périmés | `spacetime generate --lang typescript --out-dir ./demo-app/src/module_bindings -p ./spacetimedb --yes` |
| Deux onglets ont la même identité | Onglet dupliqué (copie du `sessionStorage`) | Ouvrir un nouvel onglet via l'URL, ou utiliser « changez d'identité » sur l'écran de connexion |
| Bus « pris » par un chauffeur dont l'onglet est fermé | Identité perdue avec le `sessionStorage` | PCC : libérer le véhicule (`ForceReleaseVehicle`), ou « Réinitialiser » (libère les chauffeurs hors ligne) |
| Jeton refusé après `spacetime server clear` / nouvelle base | Jeton d'une autre instance | L'app crée une nouvelle identité automatiquement ; sinon fermer l'onglet et en rouvrir un |
| Les bus ne bougent plus | Simulation en pause | Bouton « ▶ Reprendre » du PCC ; vérifier `SELECT * FROM sim_config` (`paused`) et `SELECT * FROM sim_tick` |
| `Unsupported: SELECT ... ORDER BY ...` | SQL CLI limité | Retirer `ORDER BY` / `LIMIT` |
| Port 3000 ou 4200 occupé | Autre processus | `lsof -iTCP:3000 -sTCP:LISTEN`, arrêter le processus ; ou `npm start -- --port 4300` |
| Comprendre un refus | — | `spacetime logs --no-config transit-demo --server local -n 50` : chaque refus y est loggé en `ERROR` avec son message |

Remise à zéro complète (dernier recours) :

```bash
export DOTNET_ROOT=$HOME/.dotnet PATH=$HOME/.dotnet:$PATH
cd ~/dev/demo-spacetimedb
spacetime publish transit-demo --server local -p ./spacetimedb --delete-data=always --yes
spacetime generate --lang typescript --out-dir ./demo-app/src/module_bindings -p ./spacetimedb --yes
```

Puis fermer tous les onglets de l'application et les rouvrir (nouvelles identités).
