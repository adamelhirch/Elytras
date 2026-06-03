# Elytras — Guide d'installation & de déploiement local

Pour installer Elytras **sur la machine d'un client** et lui permettre de piloter son entreprise par
des agents IA. Tout reste **en local** : aucune donnée ne sort de la machine, tous les secrets sont chiffrés.

---

## 1. Prérequis

- **Python 3.10 ou plus** (vérifier : `python3 --version`).
- macOS ou Linux.
- Aucune base de données requise (mode fichier par défaut).
- Pour le bac à sable du code Python : `sandbox-exec` (présent sur macOS) ou `bwrap` (Linux :
  `sudo apt install bubblewrap`). Optionnel mais **recommandé en production**.

---

## 2. Installation rapide (sans Docker — recommandé)

### macOS
1. Copier le dossier `phase-0/` sur la machine.
2. **Double‑cliquer `start-local.command`** (ou en terminal : `./start-local.command`).
3. Au 1er lancement : création de l'environnement + installation (~1 min). L'interface s'ouvre sur
   **http://localhost:8000**.
4. Créer le **compte administrateur initial** à l'écran d'accueil.

### Linux (ou macOS en terminal)
```bash
cd phase-0
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
SKILLS_DIR="$PWD/skills" python -m uvicorn elytras.main:app --host 127.0.0.1 --port 8000
```
Puis ouvrir **http://localhost:8000**.

> Le serveur **n'écoute qu'en local** (`127.0.0.1`). Au 1er lancement, une **clé de chiffrement forte
> est générée et persistée** (`.elytras-key`, chmod 600) : rien à configurer.

---

## 3. Installation avec Docker (optionnel)

Fournit le cœur **+ Postgres/pgvector** (mémoire vectorielle) + adminer + connecteur MCP d'exemple.
```bash
cd phase-0
cp .env.example .env        # laisser APP_ENCRYPTION_KEY vide (auto‑généré) ou en fixer une forte
docker compose up --build
```
Interface : **http://localhost:8000**. Tous les ports sont publiés en `127.0.0.1` (non exposés au réseau).

---

## 4. Premiers pas

1. **Admin initial** : créer le compte (écran de setup).
2. **Contexte entreprise** : remplir la mémoire système d'entreprise (Admin → Contexte) — injectée aux
   agents, en lecture seule depuis les chats.
3. **Équipes & rôles** : créer les équipes (ex. Communication, Informatique) et ajuster les rôles
   capacité par capacité. Créer les comptes utilisateurs et les rattacher.
4. **Providers LLM** : connecter un provider (carte Providers → « Se connecter »).
5. **Connecteurs (MCP)** : enregistrer les connecteurs métier, définir leur accès (équipes) et le type
   de connexion (partagée ou personnelle).
6. **Telegram** (option) : renseigner le token du bot par agent, et l'identifiant Telegram sur chaque profil.
7. **Flows** : créer/générer des automatisations, les planifier (cron) ou les exposer en webhook.

---

## 5. Configuration (variables d'environnement)

| Variable | Rôle | Défaut |
|---|---|---|
| `APP_ENCRYPTION_KEY` | Clé de chiffrement des secrets | *(vide → générée et persistée)* |
| `ELYTRAS_KEY_FILE` | Emplacement de la clé persistée | `.elytras-key` (à côté de l'état) |
| `ELYTRAS_STATE_FILE` | Fichier d'état (mode fichier) | `.elytras-state.json` |
| `ELYTRAS_CODE_SANDBOX` | Bac à sable du code : `auto` / `on` / `off` | `auto` |
| `SKILLS_DIR` | Dossier des skills | `skills` |
| `PUBLIC_BASE_URL` | URL publique (redirect OAuth MCP) | `http://localhost:8000` |
| `DATABASE_URL` | Postgres (mémoire vectorielle) — **optionnel** | *(absent → mode fichier)* |
| `ELYTRAS_DEV` | `1` active le rechargement à chaud | *(désactivé)* |

---

## 6. Check‑list de sécurité (avant mise en service client)

- [ ] Lancer **`./start-local.command`** ou un démarrage en `--host 127.0.0.1` (jamais `0.0.0.0`).
- [ ] **Bac à sable** disponible (`sandbox-exec`/`bwrap`) ; en production, fixer `ELYTRAS_CODE_SANDBOX=on`.
- [ ] **`APP_ENCRYPTION_KEY`** : laisser l'auto‑génération, ou fixer une clé forte ; **sauvegarder `.elytras-key`**.
- [ ] Vérifier que `.elytras-state.json`, `.elytras-key`, `.env` ne sont **pas** versionnés (`.gitignore` fourni).
- [ ] Définir les **rôles au plus juste** (moindre privilège) ; vérifier qu'un Lecteur ne peut ni créer
      de flow, ni utiliser un connecteur réservé, **y compris via le chat**.
- [ ] Régler l'**autonomie** des agents (ASK pour les actions sensibles).
- [ ] Restreindre l'accès **par connecteur et par skill** aux bonnes équipes.

---

## 7. Tests

```bash
cd phase-0
pip install -r requirements-dev.txt
PYTHONPATH=. python -m pytest        # 35 tests attendus au vert
```

---

## 8. Sauvegarde & exploitation

- **À sauvegarder** : `phase-0/.elytras-state.json` (données) **et** `phase-0/.elytras-key` (clé).
  Sans la clé, les secrets chiffrés sont irrécupérables.
- **Démarrage/arrêt** : fermer la fenêtre du lanceur arrête proprement le serveur (et le MCP d'exemple).
- **Mise à jour** : remplacer le code, conserver `.elytras-state.json` et `.elytras-key`, relancer.

---

## 9. Dépannage

| Symptôme | Cause probable | Solution |
|---|---|---|
| « Python 3 introuvable » | Python non installé | Installer Python 3.10+ |
| Port 8000 occupé | Instance déjà lancée | Le lanceur libère le port ; sinon tuer le process sur 8000 |
| Code de flow refusé (`code.execute`) | Rôle sans la capacité | Ajouter `code.execute` au rôle, ou retirer l'étape code |
| « bac à sable exigé » | `ELYTRAS_CODE_SANDBOX=on` sans outil | Installer `bwrap` (Linux) ou repasser en `auto` |
| Secrets illisibles après copie | `.elytras-key` non copiée | Restaurer la clé d'origine à côté de l'état |
