# Elytras — Flows façon Windmill + agents en « sandbox » à policies

> Note d'architecture suite à la vision de Léo : intégrer la richesse des flows Windmill
> tout en gardant nos **agents** qui travaillent dans des « sandbox » (uniques par user /
> partagées par projet), personnalisées par entreprise puis par équipe, avec des **droits
> accordés par un admin** (mémoire, commandes, outils) — un **système de policies**.
> Inspection faite du standard **OpenFlow** (le cœur open-source des flows Windmill).

---

## 1. Ce qu'est Windmill, et la bonne façon de « l'intégrer »

Windmill = un moteur de flows **Rust + Postgres + workers distribués + UI Svelte**, et un
**standard ouvert : OpenFlow** (le format JSON des flows). Son moteur est conçu pour le scale
(workers, files de jobs) ; ce n'est pas une lib qu'on « importe » dans une app Python.

**Trois options d'intégration :**

| Option | Description | Verdict |
|---|---|---|
| A. **Embarquer Windmill** | Faire tourner le binaire Windmill (Rust+PG+workers) à côté et l'appeler | ❌ Lourd, casse le local-first/léger, et **Windmill n'a pas notre modèle d'agents/sandbox/policies** — on perdrait notre valeur |
| B. **Aligner Elytras sur OpenFlow** + approfondir la parité | Garder notre moteur Python (déjà calqué sur OpenFlow), rendre le format **OpenFlow-compatible** (import/export, accès au Hub Windmill), combler les écarts | ✅ **Recommandé** |
| C. Ignorer | — | ❌ |

**Pourquoi B** : notre `flows.py` EST déjà « OpenFlow simplifié » (mêmes modules, mêmes options).
On capte la richesse de Windmill **sans** son poids, et on garde notre différenciateur : Elytras
est **agent-natif** (Windmill, lui, bolt-on des « AI agents » par-dessus). En prime, être
OpenFlow-compatible permettrait d'**importer des flows du Hub Windmill**.

---

## 2. Parité flows : Elytras vs OpenFlow

| Capacité OpenFlow | Elytras | État |
|---|---|---|
| Modules en graphe (séquence + conteneurs) | oui | ✅ |
| `rawscript` multi-langage | Python / **JavaScript / TypeScript** | ✅ (Go/Bash/SQL = option) |
| `forloop` (+ parallèle) | oui | ✅ |
| `branchone` / `branchall` | oui | ✅ |
| `whileloop` | oui | ✅ |
| `stop_after_if` (early stop) | oui | ✅ |
| `suspend` / approbation | oui (module approval) | ✅ |
| `sleep` | oui | ✅ |
| `retry` (constant/expo) | oui | ✅ |
| `mock` / pin result | oui | ✅ |
| cache | oui (cache_ttl) | ✅ |
| schéma d'entrées (JSON Schema) | oui | ✅ |
| Triggers : manuel / webhook / cron | oui | ✅ |
| **Étape agent IA** | oui (natif, type `agent`) | ✅ **+ que Windmill** |
| `input_transforms` (piping par champ + prop-picker) | templating `{{ }}` / expr | 🟡 à structurer |
| `failure_module` (gestionnaire d'erreur du flow) | continue_on_error par module | 🟡 à ajouter (niveau flow) |
| Import/export **OpenFlow** (Hub) | non | 🟡 à ajouter |

→ **L'essentiel y est.** Restent surtout : `input_transforms` structurés, un `failure_module`
de flow, et l'**alignement de format OpenFlow** (sérialisation `value:{type,…}` + import/export).

---

## 3. Le vrai cœur : « sandbox d'agents » + policies (notre différenciateur)

Bonne nouvelle : **~80 % de ta vision existe déjà** dans Elytras, mais éparpillé. Il faut surtout
le **formaliser en une couche unique « policy »**.

| Élément de ta vision | Déjà dans Elytras | À faire |
|---|---|---|
| Sandbox **unique par user** / **partagée par projet** | scopes mémoire + sessions (perso / projet) | — |
| Personnalisée **par entreprise** | contexte entreprise (.md) + 1 instance/entreprise | — |
| Par **équipe / type d'employé** | équipes + rôles configurables | — |
| **Admin accorde des droits aux agents** | capacités RBAC + **périmètre d'outils par agent** + accès MCP/skill par équipe | unifier en « policy » |
| Mémoire **org / équipe / projet / user** | user & projet | ➕ **org & équipe** |
| **Commandes** autorisées (MCP/skills/code/web/flows) | outils gatés par rôle **et** par agent | unifier |
| **Système de policies** | implicite (caps + tools + access) | ➕ **abstraction explicite** |
| Outils **MCP + skills** pour agir | oui (scopés) | — |

### Couche « Policy » proposée (unification)

Une **policy** = à un **(rôle d'équipe)** on associe, pour les agents qu'il pilote :

```
policy = {
  memory_scopes : [org | equipe | projet | user]   # ce que l'agent peut lire/écrire
  agents        : [ids d'agents utilisables]
  tools         : { mcp:[…], skills:[…], code:bool, web:bool, flows:bool, dispatch:bool }
  autonomy      : ask | auto                        # validation des actions sensibles
}
```

C'est la **fusion** de briques déjà là (`rbac.caps`, `agent.tools`, accès MCP/skill par équipe,
scopes mémoire, autonomie ASK/AUTO) sous **un seul écran admin** « Policies ». Un admin compose :
« l'équipe Compta a des agents qui lisent la mémoire projet+équipe, peuvent utiliser Odoo et le
skill Facture, exécuter du code, mais pas naviguer le web, en mode validation ».

### Mémoire multi-niveaux (à compléter)

Aujourd'hui : **user** (privé) et **projet** (partagé entre membres). À ajouter pour coller à la
vision : **équipe** et **organisation** (faits partagés à toute l'équipe / toute l'entreprise),
en gardant l'isolement (un agent mandaté par X ne lit jamais le privé de Y). Choix du/des scope(s)
**par étape agent** (le champ `memory` existe déjà : flow/perso/projet/none → étendre à equipe/org).

---

## 4. Feuille de route proposée (incrémentale, testée à chaque étape)

1. **Couche Policy unifiée** (écran admin + moteur) : centralise caps + outils par agent + accès
   MCP/skill + autonomie. *(le plus structurant, faible risque — tout existe, on relie)*
2. **Mémoire équipe + organisation** : nouveaux scopes + sélection par étape agent + RBAC dessus.
3. **OpenFlow compat** : import/export du JSON OpenFlow (interop + Hub Windmill).
4. **`input_transforms` structurés** + **prop-picker** (piper proprement sortie d'étape → entrée).
5. **`failure_module`** de flow (gestionnaire d'erreur global, façon try/catch).
6. (Option) langages de code en plus (Bash/SQL), triggers en plus (email, etc.).
7. **Durcissement sandbox** pour code non-confiance à l'échelle (gVisor/microVM) — déjà tracé.

---

## 5. Décision à acter

L'orientation **B (aligner sur OpenFlow, garder notre moteur agent-natif)** est ma recommandation
ferme : on capte la richesse Windmill sans son poids, et on bâtit par-dessus notre vraie valeur —
les **sandbox d'agents à policies** (inspirées Hermes / OpenClaw), que Windmill n'a pas. Reste à
choisir par quoi on démarre la mise en œuvre (voir question associée).
