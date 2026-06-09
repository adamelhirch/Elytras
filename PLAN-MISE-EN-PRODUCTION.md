# Elytras — Plan de mise en production

> De « ça tourne en local » à « je peux le vendre à une PME ».
> Modèle visé : **SaaS plug‑and‑play, opéré par toi sur serveurs Linux**, pour des **petites entreprises de terrain**
> (garage, boutique, électricien…) sans fonctions support. **Tu gères l'IA en resell** (tu détiens les clés,
> le client paie l'usage) et tu vends des **modules/options à la carte**.
> Document de cadrage — révisé le 3 juin 2026.

---

## 0. Résumé exécutif

Le moteur Elytras est prêt et testé. Avant un premier client payant, il faut bâtir la **couche d'exploitation** : une **passerelle IA centrale** (ton centre de profit, branchée au démarrage sur un **agrégateur type OpenRouter** = une facture, tous les modèles), un **déploiement Linux reproductible** (Docker + TLS + sauvegardes), et un **canal mobile** (WhatsApp vocal). Le produit se vend comme une **voiture** : un tronc commun + des **options** (modules métier, hébergement, app vocale, config). Le revenu récurrent vient de l'**hébergement managé** (qui inclut le logiciel) et de la **marge sur l'IA** ; le revenu ponctuel vient de l'**installation et de la configuration**. Premier terrain : **Vanille Désire** (dogfooding).

---

## 1. Cible & proposition de valeur

**Cible** : TPE/petites PME de terrain — garage 2–5 employés, boutique de chaussures, électricien, artisan — qui n'ont **personne** pour les mails, les devis, les factures, les RDV, les relances. Le dirigeant fait tout, mal et tard.

**Proposition** : un système **plug‑and‑play** pour gérer son entreprise sans y penser. Des agents IA, branchés à leurs outils (via MCP), traitent les tâches chiantes ; le dirigeant donne des ordres **à la voix depuis son téléphone** (« fais un devis pour M. Dupont, 3 h de main‑d'œuvre »). On les **libère de l'administratif**.

**Angle** : tu ne vends pas « de l'IA », tu vends *du temps récupéré* et la *tranquillité*. « Tes devis, tes factures, tes mails : c'est géré. »

---

## 2. Modèle économique (tarification modulaire, « comme une voiture »)

Pas d'abonnement logiciel abstrait. On facture des **briques concrètes**. Le récurrent est porté par l'**hébergement managé** (qui inclut le logiciel + MAJ + support) et la **marge IA**.

### Briques récurrentes

- **Hébergement managé** — « Elytras géré pour toi » : logiciel + mises à jour + support + sauvegardes **inclus**. Trois niveaux :
  - **Mutualisé** (plusieurs clients par serveur) — le moins cher.
  - **Dédié** (une machine réservée) — plus isolé/costaud, +€/mois.
  - **Sur site** (un boîtier chez le client) — tout reste dans ses murs, + matériel + installation.
- **IA en crédits** (à l'usage) — prépayé, consommé selon la **gamme choisie par le client**, ta marge sur le coût réel, **plafond mensuel réglable**.
- **Hébergement des modules** (ex. instance Odoo gérée) — récurrent si c'est nous qui hébergeons.

### Briques ponctuelles (one‑shot)

- **Onboarding / configuration intégrale** — installation, connexion des outils, réglage des rôles, premiers workflows, formation.
- **Mise en place d'un module** — installation **+ configuration** (produits, contacts, procédés…) = prestation facturée au cas par cas.
- **Matériel** (si sur site).

### Cas auto‑hébergé

Si le client héberge chez lui *et* consomme peu d'IA, ton récurrent est quasi nul. Parade : **pousser l'hébergement managé par défaut**, et pour les rares auto‑hébergés, un **petit forfait maintenance/MAJ**. *(Décision à acter — section 12.)*

### Les gammes d'IA (pour ne pas noyer le client dans la technique)

On n'affiche pas un nom de modèle mais **trois gammes**, choisissables par agent. Coûts réels (juin 2026, par M tokens in/out) :

| Gamme | Pour quoi | Modèle | Coût réel /M tokens (in/out) |
|---|---|---|---|
| **Éco** | Mails, factures, devis, RDV | DeepSeek V3.2 ou Gemini Flash‑Lite | ~0,10–0,14 $ / 0,28–0,40 $ |
| **Standard** | Rédaction, analyse | GPT‑5 mini ou Gemini Flash | ~0,25 $ / 2,00 $ |
| **Max** | Tâches complexes, raisonnement | Claude Haiku 4.5 (ou Sonnet) | 1,00 $ / 5,00 $ |

**Backend = un agrégateur (OpenRouter) au démarrage** : une seule facture, accès à tous ces modèles, bascule instantanée, fallback automatique. Sa marge = **~5,5 % à la recharge de crédits** (pas de surcoût au token) — négligeable au début face à la simplicité.

**Ordre de grandeur** : en **Éco** (DeepSeek/Flash‑Lite), une tâche d'agent coûte une fraction de centime ; une petite entreprise (mails + devis + factures) → **1–4 $/mois** de tokens. **Le vrai levier de marge, c'est le choix du modèle, pas l'agrégateur** : l'Éco est ~15× moins cher que le Max sur la sortie, et suffit pour l'administratif courant. ⚠️ Un agent qui boucle consomme vite → **plafond + observabilité** (déjà intégrés) indispensables.

---

## 3. Cadre légal du resell (à lire attentivement)

D'après les CGU OpenAI (similaire chez Anthropic), juin 2026 :

- ✅ Tu **possèdes les sorties** de l'API et peux les exploiter dans une **application** facturée à tes clients.
- ✅ Tu peux **intégrer l'API dans Elytras** et le proposer à des utilisateurs finaux.
- ⛔ Tu ne peux **pas revendre l'accès API brut**, ni acheter/vendre/transférer des **clés**, ni louer l'accès à un compte.

**Conséquence (déterminante)** : la clé (provider ou agrégateur) **reste chez toi**, dans la passerelle centrale ; le client ne voit jamais l'API brute. Il consomme **Elytras**, et tu factures **cet usage**. Conforme. *Je ne suis pas juriste : fais valider CGU + chaîne RGPD par un avocat.*

---

## 4. Architecture cible de production

```
   Vanille Désire            Garage Martin            Boutique X        …
   ┌────────────┐            ┌────────────┐           ┌────────────┐
   │ Instance   │            │ Instance   │           │ Instance   │   ← 1 entreprise = 1 instance isolée
   │ Elytras    │            │ Elytras    │           │ Elytras    │
   └─────┬──────┘            └─────┬──────┘           └─────┬──────┘
         │  HTTPS (sous-domaine dédié)                      │
    ┌────┴───────────── Reverse proxy TLS (Caddy) ──────────┴────┐
    │                ┌──────────────────────────────┐            │
    └──────────────▶ │   PASSERELLE IA CENTRALE      │ ◀──────────┘
                     │   (opérée par toi)            │
                     │  metering • quotas • plafond  │
                     │  facturation • garde la clé   │
                     └───────────────┬───────────────┘
                                     │
                        ┌────────────┴───────────┐
                        │  OpenRouter (agrégateur)│  ← une facture, 300+ modèles, fallback
                        └────────────┬───────────┘
                       DeepSeek │ Gemini │ OpenAI │ Anthropic …

   Canaux d'entrée : Web · WhatsApp vocal · Telegram (interne/démarrage)
   Chaque instance se branche aux MCP des outils du client (Odoo, Gmail, caisse…).
```

**Isolation** : **1 entreprise = 1 instance** (conteneur Docker isolé, état + clé propres). Multi‑tenant « physique », simple et sûr ; plusieurs petites entreprises peuvent cohabiter sur un même VPS (mutualisé) pour réduire les coûts.

---

## 5. La passerelle IA centrale (ton centre de profit) — composant n°1 à construire

C'est la **priorité absolue**. Rôle :

- **Détenir la clé** (de l'agrégateur ou des providers), chiffrée, jamais exposée aux instances.
- **Exposer une API** (compatible OpenAI) appelée par les instances avec une **clé de service Elytras** par client (révocable).
- **Router** vers la gamme choisie (Éco/Standard/Max).
- **Compter les tokens par client**, appliquer **quotas + plafond mensuel**, **journaliser** pour la facture.

**Backend = OpenRouter au démarrage** (une facture, tous les modèles, fallback). Important : OpenRouter **ne remplace pas** la passerelle — il se met *derrière*. La passerelle reste indispensable pour le metering **par client**, les plafonds, la facturation et la conformité resell. À gros volume, on pourra **basculer en direct** (DeepSeek/Google/OpenAI) sur les modèles les plus consommés, sans rien changer côté client. Elytras a déjà `providers.py` (passerelle abstraite) → ajouter un provider « elytras‑gateway ».

---

## 6. Canaux & application mobile

- **Web** — l'interface complète (admin, workflows, observabilité).
- **WhatsApp Business vocal** *(canal terrain prioritaire)* — le dirigeant envoie un **vocal**, Whisper le transcrit, l'agent exécute (devis, RDV, réponse mail) et répond. Implique : **WhatsApp Business Platform**, **numéro vérifié Meta**, **facturation Meta par conversation**, passage par un fournisseur (Twilio / 360dialog) pour démarrer vite. Le pipeline de dispatch existe déjà.
- **Telegram** — déjà intégré ; utile pour démarrer/usage interne avant la validation WhatsApp.
- **App mobile native** *(vision)* — meilleure UX « pro » à terme ; chantier dédié, après WhatsApp.

---

## 7. Catalogue de modules (les « options »)

Tronc commun (agents + workflows + connecteurs + IA) + options à la carte :

- **Gestion (ERP) — Odoo** : factures, devis, compta, stock.
- **CRM / contacts** : suivi clients, relances.
- **Agenda / prise de RDV**.
- **Caisse / point de vente** (boutique).
- **Signature de devis en ligne**.
- **WhatsApp vocal** (canal mobile).
- **Hébergement** (mutualisé / dédié / sur site).
- **Configuration intégrale** (prestation : on branche et règle tout).

Chaque module = un connecteur MCP + une mise en place (installation + configuration facturées) + éventuellement un hébergement récurrent.

---

## 8. Déploiement & infrastructure

- **VPS Linux** bon marché (Hetzner/OVH…). **Mutualisé** = plusieurs instances clients (conteneurs isolés) sur une même machine (5–20 €/mois, amorti sur plusieurs clients) ; **dédié** = une machine par client quand il grossit.
- **Image Docker** d'Elytras reproductible (build pinné), `restart=always`.
- **Reverse proxy Caddy** (TLS Let's Encrypt auto), un **sous‑domaine par client**.
- **Par instance** : clé de chiffrement persistée, clé de service vers la passerelle, URL publique.
- **Supervision** : conteneur géré (Docker/systemd), plus de fenêtre Terminal.

---

## 9. Processus d'onboarding (opéré, manuel d'abord — c'est OK et facturé)

1. **Provisionner l'instance** (conteneur + sous‑domaine + TLS + clé passerelle).
2. **Compte admin** + **contexte entreprise** (.md).
3. **Équipes & rôles** + **comptes employés**.
4. **Connecter les outils** : déployer/relier les **MCP** + accès par équipe + scope (partagé/perso).
5. **Modules choisis** : installation + **configuration** (produits, contacts, procédés).
6. **Premiers workflows** à forte valeur (relances factures, tri/réponses mails, devis).
7. **WhatsApp vocal** : numéro + liaison.
8. **Formation** (1 h) + mini‑guide.

---

## 10. Backlog produit avant le 1er client payant

**P0 — bloquant** *(✅ terminé le 9 juin 2026)*
- ✅ Passerelle IA centrale : proxy (→ OpenRouter) + metering + quotas + plafond + base de facturation (`gateway/`).
- ✅ Déploiement Linux : Docker + Caddy TLS + restart auto + supervision (`deploy/install.sh`).
- ✅ Sauvegardes auto (état + clé) chiffrées hors‑site + **restauration testée** (`deploy/backup.sh` / `restore.sh` + `tests/test_backup_restore.py`).
- ✅ Fonctionnement derrière proxy HTTPS : banc e2e TLS (`deploy/smoke/run-https.sh`), `PUBLIC_BASE_URL` câblé par l'onboarding (bug corrigé : OAuth/webhooks pointaient localhost). Reste la **checklist sur vrai serveur** (deploy/README.md) lors du déploiement Vanille Désire.

**P1 — avant de scaler**
- **WhatsApp vocal** (compte Business + Whisper + dispatch).
- Gestion comptes : **reset mot de passe**, invitations, désactivation.
- **1er module métier réel** (probablement Odoo) packagé + configurable.
- Exploitation : logs centralisés, healthcheck, alertes, procédure de MAJ.

**P2 — confort / échelle**
- Onboarding self‑service guidé.
- Facturation automatisée (Stripe) + suivi conso côté client.
- Provisionnement multi‑instances en 1 clic.
- App mobile native.

---

## 11. Sécurité & conformité

- **Déjà en place** (atouts de vente) : secrets chiffrés, RBAC configurable, verrous endpoints + dispatch, bac à sable code, anti‑SSRF, validation humaine (ASK) + audit, isolation par instance.
- **À ajouter** : TLS partout, sauvegardes + rotation de clé, reset mot de passe, supervision.
- **RGPD** (données mails/factures = données personnelles) : tu es **sous‑traitant** du client ; l'agrégateur (OpenRouter) et le provider IA sont **sous‑traitants ultérieurs** → **chaîne de DPA** + activer **zéro rétention (ZDR)** et le **filtrage des providers qui entraînent sur les données** (OpenRouter le permet) + **CGU + politique de confidentialité** (avocat).
- **Responsabilité** : actions externes sensibles en **ASK** par défaut (validation) + **audit** → limite le risque d'erreur (mauvais mail/facture). Le formaliser dans les CGU.

---

## 12. Décisions

**Actées**
- Cible = petites entreprises de terrain ; premier terrain = **Vanille Désire** (dogfooding).
- Tarification **modulaire** (hébergement managé + IA crédits + modules) — **pas d'abonnement fixe**.
- **Choix du modèle laissé au client** (gammes Éco/Standard/Max).
- **Backend modèles = OpenRouter au démarrage** ; **gamme Éco = DeepSeek / Gemini Flash‑Lite**.
- Canal mobile = **WhatsApp Business vocal** (app native plus tard).
- Facturation **Stripe = plus tard** (metering manuel sur les pilotes).

**À acter**
- **Récurrent des auto‑hébergés** : petit forfait maintenance, ou pousser l'hébergement managé uniquement ?
- **Modèle « Max »** : Claude Haiku 4.5 ou Sonnet pour les tâches dures ?
- **VPS mutualisé** au démarrage (plusieurs clients/machine) — confirmé pour réduire les coûts.

---

## 13. Feuille de route lean (sans capital)

- **Mois 1 — socle & dogfooding.** Passerelle IA (→ OpenRouter) + Docker + 1 VPS + Caddy TLS + sauvegardes. **Vanille Désire = 1er utilisateur réel** (débogage en conditions réelles, coût quasi nul).
- **Mois 2 — pilotes & terrain.** WhatsApp vocal + 1er module (Odoo) + 1–3 PME pilotes (tarif réduit). Reset mdp/invitations, durcissement ops. L'onboarding finance le setup.
- **Mois 3 — formaliser l'offre.** Facturation Stripe, page de statut, onboarding semi‑auto, catalogue de modules, 5–10 clients.

**Trésorerie** : VPS 5–20 €/mois/instance + tokens (refacturés avec marge) ; les frais d'onboarding et de configuration couvrent ton temps. Démarrage possible sans capital significatif.

---

## 14. Risques & parades

| Risque | Parade |
|---|---|
| Sortir du cadre resell (accès/clés) | Clé chez toi ; facturer l'usage de l'app, jamais une clé. |
| RGPD / données qui sortent | DPA en chaîne + ZDR + filtrage providers (OpenRouter) + CGU (avocat). |
| Conso agent qui dérape | Plafond mensuel + observabilité + alertes. |
| Gamme Éco décevante | Router les tâches dures vers « Max », facturé plus cher. |
| Dépendance OpenRouter (pas de SLA, +50–100 ms) | Passerelle abstrait le backend → bascule directe (DeepSeek/Google/OpenAI) possible. |
| WhatsApp : validation Meta + coûts | Démarrer via un fournisseur (Twilio/360dialog) ; Telegram en repli/interne. |
| Support qui ne scale pas (1 personne) | Automatiser onboarding + monitoring tôt ; mini‑guide client. |

---

### Sources (prix, agrégateur & CGU, consultés le 3 juin 2026)

- DeepSeek V3.2 (~$0.14 / $0.28) & comparatifs — tldl.io, cloudzero.com, benchlm.ai
- Gemini Flash‑Lite (~$0.10 / $0.40), Gemini 2.5 Flash — ai.google.dev, pricepertoken.com
- GPT‑5 mini ($0.25 / $2.00), Claude Haiku 4.5 ($1 / $5) — developers.openai.com, anthropic.com
- OpenRouter (frais ~5,5 % à la recharge, passthrough, ZDR, fallback, pas de SLA) — openrouter.ai/pricing, openrouter.ai/docs
- Resell / usage commercial de l'API — openai.com/policies ; terms.law (analyse)
