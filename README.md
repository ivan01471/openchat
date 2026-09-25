# OpenChat 💬

Alternative open-source et sécurisée à Chatiw, **zéro dépendance externe** (uniquement les modules natifs Node.js `node:http`, `node:crypto`, `node:net`, `node:fs`, `node:path`).

## Fonctionnalités principales

- **Appariement aléatoire 1-à-1 anonyme** avec filtres : genre recherché, langue, pays.
- **Vérification d'âge stricte** : minimum 16 ans (configurable par variable d'environnement).
- **Sécurité & Modération active** :
  - Protection contre le flooding de messages et de connexions par IP (Token Bucket).
  - Bouton **Signaler / Bloquer** : bannit temporairement l'IP du partenaire malveillant et rompt immédiatement l'échange.
  - Sanitization complète côté client (`textContent`, aucune utilisation d'`innerHTML` pour les entrées utilisateur).
  - En-têtes HTTP de sécurité stricts : Content-Security-Policy, X-Content-Type-Options: nosniff, X-Frame-Options: DENY, Referrer-Policy.
- **WebSockets RFC 6455 natifs** : handshakes, masquage client/serveur, fragmentation gérés de zéro sans `ws` ni socket.io.
- **Mode Sombre / Clair** persistant dans `localStorage`.
- **Règles de communauté** présentées avant le chat.

---

## Démarrage rapide

### Prérequis
- Node.js ≥ 18.0.0

```bash
# Lancer le serveur
npm start
# ou directement
node server.js
```

Le serveur écoute par défaut sur `http://localhost:3000`.

### Lancer la suite de tests
```bash
npm test
```
*Suite d'intégration de 21 tests automatisés avec client WebSocket synthétique RFC 6455.*

---

## Variables d'environnement

| Variable | Défaut | Description |
|---|---|---|
| `PORT` | `3000` | Port d'écoute HTTP / WebSocket |
| `MIN_AGE` | `16` | Âge minimal requis |
| `MAX_MESSAGE_BYTES` | `2000` | Taille max d'un message (octets UTF-8) |
| `LIMIT_CONN_PER_IP` | `10` | Connexions max concurrentes par IP |
| `LIMIT_MSG_PER_SEC` | `4` | Messages max par seconde avant throttling |
| `LIMIT_JOIN_PER_MIN` | `20` | Rejoignements max par minute |
| `BAN_DURATION_MS` | `3600000` | Durée de bannissement après signalement (1h) |

---

## Déploiement

### Déploiement Docker (Container)
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY . .
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
USER node
CMD ["node", "server.js"]
```

### Déploiement Render / Railway / Fly.io
1. Pousser ce dépôt vers GitHub / GitLab.
2. Créer un nouveau Web Service pointant vers le dépôt.
3. Commande de build : *(laisser vide, zéro build requis)*.
4. Commande de démarrage : `node server.js`.
5. Définir `PORT` si le fournisseur l'exige.
