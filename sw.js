// ============================================================
//  Fabi Cine — Service Worker
//  ➜ À CHAQUE DÉPLOIEMENT : change seulement CACHE_VERSION
// ============================================================
const CACHE_VERSION = "2026-11-15-2";
const CACHE_NAME = "fabi-cine-" + CACHE_VERSION;

// Fichiers pré-chargés à l'installation (le site marche hors ligne dès la 1re visite)
const SHELL = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "icon-192.png",
  "icon-512.png",
  "logo.png"
];

// Délai max d'attente du réseau avant d'utiliser la copie en cache (ms)
const NETWORK_TIMEOUT = 4000;

// Ressources « toujours à jour » (network first) : pages + données produits.
// (Le catalogue en ligne Google Script est sur un autre domaine : il ne passe pas par ce fichier
//  et est déjà demandé en direct par index.html.)
function isNetworkFirst(request, url) {
  return (
    request.mode === "navigate" ||
    url.pathname.endsWith("/") ||
    url.pathname.endsWith("/index.html") ||
    url.pathname.endsWith(".json") ||
    url.pathname.includes("/data/") ||
    url.pathname.includes("/api/")
  );
}

// ---------- INSTALLATION ----------
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        // cache.add fichier par fichier : un fichier manquant ne bloque pas l'installation
        Promise.all(SHELL.map((url) => cache.add(url).catch(() => {})))
      )
      .then(() => self.skipWaiting()) // active la nouvelle version sans attendre
  );
});

// ---------- ACTIVATION ----------
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME) // supprime tous les anciens caches
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim()) // prend le contrôle des pages déjà ouvertes
  );
});

// ---------- STRATÉGIES ----------
// Network first : réseau d'abord (sans cache HTTP), sinon copie en cache
async function networkFirst(request, event) {
  const cache = await caches.open(CACHE_NAME);
  const isNav = request.mode === "navigate";

  const network = fetch(request.url, { cache: "no-cache", credentials: "same-origin" }).then((response) => {
    if (response && response.ok) {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  });

  try {
    // Réseau lent ou coupé ➜ on bascule sur le cache après NETWORK_TIMEOUT
    const response = await Promise.race([
      network,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), NETWORK_TIMEOUT))
    ]);
    return response;
  } catch (err) {
    const cached = await cache.match(request, { ignoreSearch: isNav });
    if (cached) {
      event.waitUntil(network.catch(() => {})); // laisse le réseau finir et mettre à jour le cache
      return cached;
    }
    if (isNav) {
      const page = await cache.match("index.html");
      if (page) return page;
    }
    // Dernier recours : on attend la vraie réponse réseau (même lente)
    return network.catch(() => Response.error());
  }
}

// Cache d'abord + rafraîchissement en arrière-plan (images, icônes, CSS, JS, polices)
async function cacheFirst(request, event) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  const network = fetch(request)
    .then((response) => {
      if (response && (response.ok || response.type === "opaque")) {
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    event.waitUntil(network);
    return cached;
  }
  return (await network) || Response.error();
}

// ---------- REQUÊTES ----------
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const isFont = /(^|\.)fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if (url.origin !== self.location.origin && !isFont) return;

  // Pas de cache pour les APK, les vidéos/audios et les requêtes partielles (Range)
  if (/\.(apk|mp4|mkv|webm|avi|mov|mp3)$/i.test(url.pathname)) return;
  if (request.headers.has("range")) return;

  // Le service worker lui-même n'est jamais servi depuis le cache
  if (url.pathname.endsWith("/sw.js")) return;

  event.respondWith(
    isNetworkFirst(request, url)
      ? networkFirst(request, event)
      : cacheFirst(request, event)
  );
});
