// ============================================================
// OpenChat — Configuration deploiement & monetisation (ACTIF)
// URL publique : https://cocktail-flashers-acne-cards.trycloudflare.com
// Regenerer via : start-public.bat (cloudflared quick tunnel, gratuit)
// Hebergement permanent gratuit : voir render.yaml / fly.toml
// ============================================================
const OPENCHAT_CONFIG = {
  support: {
    // ⚠️ RÈGLE : tout ce qui est vide est AUTOMATIQUEMENT masqué sur le site.
    // Aucun lien mort n'est jamais montré aux visiteurs.
    kofiUrl: '',            // ex. 'https://ko-fi.com/tonpseudo'   (versement PayPal/Stripe)
    paypalUrl: '',          // ex. 'https://paypal.me/tonpseudo'   (indisponible pour percevoir en Algérie)
    payeerUrl: '',          // ex. 'https://payeer.com/045xxxxxxx' (FONCTIONNE depuis l'Algérie)
    vipPriceLabel: '2,99 €/mois',
  },
  crypto: {
    // Recevoir sans aucun compte marchand : il suffit d'une adresse de portefeuille.
    // Frais ~1 $ sur le réseau Tron, versement immédiat, utilisable depuis l'Algérie.
    usdtTrc20: '',        // ex. 'TXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'
    usdtBep20: '',        // ex. '0xXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'
    btc: '',              // ex. 'bc1q...'
    note: 'Soutien en crypto : pas d’intermédiaire, pas de frais bancaires.',
  },
  ads: {
    // Banniere "soutien" affichee en bas de page (desactivable ici).
    enabled: true,
    provider: 'house',
    slotHeader: '',
    slotSidebar: '',
  },
  analytics: {
    enabled: false,
    provider: 'none',
    websiteId: '',
    scriptSrc: '',
  },
  site: {
    // Domaine définitif (Render, Fly, ton nom de domaine...). Laissé vide tant que
    // le site n'est joignable que par un tunnel éphémère : aucune balise canonical
    // n'est alors injectée (une canonical fausse pénalise le référencement).
    canonicalUrl: '',
  },
  affiliate: {
    // Programmes d'affiliation : colle TES liens de parrainage, sinon rien ne s'affiche.
    vpnUrl: '',           // ex. 'https://go.nordvpn.net/aff_c?...'
    hostingUrl: '',       // ex. 'https://www.hostinger.fr?REFERRALCODE=...'
  },
};

// Exposé explicitement pour que app.js puisse le lire sans risque de ReferenceError.
window.OPENCHAT_CONFIG = OPENCHAT_CONFIG;
