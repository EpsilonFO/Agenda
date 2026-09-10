/* Service worker — Agenda IA.
 *
 * Deux rôles :
 *  1. Notifications push (un SW enregistré est OBLIGATOIRE sur iOS) ;
 *  2. Agenda hors ligne : on garde en cache la coquille de l'app (HTML, JS,
 *     CSS, icônes, police) et la dernière réponse de chaque lecture d'API,
 *     pour que l'agenda s'affiche sans réseau. Les écritures ne passent PAS
 *     par ici : elles sont mises en file d'attente côté page
 *     (src/lib/offline.ts) et repartent à la reconnexion — la Background Sync
 *     API n'existe pas sur iOS, donc rien à gagner à le faire ici.
 */

const VERSION = "v1";
const SHELL_CACHE = `agenda-shell-${VERSION}`;
const DATA_CACHE = `agenda-data-${VERSION}`;

/** Pages et fichiers indispensables au premier affichage hors ligne. */
const PRECACHE = [
  "/",
  "/agents",
  "/reglages",
  "/manifest.webmanifest",
  "/icons/calendar.png",
];

/** Requêtes qui n'ont aucun sens hors ligne (ou qui ne doivent pas être servies périmées). */
const NEVER_CACHE = [
  "/api/agent", // appels LLM : sans réseau, ils doivent échouer franchement
  "/api/auth",
  "/api/push",
  "/api/cron",
  "/api/plan/commit",
  "/api/google/auth",
  "/api/google/callback",
  "/api/google/sync",
  "/api/google/rsvp",
  "/login",
];

const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

/** Dernier recours : aucune page en cache (app jamais ouverte en ligne ici). */
const OFFLINE_HTML = `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agenda hors ligne</title>
<style>body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;
background:#0b1220;color:#e2e8f0;font:500 15px/1.5 system-ui,sans-serif;padding:24px;text-align:center}
p{max-width:22rem;color:#94a3b8}</style></head>
<body><div><h1 style="font-size:1.1rem">Agenda indisponible hors ligne</h1>
<p>Ouvre l'agenda une fois avec du réseau : il sera ensuite consultable et
modifiable sans connexion.</p></div></body></html>`;

/* --------------------------- Cycle de vie ---------------------------- */

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Chaque entrée séparément : une page qui échoue (session expirée,
      // réseau capricieux) ne doit pas faire échouer toute l'installation.
      await Promise.all(
        PRECACHE.map(async (url) => {
          try {
            const res = await fetch(url, { cache: "no-cache" });
            if (res.ok && !res.redirected) await cache.put(url, res.clone());
          } catch {
            /* sera mis en cache au premier passage réussi */
          }
        })
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Purge les caches des versions précédentes (les fichiers /_next/static
      // d'un ancien build n'ont plus d'utilité).
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith("agenda-") && k !== SHELL_CACHE && k !== DATA_CACHE)
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

/* ------------------------------ Lecture ------------------------------ */

/** Ajoute un marqueur pour que la page sache qu'elle lit du cache. */
async function markCached(res) {
  const headers = new Headers(res.headers);
  headers.set("x-agenda-cache", "1");
  return new Response(await res.blob(), {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

function cacheable(res) {
  // `redirected` = on a été renvoyé vers /login : ce n'est pas la page demandée.
  return res && res.ok && !res.redirected;
}

/** Réseau d'abord, cache en secours (données fraîches dès qu'il y a du réseau). */
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (cacheable(res)) cache.put(request, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(request);
    if (hit) return markCached(hit);
    throw err;
  }
}

/**
 * Navigation (ouverture de l'app, changement d'onglet) : réseau d'abord, puis
 * la page en cache, puis l'agenda.
 *
 * La clé de cache est le chemin seul et non la requête : une requête de
 * navigation porte des en-têtes que Next fait varier (`Vary: RSC, …`), et on
 * ne veut pas rater le cache pour cette raison.
 */
async function navigationFirst(request, pathname) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(request);
    if (cacheable(res)) cache.put(pathname, res.clone());
    return res;
  } catch {
    const hit = (await cache.match(pathname)) || (await cache.match("/"));
    if (hit) return markCached(hit);
    // Rien en cache : l'app n'a jamais été ouverte en ligne sur ce téléphone.
    return new Response(OFFLINE_HTML, {
      status: 503,
      headers: { "Content-Type": "text/html; charset=utf-8", "x-agenda-cache": "1" },
    });
  }
}

/** Cache d'abord (fichiers versionnés : leur contenu ne change jamais). */
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  // Les polices arrivent en réponse opaque (no-cors) : status 0, ok = false.
  if (cacheable(res) || res.type === "opaque") {
    await cache.put(request, res.clone());
    await pruneBuildFiles(cache);
  }
  return res;
}

/**
 * Les fichiers /_next/static/ changent de nom à chaque build : sans ménage,
 * le cache accumulerait les morceaux de toutes les versions déployées (le SW
 * lui-même ne change pas, donc `activate` ne repasse pas). On garde donc les
 * N plus récents — `keys()` rend les entrées dans leur ordre d'ajout.
 */
const MAX_BUILD_FILES = 120;

async function pruneBuildFiles(cache) {
  const keys = (await cache.keys()).filter((r) =>
    new URL(r.url).pathname.startsWith("/_next/static/")
  );
  for (let i = 0; i < keys.length - MAX_BUILD_FILES; i++) {
    await cache.delete(keys[i]);
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // écritures : gérées par la page

  const url = new URL(request.url);

  // Police Manrope (Google Fonts) : sans elle, l'app hors ligne change de tête.
  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
    return;
  }

  if (url.origin !== self.location.origin) return;
  if (NEVER_CACHE.some((p) => url.pathname.startsWith(p))) return;

  // Fichiers de build et icônes : immuables, donc cache d'abord.
  if (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icons/")
  ) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(navigationFirst(request, url.pathname));
    return;
  }

  // Lectures d'API : réseau d'abord, dernière réponse connue en secours.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(networkFirst(request, DATA_CACHE));
    return;
  }

  // Le reste (payloads RSC de Next, manifeste…) : réseau d'abord.
  event.respondWith(networkFirst(request, SHELL_CACHE));
});

/* --------------------------- Notifications --------------------------- */

// Réception d'une notification push.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Agenda", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Agenda IA";
  const options = {
    body: data.body || "",
    icon: "/icons/calendar.png",
    badge: "/icons/calendar.png",
    tag: data.tag, // regroupe/écrase les notifs d'un même event
    data: { url: data.url || "/" },
    // Vibration légère (ignoré sur iOS mais utile sur Android).
    vibrate: [80, 40, 80],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Clic sur une notification : ouvre/refocus l'app.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          if ("focus" in client) {
            client.navigate(target);
            return client.focus();
          }
        }
        return self.clients.openWindow(target);
      })
  );
});
