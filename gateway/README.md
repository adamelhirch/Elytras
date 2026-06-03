# Elytras — Passerelle IA (LLM Gateway)

Service **central, opéré par toi**, qui sert d'intermédiaire entre les instances Elytras des
clients et les modèles d'IA. C'est le **centre de profit** du resell : il détient la clé du
backend (OpenRouter), **compte les tokens par client**, applique les **plafonds**, et fournit
les données de **facturation**. Les clients ne voient jamais l'API brute ni la clé — ils
consomment l'application, conforme aux CGU des providers.

## Ce qu'elle fait

- Expose `POST /v1/chat/completions` (compatible OpenAI), appelé par chaque instance Elytras avec sa **clé de service** (≠ clé OpenRouter).
- Le client demande une **gamme** (`eco` / `standard` / `max`) ; la passerelle choisit le modèle réel et le **masque**.
- **Metering** : tokens + coût (réel et refacturé avec marge) journalisés par client et par mois.
- **Plafond mensuel** par client : coupe le service au dépassement.
- Backend **OpenRouter** au démarrage ; bascule directe (DeepSeek/Google/OpenAI) possible plus tard sans rien changer côté client.

## Lancer

```bash
cd gateway
cp .env.example .env          # renseigne OPENROUTER_API_KEY + GATEWAY_ADMIN_TOKEN
pip install -r requirements.txt
uvicorn elytras_gateway.main:app --host 127.0.0.1 --port 8088
```

Ou en Docker (recommandé sur le VPS, derrière un reverse proxy TLS) :

```bash
docker build -t elytras-gateway .
docker run --env-file .env -p 127.0.0.1:8088:8088 elytras-gateway
```

## Créer un client (tenant)

```bash
curl -s -X POST http://127.0.0.1:8088/admin/tenants \
  -H "Authorization: Bearer $GATEWAY_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Vanille Désire","monthly_cap_usd":50}'
# → renvoie {"id":..., "service_key":"elyt-..."}  (la clé n'est affichée QU'UNE fois)
```

Options : `tier_allowed` (ex. `["eco","standard"]`) pour limiter les gammes ; `monthly_cap_usd` pour le plafond.

## Brancher une instance Elytras dessus

Dans l'environnement de l'instance client :

```bash
ELYTRAS_PROVIDER=elytras-gateway
ELYTRAS_GATEWAY_URL=https://gateway.elytras.app      # ou http://127.0.0.1:8088 en local
ELYTRAS_GATEWAY_KEY=elyt-...                          # la clé de service du client
ELYTRAS_GATEWAY_TIER=eco                              # gamme par défaut
```

## Suivre la consommation (facturation)

```bash
curl -s "http://127.0.0.1:8088/admin/usage?tenant=<id>" \
  -H "Authorization: Bearer $GATEWAY_ADMIN_TOKEN"
# → {calls, ptok, ctok, cost_real, cost_billed} pour le mois courant
```

## Sécurité

- `OPENROUTER_API_KEY` et `GATEWAY_ADMIN_TOKEN` **jamais committés** (voir `.gitignore`).
- Les clés de service des clients sont **stockées hashées** (affichées une seule fois).
- Admin **verrouillé** tant que `GATEWAY_ADMIN_TOKEN` n'est pas défini.
- À exposer **derrière TLS** (Caddy) ; ne pas publier le port 8088 en clair sur Internet.
- Active la **zéro rétention (ZDR)** et le filtrage des providers côté OpenRouter pour la conformité RGPD.

## Tests

```bash
pip install -r requirements-dev.txt
PYTHONPATH=. python -m pytest          # 9 tests
```
