/* ApplianceClinic service worker.
 *
 * STATIC (may cache): app shell HTML, Help Hub HTML, CSS, JS, brand icons, 404.
 * RUNTIME (cache after first visit): same-origin /media/ used by Help Hubs.
 * DYNAMIC (NEVER cache): /api (including diagnosis, auth, admin, transcripts, recalls APIs),
 * POST/PUT/PATCH/DELETE, admin/auth pages, robots, sitemap, this file.
 * Transcript records and admin operational data must never enter Cache Storage.
 *
 * Conversations live in localStorage (Story 1). They must not enter Cache Storage.
 * Unknown navigations are not rewritten to the homepage (Story 2 404s stand).
 * Help Hubs are network-first so editorial updates win; precache is the offline fallback.
 */
var VERSION = 'v18';
var CACHE_NAME = 'ac-static-' + VERSION;

var HELP_HUB_PATHS = {
  '/washing-machines/': 1,
  '/washer-dryers/': 1,
  '/tumble-dryers/': 1,
  '/dishwashers/': 1,
  '/fridge-freezers/': 1,
  '/ovens-cookers/': 1,
  '/hobs/': 1,
  '/microwaves/': 1,
  '/vacuum-cleaners/': 1
};

var APP_SHELL = [
  '/',
  '/styles.css?v=33',
  '/app.js?v=19',
  '/chat-session.js?v=3',
  '/webmcp.js?v=2',
  '/webmcp-badge.js?v=3',
  '/hubs/appliance-info.json',
  '/hubs/hub.js?v=1',
  '/recalls/',
  '/recalls/recalls.js?v=1',
  '/404.html',
  '/assets/applianceclinic-logo.svg?v=3',
  '/assets/applianceclinic-mark.svg?v=3',
  '/assets/applianceclinic-icon-192.png?v=2',
  '/assets/fonts/literata-600-latin.woff2',
  '/washing-machines/index.html',
  '/washer-dryers/index.html',
  '/tumble-dryers/index.html',
  '/dishwashers/index.html',
  '/fridge-freezers/index.html',
  '/ovens-cookers/index.html',
  '/hobs/index.html',
  '/microwaves/index.html',
  '/vacuum-cleaners/index.html'
];

function sameOrigin(url) {
  return url.origin === self.location.origin;
}

function isApiPath(url) {
  return url.pathname === '/api' || url.pathname.indexOf('/api/') === 0;
}

function isAdminPath(url) {
  return url.pathname === '/admin.html' || url.pathname.indexOf('/admin') === 0;
}

function isTranscriptPath(url) {
  return url.pathname.indexOf('/api/admin/transcripts') === 0
    || url.pathname.indexOf('/admin/transcripts') === 0;
}

function shouldNeverCache(request, url) {
  var method = (request.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return true;
  if (!sameOrigin(url)) return true;
  if (isApiPath(url)) return true;
  if (isAdminPath(url)) return true;
  if (isTranscriptPath(url)) return true;
  if (url.pathname === '/sw.js') return true;
  if (url.pathname === '/robots.txt' || url.pathname === '/sitemap.xml') return true;
  return false;
}

function isAppShellNavigation(url) {
  return sameOrigin(url) && url.pathname === '/';
}

function hubPath(url) {
  var p = url.pathname || '';
  if (p.length > 1 && p.charAt(p.length - 1) !== '/') p += '/';
  return p;
}

function isHelpHubNavigation(url) {
  return sameOrigin(url) && HELP_HUB_PATHS[hubPath(url)] === 1;
}

function isRecallNavigation(url) {
  if (!sameOrigin(url)) return false;
  var p = hubPath(url);
  return p === '/recalls/' || p.indexOf('/recalls/') === 0;
}

function isStaticAsset(url) {
  if (!sameOrigin(url)) return false;
  var p = url.pathname;
  if (p === '/styles.css' || p === '/app.js' || p === '/chat-session.js' || p === '/webmcp.js' || p === '/webmcp-badge.js') return true;
  if (p === '/hubs/hub.js' || p === '/recalls/recalls.js' || p === '/404.html' || p === '/site.webmanifest') return true;
  if (p.indexOf('/assets/applianceclinic-') === 0) return true;
  return false;
}

function isHelpHubMedia(url) {
  return sameOrigin(url) && url.pathname.indexOf('/media/') === 0;
}

function isNavigation(request) {
  return request.mode === 'navigate' || request.destination === 'document';
}

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(APP_SHELL);
    }).then(function () {
      if (!self.registration || !self.registration.active) {
        return self.skipWaiting();
      }
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (key !== CACHE_NAME) return caches.delete(key);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('message', function (event) {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  var url;
  try {
    url = new URL(request.url);
  } catch (e) {
    return;
  }

  if (shouldNeverCache(request, url)) {
    event.respondWith(fetch(request));
    return;
  }

  if (isNavigation(request)) {
    if (isAppShellNavigation(url)) {
      event.respondWith(networkFirst(request, '/'));
      return;
    }
    if (isHelpHubNavigation(url)) {
      event.respondWith(networkFirst(request, hubPath(url) + 'index.html'));
      return;
    }
    if (isRecallNavigation(url)) {
      event.respondWith(networkFirst(request, hubPath(url) + 'index.html'));
      return;
    }
    event.respondWith(
      fetch(request).catch(function () {
        return caches.match('/404.html');
      })
    );
    return;
  }

  if (isStaticAsset(url) || isHelpHubMedia(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  event.respondWith(fetch(request));
});

function cacheFirst(request) {
  return caches.match(request).then(function (cached) {
    if (cached) return cached;
    return fetch(request).then(function (response) {
      if (response && response.ok) {
        var copy = response.clone();
        caches.open(CACHE_NAME).then(function (cache) { cache.put(request, copy); });
      }
      return response;
    });
  });
}

function networkFirst(request, fallbackUrl) {
  return fetch(request).then(function (response) {
    if (response && response.ok) {
      var copy = response.clone();
      caches.open(CACHE_NAME).then(function (cache) { cache.put(request, copy); });
    }
    return response;
  }).catch(function () {
    return caches.match(request).then(function (cached) {
      if (cached) return cached;
      return caches.match(fallbackUrl || '/');
    });
  });
}
