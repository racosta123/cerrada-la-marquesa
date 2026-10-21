const CACHE = 'marquesa-v34';

// SHELL: cambia en cada publicación → se baja SIEMPRE del servidor al instalar una versión nueva.
// cache:'reload' — GitHub Pages manda Cache-Control max-age=600: con addAll a secas el precache
// de una versión NUEVA podía llenarse con el app.js/index.html VIEJO de la caché HTTP (hasta 10 min).
const SHELL = ['./','./index.html','./app.js','./config.js','./manifest.json'];

// ESTÁTICOS: no cambian de contenido sin cambiar de nombre (así se hizo con los iconos icon-m-*).
// Si ya están en la caché de la versión anterior se COPIAN de ahí (0 bytes de datos móviles por
// versión); si no, se piden a la red. REGLA: si reemplazas uno de estos archivos, cámbiale el nombre.
// vendor/ va aquí aunque app.js lo cargue bajo demanda: así el QR, los PDF y las gráficas
// funcionan sin red. El resto de imágenes/iconos se guarda la primera vez que se piden.
const ESTATICOS = [
  './vendor/qrcode.min.js','./vendor/jspdf.umd.min.js','./vendor/jspdf.plugin.autotable.min.js','./vendor/chart.umd.min.js',
  './assets/marquesa-mobile.webp',
  './icons/icon-m-192.png','./icons/apple-touch-icon-m.png','./icons/favicon-m-32.png','./icons/favicon-m-48.png'];

// SDK de Firebase: SOLO estas URLs exactas, con la versión fijada (código público, inmutable).
// Las tres primeras se precargan (las usa index.html al abrir); mensajes y App Check se guardan
// la primera vez que app.js los pide. Si cambias 10.12.2, cámbialo también en index.html y app.js.
const FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
const SDK_PRECARGA = ['firebase-app-compat.js','firebase-auth-compat.js','firebase-firestore-compat.js'].map(f => FIREBASE_SDK + f);
const SDK_PERMITIDO = new Set([...SDK_PRECARGA,
  FIREBASE_SDK + 'firebase-messaging-compat.js', FIREBASE_SDK + 'firebase-app-check-compat.js']);

// Prefijos de la app cuyas respuestas se pueden guardar al vuelo (archivos públicos, sin datos).
const RUNTIME_OK = /\/(vendor|assets|icons)\/[^/]+$/;

function pedirSDK(url){
  return fetch(new Request(url, { mode:'cors', credentials:'omit' }));
}
async function copiarOBajar(cache, url, bajar){
  const viejo = await caches.match(url);
  if (viejo) return cache.put(url, viejo);
  const res = await bajar();
  if (!res.ok) throw new Error('precache ' + url + ' ' + res.status);
  return cache.put(url, res);
}

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all([
    c.addAll(SHELL.map(u => new Request(u, { cache:'reload' }))),
    ...ESTATICOS.map(u => copiarOBajar(c, new URL(u, self.location).href, () => fetch(u))),
    ...SDK_PRECARGA.map(u => copiarOBajar(c, u, () => pedirSDK(u))),
  ])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});

// La app (index.html, app.js, config.js) se sirve desde la caché de ESTA versión: abre al instante,
// con o sin señal, y index.html y app.js siempre son de la misma versión. Las versiones nuevas
// llegan solas: en cada apertura se revisa sw.js en segundo plano (aquí y en app.js); si cambió,
// el SW nuevo se instala con su propio shell, toma el control y app.js recarga la página.
// REGLA: cada publicación DEBE subir CACHE (marquesa-vNN), si no, los celulares no la verán.
function esPaginaApp(url){
  const base = new URL('./', self.location).pathname;
  return url.pathname === base || url.pathname === base + 'index.html';
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Nunca cachear llamadas al Worker ni a Firebase/Google (datos, tokens, sesión).
  if (url.pathname.startsWith('/abrir') || url.hostname.includes('workers.dev') || url.hostname.includes('googleapis')) return;

  if (url.origin !== self.location.origin){
    // De otros orígenes SOLO el SDK de Firebase de la lista; lo demás va directo a la red.
    if (SDK_PERMITIDO.has(url.href)){
      e.respondWith(caches.match(url.href).then(r => r || pedirSDK(url.href).then(res => {
        if (res.ok){ const copia = res.clone(); caches.open(CACHE).then(c => c.put(url.href, copia)); }
        return res;
      })));
    }
    return;
  }

  if (req.mode === 'navigate'){
    if (esPaginaApp(url)){
      e.respondWith(caches.open(CACHE)
        .then(c => c.match(req, { ignoreSearch:true }).then(r => r || c.match('./')))
        .then(r => r || fetch(req)));
      e.waitUntil(self.registration.update().catch(() => {}));   // ¿hay versión nueva? (en segundo plano)
      return;
    }
    // Otras páginas (registro.html…): primero la red, como antes.
    e.respondWith(fetch(req, { cache:'no-cache' }).catch(() => caches.match(req).then(r => r || caches.match('./index.html'))));
    return;
  }

  e.respondWith(caches.match(req).then(r => r || fetch(req).then(res => {
    if (res.ok && RUNTIME_OK.test(url.pathname)){
      const copia = res.clone();
      caches.open(CACHE).then(c => c.put(req, copia));
    }
    return res;
  })));
});

// app.js pregunta por postMessage qué versión tiene ESTE service worker activo (para mostrarla
// en Gestión) — así siempre se muestra lo que de verdad está corriendo, no un número fijo.
self.addEventListener('message', e => {
  if (e.data?.type === 'GET_VERSION') e.source?.postMessage({ type:'VERSION', version: CACHE });
});
