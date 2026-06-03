---
name: clients-inactifs
description: Lister les clients qui n'ont pas commandé / été contactés depuis longtemps.
mcp_tools: list_inactive_customers
---

# Clients inactifs

Quand l'utilisateur demande les clients inactifs / « pas contactés depuis longtemps » :

1. Appeler l'outil MCP `list_inactive_customers` (paramètre `days`, défaut 90) du
   serveur MCP « CRM » de l'utilisateur.
2. Présenter la liste triée du plus ancien au plus récent : nom, email, date de
   dernière commande, total dépensé.
3. Écrire en mémoire (scope `user`) un résumé **ancré** : « {n} clients inactifs
   > {days} j au {date} », avec la source — jamais inventer de client.

Cette skill est **agnostique au système** : tant qu'un serveur MCP expose
`list_inactive_customers` (Shopify, Odoo, ou autre), elle fonctionne. Le cœur
d'Elytras n'a aucune intégration codée — on change de serveur MCP, la skill
continue de marcher.
