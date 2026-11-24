# OpenClaw Control Tower UI

Dashboard custom compagnon du Control UI natif OpenClaw.

Objectif:

- garder le `Control UI` natif d'OpenClaw comme surface operateur principale
- ajouter une couche de dashboard custom au-dessus
- ne pas reimplementer le gateway natif tant que le protocole WS n'est pas branche

## Positionnement

Cette app n'essaie plus de parler a l'ancienne API HTTP MicroClaw.

Elle sert maintenant a:

- ouvrir proprement le `Control UI` natif OpenClaw
- exposer les URLs et tokens utiles
- documenter le modele agent-centric cible
- servir de base au futur dashboard custom (agents, fichiers, memoire, pipelines, teams)

## Lancer le stack

Depuis la racine du repo:

```sh
pnpm install
./start.sh
pnpm --dir control-tower-ui install
pnpm --dir control-tower-ui dev
```

## URLs utiles

- dashboard custom: `http://127.0.0.1:5174`
- Control UI natif proxifie via Vite: `http://127.0.0.1:5174/openclaw/`
- Control UI natif direct: `http://127.0.0.1:18789/openclaw/`

Le token peut etre bootstrappe dans le fragment:

```txt
http://127.0.0.1:18789/openclaw/#token=openclaw-local-token
```

## Variables d'environnement

```sh
VITE_OPENCLAW_BASE_URL=http://127.0.0.1:18789
VITE_OPENCLAW_GATEWAY_TOKEN=openclaw-local-token
OPENCLAW_CLI_BIN=openclaw
```

`OPENCLAW_CLI_BIN` permet de faire tourner cette couche au-dessus d'un CLI OpenClaw standard, sans dépendre de `openclaw.mjs`. Le fallback local existe seulement pour le mode repo-source.

## Principe d'isolation

`control-tower-ui` doit rester une surcouche:

- UI, orchestration locale, scripts, runtime `cliproxyapi`
- appels via le gateway OpenClaw et le CLI OpenClaw
- pas d'import de modules `src/**` du coeur OpenClaw
- pas de patch requis dans OpenClaw pour faire vivre le dashboard

## Ce qui vient ensuite

- adaptateur WebSocket OpenClaw pour le dashboard custom
- vues agents / workspaces / files / memory
- pipelines, teams, RBAC
- federation providers autour d'OpenClaw via CLIProxyAPI et autres gateways
