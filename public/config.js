// ============================================================
// OpenChat — Configuration des déploiements & monétisation
// ============================================================
// Fichier injecté en tête de public/app.js afin de rester
// sur le principe zéro-étape-de-build.
//
// DEPLOIEMENTS GRATUITS (hébergement + domaine public HTTPS/WSS) :
//   1. Render.com (recommandé, gratuit)
//      - Crée un compte sur https://render.com
//      - "New +" -> "Web Service" -> connecte ton repo GitHub
//      - Build Command    : (laisser vide)
//      - Start Command    : node server.js
//      - Plan             : Free
//      - Variable d'env   : PORT=10000 (Render l'impose automatiquement)
//      - URL finale       : https://ton-service.onrender.com
//   2. Railway.app (500h gratuites/mois)
//      - New Project -> Deploy from GitHub -> Start Command: node server.js
//   3. Fly.io (3 machines always-on gratuites)
//      - fly launch / fly deploy (Dockerfile déjà fourni)
//   4. Koyeb.com (instance Nano gratuite 24/7)
//      - Service -> GitHub -> Run command: node server.js, Port 3000.
//   5. Tunnel local GRATUIT illimité (partage ton PC en 30 secondes)
//      - cloudflared tunnel --url http://localhost:3000
//        => https://xxxx.trycloudflare.com (HTTPS + WSS, sans mot de passe)
//      - Alternative : lt --port 3000  (localtunnel, mais page de rappel)
//
// MONETISATION (remplace les URLs ci-dessous par tes liens d'affiliation/dons)
//   - Ko-fi : https://ko-fi.com/ton-pseudo
//   - Tipeee : https://fr.tipeee.com/ton-projet
//   - Stripe Payment Links : https://buy.stripe.com/xxxx
//   - Ezoic / Mediavine : bannières display (nécessite ~10k visites/mois)
//   - Affiliation VPN : NordVPN, ProtonVPN, Surfshark (programmes à 40-100%)
// ============================================================
const OPENCHAT_CONFIG = {
  support: {
    kofiUrl: 'https://ko-fi.com/openchat',
    paypalUrl: 'https://www.paypal.com/paypalme/openchat',
    vipPriceLabel: '2,99 €/mois',
  },
  ads: {
    enabled: false,
    provider: 'none',
    slotHeader: '',
    slotSidebar: '',
  },
  analytics: {
    enabled: false,
    provider: 'none',
    websiteId: '',
    scriptSrc: '',
  },
  affiliate: {
    vpnUrl: 'https://go.nordvpn.net/aff_c?offer_id=15&aff_id=ton-id',
    hostingUrl: 'https://www.hostinger.fr?REFERRALCODE=ton-code',
  },
};