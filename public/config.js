// ============================================================
// OpenChat — Configuration deploiement & monetisation (ACTIF)
// URL publique : https://cocktail-flashers-acne-cards.trycloudflare.com
// Regenerer via : start-public.bat (cloudflared quick tunnel, gratuit)
// Hebergement permanent gratuit : voir render.yaml / fly.toml
// ============================================================
const OPENCHAT_CONFIG = {
  support: {
    kofiUrl: 'https://ko-fi.com/openchat',
    paypalUrl: 'https://www.paypal.com/paypalme/openchat',
    vipPriceLabel: '2,99 €/mois',
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
  affiliate: {
    vpnUrl: 'https://www.protonvpn.com/?ref=openchat',
    hostingUrl: 'https://www.hostinger.fr?REFERRALCODE=openchat',
  },
};