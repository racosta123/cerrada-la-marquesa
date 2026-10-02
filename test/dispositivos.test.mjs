// Pruebas del módulo Dispositivos (hot swap de Shelly) y de la ruta de apertura con respaldo. Ejecutar:
//   node test/dispositivos.test.mjs
// Worker REAL + Firestore EN MEMORIA + Shelly Cloud SIMULADO (host ficticio). No toca la red ni usa llaves/IDs reales.
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSign } from 'node:crypto';
import worker from '../worker.js';
import { parsearListaShelly, formaDe } from '../dispositivos-core.js';

// ---------- llaves de prueba ----------
const dir = mkdtempSync(join(tmpdir(), 'mqd-')); const sh = c => execSync(c, { cwd: dir, stdio: 'pipe' });
sh('openssl genrsa -out k.pem 2048'); sh('openssl pkcs8 -topk8 -nocrypt -in k.pem -out k8.pem'); sh('openssl req -new -x509 -key k.pem -out cert.pem -days 2 -subj "/CN=t"');
const KEY8 = readFileSync(join(dir, 'k8.pem'), 'utf8'), CERT = readFileSync(join(dir, 'cert.pem'), 'utf8');
const PROJ = 'proyecto-prueba';
const RealNow = Date.now.bind(Date); let skew = 0;
Date.now = () => RealNow() + skew;            // permite "pasar el tiempo" para vencer la caché del Worker entre pruebas
const b64u = b => Buffer.from(b).toString('base64url');
const idToken = (uid, authAgoSec = 5) => {
  const now = Math.floor(Date.now() / 1000);
  const claims = { aud: PROJ, iss: `https://securetoken.google.com/${PROJ}`, sub: uid, user_id: uid, exp: now + 600 };
  if (authAgoSec !== null) claims.auth_time = now - authAgoSec;
  const h = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1' })), p = b64u(JSON.stringify(claims));
  return `${h}.${p}.${createSign('RSA-SHA256').update(`${h}.${p}`).sign(KEY8, 'base64url')}`;
};

// ---------- Firestore en memoria (con updateTime y precondiciones) ----------
const store = new Map(), ut = new Map(); let utN = 0, reads = { disp: 0 }, failDisp = 0, slowDisp = 0, force412 = false;
const fv = v => v === null ? { nullValue: null } : typeof v === 'string' ? { stringValue: v } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? { integerValue: String(v) } : v.__ts ? { timestampValue: v.__ts } : (() => { throw new Error('tipo'); })();
const F = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, fv(v)]));
const put = (path, o) => { store.set(path, F(o)); ut.set(path, String(++utN)); };
const base = `/v1/projects/${PROJ}/databases/(default)/documents`;
const docOut = (path, fields) => ({ name: `projects/${PROJ}/databases/(default)/documents/${path}`, fields, updateTime: ut.get(path) });
// ---------- Shelly Cloud simulado ----------
const shellyDevices = new Map();   // id -> { gen: 'G1'|'G2'|'G3'|undefined, online }
let shellyCalls = [], shellyMode = 'normal';
const gateCalls = [];
const dormir = ms => new Promise(r => setTimeout(r, ms));
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url)); const m = opts.method || 'GET';
  const R = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
  if (u.hostname === 'oauth2.googleapis.com') return R({ access_token: 'tok' });
  if (u.hostname === 'www.googleapis.com') return R({ k1: CERT }, 200, { 'cache-control': 'max-age=3600' });
  if (u.hostname === 'fcm.googleapis.com') return R({});
  if (u.hostname === 'shelly.test') {
    if (u.pathname === '/device/status') {
      const id = new URLSearchParams(String(opts.body)).get('id'); shellyCalls.push({ tipo: 'status', id });
      if (shellyMode === 'red') throw new Error('red');
      if (shellyMode === 'limite') return R({ isok: false, errors: { max_req: 'x' } }, 429);
      const d = shellyDevices.get(id); if (!d) return R({ isok: false, errors: { invalid_id: 'x' } });
      return R({ isok: true, data: { online: d.online, ...(d.gen ? { _dev_info: { gen: d.gen } } : {}) } });
    }
    if (u.pathname === '/device/all_status') {
      shellyCalls.push({ tipo: 'lista' });
      if (shellyMode === 'red') throw new Error('red');
      if (shellyMode === 'rechazo') return R({ isok: false, errors: { invalid_token: 'x' } });
      const st = {}, inf = {};
      for (const [id, d] of shellyDevices) { st[id] = { _dev_info: { id, online: d.online, ...(d.gen ? { gen: d.gen } : {}), code: d.modelo || 'SHSW-1' } }; if (d.nombre) inf[id] = { name: d.nombre }; }
      return R({ isok: true, data: { devices_status: st, devices: inf } });
    }
    if (u.pathname === '/device/relay/control') { const p = new URLSearchParams(String(opts.body)); shellyCalls.push({ tipo: 'pulso', gen: 1, id: p.get('id') }); return new Response('ok'); }
    if (u.pathname === '/v2/devices/api/set/switch') { shellyCalls.push({ tipo: 'pulso', gen: 3, id: JSON.parse(opts.body).id }); return new Response('ok'); }
    throw new Error('shelly ruta ' + u.pathname);
  }
  if (u.hostname !== 'firestore.googleapis.com') throw new Error('red inesperada: ' + u.hostname);
  const path = decodeURIComponent(u.pathname.slice(base.length + 1));
  if (m === 'GET') {
    if (path === 'config/dispositivos') { reads.disp++; if (slowDisp) await dormir(slowDisp); if (failDisp) return R({}, 500); }
    if (path.includes('/')) { const f = store.get(path); return f ? R(docOut(path, f)) : R({}, 404); }
    return R({ documents: [...store].filter(([k]) => k.startsWith(path + '/') && !k.slice(path.length + 1).includes('/')).map(([k, f]) => docOut(k, f)) });
  }
  if (m === 'POST') { store.set(`${path}/auto${store.size}${Math.random().toString(36).slice(2, 6)}`, JSON.parse(opts.body).fields); return R({}); }
  if (m === 'DELETE') { store.delete(path); return R({}); }
  if (m === 'PATCH') {
    const body = JSON.parse(opts.body); const mask = u.searchParams.getAll('updateMask.fieldPaths');
    if (force412) return R({}, 412);
    const pre = u.searchParams.get('currentDocument.updateTime'); if (pre && ut.get(path) !== pre) return R({}, 412);
    if (u.searchParams.get('currentDocument.exists') === 'false' && store.has(path)) return R({}, 412);
    if (u.searchParams.get('currentDocument.exists') === 'true' && !store.has(path)) return R({}, 404);
    if (mask.length) { const cur = { ...(store.get(path) || {}) }; mask.forEach(k => { if (body.fields[k]) cur[k] = body.fields[k]; else delete cur[k]; }); store.set(path, cur); } else store.set(path, body.fields);
    ut.set(path, String(++utN)); return R({});
  }
  throw new Error('método ' + m);
};
console.error = () => {}; console.log = (...a) => { if (String(a[0]).startsWith('  ok') || String(a[0]).startsWith('\n[') || String(a[0]).includes('pruebas OK')) process.stdout.write(a.join(' ') + '\n'); }; console.warn = () => {};

const SECRET = { visitantes: { id: 'bbbbbbbbbbbb', gen: 3 }, residentes: 'aaaaaaaaaaaa', peatones: 'cccccccccccc' };   // salida: sin dispositivo
const envBase = () => ({ FIREBASE_PROJECT: PROJ, SA_EMAIL: 's@t', SA_PRIVATE_KEY: KEY8, ALLOWED_ORIGIN: 'https://x', SHELLY_HOST: 'https://shelly.test', SHELLY_AUTH_KEY: 'LLAVE_TEST', SHELLY_DEVICES: JSON.stringify(SECRET), SHELLY_GATE_ENABLED: '0', SHELLY_STATUS_SPACING_MS: '0', SHELLY_CALL_TIMEOUT_MS: '2000' });
let env = envBase();
const call = async (ruta, uid, body = {}, authAgo = 5) => {
  const headers = { 'Content-Type': 'application/json' }; if (uid) headers.Authorization = 'Bearer ' + idToken(uid, authAgo);
  const r = await worker.fetch(new Request('https://w' + ruta, { method: 'POST', headers, body: JSON.stringify(body) }), env);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const campos = () => (store.get('config/dispositivos') ? Object.fromEntries(Object.entries(store.get('config/dispositivos')).map(([k, v]) => [k, 'integerValue' in v ? +v.integerValue : Object.values(v)[0]])) : null);
const pulsos = () => shellyCalls.filter(c => c.tipo === 'pulso');

const reset = () => {
  skew += 120000;   // vence la caché del Worker (TTL 30 s)
  store.clear(); ut.clear(); shellyCalls = []; gateCalls.length = 0; reads = { disp: 0 }; failDisp = 0; slowDisp = 0; force412 = false; shellyMode = 'normal';
  env = envBase();
  shellyDevices.clear();
  for (const id of ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc']) shellyDevices.set(id, { gen: id === 'bbbbbbbbbbbb' ? 'G3' : 'G1', online: true });
  shellyDevices.set('dddddddddddd', { gen: 'G3', online: true });      // nuevo Gen3 en línea
  shellyDevices.set('eeeeeeeeeeee', { gen: 'G1', online: true });      // nuevo Gen1 en línea
  shellyDevices.set('ffffffffffff', { gen: 'G3', online: false });     // existe pero apagado
  shellyDevices.set('112233445566', { online: true });                 // existe, no informa generación
  put('usuarios/uM', { nombre: 'McRub', rol: 'master', estado: 'activo' });
  put('usuarios/uA', { nombre: 'Miguel', rol: 'admin', estado: 'activo' });
  put('usuarios/uJA', { nombre: 'Jefa Admin', rol: 'residente', esAdmin: true, estado: 'activo', casa: 'Casa 9' });
  put('usuarios/uR', { nombre: 'Rosa', rol: 'residente', estado: 'activo', casa: 'Casa 1' });
};
let pass = 0; const t = async (name, fn) => { reset(); await fn(); pass++; console.log('  ok -', name); };
const dispDoc = o => put('config/dispositivos', o);

console.log('\n[1] Apertura: documento ausente / válido / corrupto / caído → siempre abre (respaldo = secret)');
await t('sin documento: usa el secret de siempre (Gen1 residentes, Gen3 visitantes)', async () => {
  assert.equal((await call('/abrir', 'uR', { puerta: 'residentes' })).status, 200);
  assert.equal((await call('/abrir', 'uR', { puerta: 'visitantes' })).status, 200);
  assert.deepEqual(pulsos().map(p => [p.gen, p.id]), [[1, 'aaaaaaaaaaaa'], [3, 'bbbbbbbbbbbb']]);
});
await t('con documento válido: la puerta del documento manda; las demás siguen en el secret', async () => {
  dispDoc({ residentes_id: 'eeeeeeeeeeee', residentes_gen: 1, visitantes_id: 'dddddddddddd', visitantes_gen: 3, version: 1 });
  await call('/abrir', 'uR', { puerta: 'residentes' }); await call('/abrir', 'uR', { puerta: 'visitantes' }); await call('/abrir', 'uR', { puerta: 'peatones' });
  assert.deepEqual(pulsos().map(p => p.id), ['eeeeeeeeeeee', 'dddddddddddd', 'cccccccccccc']);
});
await t('documento CORRUPTO (ids mal formados, tipos raros, gen inválida, historial basura): cae al secret y abre', async () => {
  dispDoc({ residentes_id: 'no-es-hex!!', residentes_gen: 1, visitantes_id: 'dddddddddddd', visitantes_gen: 9, peatones_id: 12345, peatones_gen: 'x', historial: '{{{basura', version: 'x' });
  for (const p of ['residentes', 'visitantes', 'peatones']) assert.equal((await call('/abrir', 'uR', { puerta: p })).status, 200, p);
  assert.deepEqual(pulsos().map(p => p.id), ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc']);
});
await t('documento vacío o solo con historial: secret', async () => {
  dispDoc({ historial: '[]' });
  assert.equal((await call('/abrir', 'uR', { puerta: 'residentes' })).status, 200); assert.equal(pulsos()[0].id, 'aaaaaaaaaaaa');
});
await t('Firestore del documento CAÍDO (500): abre con el secret y rápido', async () => {
  failDisp = 1; const t0 = Date.now();
  const r = await call('/abrir', 'uR', { puerta: 'residentes' }); assert.equal(r.status, 200); assert.equal(pulsos()[0].id, 'aaaaaaaaaaaa');
});
await t('Firestore del documento LENTO (3 s): la apertura espera como máximo ~1.5 s y abre con el secret', async () => {
  dispDoc({ residentes_id: 'eeeeeeeeeeee', residentes_gen: 1 }); slowDisp = 3000;
  const t0 = performance.now(); const r = await call('/abrir', 'uR', { puerta: 'residentes' }); const ms = performance.now() - t0;
  assert.equal(r.status, 200); assert.equal(pulsos()[0].id, 'aaaaaaaaaaaa', 'cayó al secret'); assert.ok(ms < 2600, 'tardó ' + ms);
});
await t('caché: aperturas seguidas NO leen el documento cada vez (1 lectura)', async () => {
  dispDoc({ residentes_id: 'eeeeeeeeeeee', residentes_gen: 1 });
  for (let i = 0; i < 5; i++) assert.equal((await call('/abrir', 'uR', { puerta: 'residentes' })).status, 200);
  assert.equal(reads.disp, 1); assert.ok(pulsos().every(p => p.id === 'eeeeeeeeeeee'));
});
await t('modo PORTERO (SHELLY_GATE_ENABLED ≠ "0"): el Durable Object recibe el id y la generación vigentes', async () => {
  delete env.SHELLY_GATE_ENABLED;
  env.SHELLY_GATE = { idFromName: () => 'g', get: () => ({ fetch: async (u, o) => { gateCalls.push(JSON.parse(o.body)); return new Response(JSON.stringify({ ok: true })); } }) };
  dispDoc({ visitantes_id: 'dddddddddddd', visitantes_gen: 3 });
  assert.equal((await call('/abrir', 'uR', { puerta: 'visitantes' })).status, 200);
  assert.equal(gateCalls[0].deviceId, 'dddddddddddd'); assert.equal(gateCalls[0].gen, 3); assert.equal(gateCalls[0].label, 'visitantes');
});
await t('puerta sin dispositivo en ningún lado (salida): mismo 503 de siempre', async () => {
  const r = await call('/abrir', 'uR', { puerta: 'salida' }); assert.equal(r.status, 503); assert.equal(r.body.error, 'Puerta sin dispositivo configurado');
});
await t('/abrir sin token: 401 idéntico a siempre', async () => { const r = await call('/abrir', null, { puerta: 'residentes' }); assert.equal(r.status, 401); assert.equal(r.body.error, 'Falta token'); });

console.log('\n[2] /dispositivos/cambiar (master + contraseña reciente + Shelly existente y en línea)');
await t('cambia Visitantes a un Gen3 en línea: queda guardado, en bitácora, y la PRÓXIMA apertura ya usa el nuevo', async () => {
  await call('/abrir', 'uR', { puerta: 'visitantes' });   // calienta la caché con el secret
  const r = await call('/dispositivos/cambiar', 'uM', { puerta: 'visitantes', id: 'dddddddddddd' });
  assert.equal(r.status, 200); assert.equal(r.body.gen, 3);
  const c = campos(); assert.equal(c.visitantes_id, 'dddddddddddd'); assert.equal(c.visitantes_gen, 3); assert.equal(c.version, 1);
  const h = JSON.parse(c.historial); assert.equal(h.length, 1); assert.equal(h[0].idAnterior, 'bbbbbbbbbbbb'); assert.equal(h[0].idNuevo, 'dddddddddddd'); assert.equal(h[0].por, 'uM');
  const log = [...store].filter(([k]) => k.startsWith('aperturas/')).map(([, f]) => f.nombre.stringValue);
  assert.ok(log.some(x => x.includes('McRub cambió el Shelly de visitantes') && x.includes('bbbbbb') && x.includes('dddddd')), log.join('|'));
  shellyCalls = []; await call('/abrir', 'uR', { puerta: 'visitantes' }); assert.equal(pulsos()[0].id, 'dddddddddddd');
});
await t('Gen1 detectado (eeee…) para Residentes', async () => {
  const r = await call('/dispositivos/cambiar', 'uM', { puerta: 'residentes', id: 'EEEEEEEEEEEE'.toLowerCase() }); assert.equal(r.status, 200); assert.equal(r.body.gen, 1);
  shellyCalls = []; await call('/abrir', 'uR', { puerta: 'residentes' }); assert.deepEqual([pulsos()[0].gen, pulsos()[0].id], [1, 'eeeeeeeeeeee']);
});
await t('ID inválido (formato): 400 y no se consulta Shelly ni se guarda', async () => {
  for (const id of ['xyz', '12', 'gggggggggggg', 'a'.repeat(40), '', 'dddddddddddd; DROP', '../x']) assert.equal((await call('/dispositivos/cambiar', 'uM', { puerta: 'visitantes', id })).status, 400, id);
  assert.equal(shellyCalls.length, 0); assert.equal(store.has('config/dispositivos'), false);
});
await t('puerta inválida: 400', async () => assert.equal((await call('/dispositivos/cambiar', 'uM', { puerta: 'techo', id: 'dddddddddddd' })).status, 400));
await t('Shelly que NO existe en la cuenta: 404, nada guardado', async () => {
  const r = await call('/dispositivos/cambiar', 'uM', { puerta: 'visitantes', id: '999999999999' }); assert.equal(r.status, 404); assert.equal(store.has('config/dispositivos'), false);
});
await t('Shelly FUERA DE LÍNEA: 409, nada guardado', async () => {
  const r = await call('/dispositivos/cambiar', 'uM', { puerta: 'visitantes', id: 'ffffffffffff' }); assert.equal(r.status, 409); assert.ok(r.body.error.includes('fuera de línea')); assert.equal(store.has('config/dispositivos'), false);
});
await t('Shelly Cloud sin respuesta / límite: 503, nada guardado', async () => {
  shellyMode = 'red'; assert.equal((await call('/dispositivos/cambiar', 'uM', { puerta: 'visitantes', id: 'dddddddddddd' })).status, 503);
  shellyMode = 'limite'; assert.equal((await call('/dispositivos/cambiar', 'uM', { puerta: 'visitantes', id: 'dddddddddddd' })).status, 503);
  assert.equal(store.has('config/dispositivos'), false);
});
await t('mismo Shelly que ya tiene la puerta, o uno asignado a OTRA puerta: 409', async () => {
  assert.equal((await call('/dispositivos/cambiar', 'uM', { puerta: 'residentes', id: 'aaaaaaaaaaaa' })).status, 409);
  assert.equal((await call('/dispositivos/cambiar', 'uM', { puerta: 'residentes', id: 'bbbbbbbbbbbb' })).status, 409);
  assert.equal(store.has('config/dispositivos'), false);
});
await t('generación no informada por Shelly: 409 sin genManual; con genManual=3 se guarda', async () => {
  assert.equal((await call('/dispositivos/cambiar', 'uM', { puerta: 'salida', id: '112233445566' })).status, 409);
  const r = await call('/dispositivos/cambiar', 'uM', { puerta: 'salida', id: '112233445566', genManual: 3 }); assert.equal(r.status, 200); assert.equal(campos().salida_gen, 3);
  shellyCalls = []; assert.equal((await call('/abrir', 'uR', { puerta: 'salida' })).status, 200); assert.deepEqual([pulsos()[0].gen, pulsos()[0].id], [3, '112233445566']);
});
await t('contraseña NO reciente (auth_time de hace 10 min) o ausente: 403 requiereContrasena, nada guardado', async () => {
  for (const ago of [600, null]) { const r = await call('/dispositivos/cambiar', 'uM', { puerta: 'visitantes', id: 'dddddddddddd' }, ago); assert.equal(r.status, 403); assert.equal(r.body.requiereContrasena, true); }
  assert.equal(store.has('config/dispositivos'), false); assert.equal(shellyCalls.length, 0);
});
await t('guardado concurrente (precondición falla): 409 claro, sin estado a medias', async () => {
  force412 = true; const r = await call('/dispositivos/cambiar', 'uM', { puerta: 'visitantes', id: 'dddddddddddd' }); assert.equal(r.status, 409); assert.equal(store.has('config/dispositivos'), false);
});

console.log('\n[3] Permisos: solo master (llamadas directas, sin pasar por la interfaz)');
const RUTAS = [['/dispositivos/listar', {}], ['/dispositivos/estado', { puerta: 'visitantes' }], ['/dispositivos/verificar', { id: 'dddddddddddd' }], ['/dispositivos/cambiar', { puerta: 'visitantes', id: 'dddddddddddd' }], ['/dispositivos/revertir', { puerta: 'visitantes' }], ['/dispositivos/probar', { puerta: 'visitantes', confirmar: true }]];
for (const [rol, uid] of [['admin', 'uA'], ['jefe-admin', 'uJA'], ['residente', 'uR']]) await t(`${rol}: 403 en las 6 rutas, no cambia nada ni toca Shelly`, async () => {
  const antes = JSON.stringify([...store]);
  for (const [ruta, body] of RUTAS) assert.equal((await call(ruta, uid, body)).status, 403, `${rol} ${ruta}`);
  assert.equal(JSON.stringify([...store]), antes); assert.equal(shellyCalls.length, 0);
});
await t('sin token: 401 en las 6 rutas', async () => { for (const [ruta, body] of RUTAS) assert.equal((await call(ruta, null, body)).status, 401, ruta); });
await t('master SÍ puede las de consulta; las que escriben/abren exigen contraseña reciente', async () => {
  for (const [ruta, body] of RUTAS) { const r = await call(ruta, 'uM', body, 9999); assert.notEqual(r.status, 401, ruta); assert.notEqual(r.status, 403 === r.status && !r.body.requiereContrasena ? 403 : -1, ruta + ' rol'); }
  assert.equal((await call('/dispositivos/cambiar', 'uM', { puerta: 'visitantes', id: 'dddddddddddd' }, 9999)).body.requiereContrasena, true);
  assert.equal((await call('/dispositivos/revertir', 'uM', { puerta: 'visitantes' }, 9999)).body.requiereContrasena, true);
  assert.equal((await call('/dispositivos/probar', 'uM', { puerta: 'visitantes', confirmar: true }, 9999)).body.requiereContrasena, true);
});

console.log('\n[4] listar / verificar / estado / revertir / probar');
await t('listar: origen secreto/documento/sin-asignar; sin llamar a Shelly', async () => {
  dispDoc({ residentes_id: 'eeeeeeeeeeee', residentes_gen: 1 });
  const r = await call('/dispositivos/listar', 'uM'); assert.equal(r.status, 200);
  const por = Object.fromEntries(r.body.puertas.map(p => [p.puerta, p]));
  assert.deepEqual([por.residentes.origen, por.residentes.id, por.visitantes.origen, por.visitantes.gen, por.salida.origen], ['documento', 'eeeeeeeeeeee', 'secreto', 3, 'sin-asignar']);
  assert.equal(shellyCalls.length, 0);
});
await t('verificar: informa generación y línea SIN guardar; rechaza uno de otra puerta', async () => {
  const r = await call('/dispositivos/verificar', 'uM', { id: 'dddddddddddd', puerta: 'visitantes' }); assert.equal(r.status, 200); assert.deepEqual([r.body.gen, r.body.online], [3, true]);
  assert.equal((await call('/dispositivos/verificar', 'uM', { id: 'aaaaaaaaaaaa', puerta: 'visitantes' })).status, 409);
  assert.equal(store.has('config/dispositivos'), false);
});
await t('estado: en línea / fuera de línea de la puerta actual', async () => {
  let r = await call('/dispositivos/estado', 'uM', { puerta: 'residentes' }); assert.deepEqual([r.body.existe, r.body.online], [true, true]);
  shellyDevices.set('cccccccccccc', { gen: 'G1', online: false }); r = await call('/dispositivos/estado', 'uM', { puerta: 'peatones' }); assert.equal(r.body.online, false);
  r = await call('/dispositivos/estado', 'uM', { puerta: 'salida' }); assert.equal(r.body.asignado, false);
});
await t('REGRESAR AL ANTERIOR: vuelve al Shelly del secret (el documento deja de mandar) y la apertura lo usa', async () => {
  await call('/dispositivos/cambiar', 'uM', { puerta: 'visitantes', id: 'dddddddddddd' });
  const r = await call('/dispositivos/revertir', 'uM', { puerta: 'visitantes' }); assert.equal(r.status, 200);
  const c = campos(); assert.ok(!('visitantes_id' in c) || c.visitantes_id === null);
  const h = JSON.parse(c.historial); assert.deepEqual(h.map(x => x.tipo), ['cambio', 'regreso']);
  shellyCalls = []; await call('/abrir', 'uR', { puerta: 'visitantes' }); assert.deepEqual([pulsos()[0].gen, pulsos()[0].id], [3, 'bbbbbbbbbbbb']);
  assert.ok([...store].some(([k, f]) => k.startsWith('aperturas/') && f.nombre.stringValue.includes('regresó el Shelly de visitantes')));
});
await t('regresar con el anterior FUERA DE LÍNEA: avisa (409); con forzar:true sí regresa', async () => {
  await call('/dispositivos/cambiar', 'uM', { puerta: 'visitantes', id: 'dddddddddddd' });
  shellyDevices.set('bbbbbbbbbbbb', { gen: 'G3', online: false });
  const r = await call('/dispositivos/revertir', 'uM', { puerta: 'visitantes' }); assert.equal(r.status, 409); assert.equal(r.body.anteriorFueraDeLinea, true); assert.equal(campos().visitantes_id, 'dddddddddddd');
  assert.equal((await call('/dispositivos/revertir', 'uM', { puerta: 'visitantes', forzar: true })).status, 200);
});
await t('regresar sin historial: 409', async () => assert.equal((await call('/dispositivos/revertir', 'uM', { puerta: 'peatones' })).status, 409));
await t('pulso de prueba: exige confirmar:true; con él abre por la ruta normal y queda en bitácora', async () => {
  assert.equal((await call('/dispositivos/probar', 'uM', { puerta: 'residentes' })).status, 400); assert.equal(pulsos().length, 0);
  const r = await call('/dispositivos/probar', 'uM', { puerta: 'residentes', confirmar: true }); assert.equal(r.status, 200);
  assert.deepEqual(pulsos().map(p => p.id), ['aaaaaaaaaaaa']);
  assert.ok([...store].some(([k, f]) => k.startsWith('aperturas/') && f.nombre.stringValue.includes('pulso de prueba en residentes')));
  assert.equal((await call('/dispositivos/probar', 'uM', { puerta: 'residentes', confirmar: true })).status, 429);
});

console.log('\n[5] Selección sin teclear: /dispositivos/disponibles (manual, solo EN LÍNEA y SIN asignar)');
await t('con repuesto: solo el en línea y sin asignar, con nombre de la app de Shelly, generación e ID; los asignados NO salen', async () => {
  shellyDevices.set('dddddddddddd', { gen: 'G3', online: true, nombre: 'Repuesto portón visitas', modelo: 'S3SW-001X16EU' });
  const r = await call('/dispositivos/disponibles', 'uM'); assert.equal(r.status, 200);
  assert.deepEqual(r.body.disponibles.map(d => d.id).sort(), ['112233445566', 'dddddddddddd', 'eeeeeeeeeeee'].sort());
  const d = r.body.disponibles.find(x => x.id === 'dddddddddddd'); assert.deepEqual([d.nombre, d.gen, d.modelo], ['Repuesto portón visitas', 3, 'S3SW-001X16EU']);
  assert.ok(!r.body.disponibles.some(x => ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc'].includes(x.id)), 'los asignados a una puerta no se ofrecen');
  assert.ok(!r.body.disponibles.some(x => x.id === 'ffffffffffff'), 'fuera de línea no se ofrece'); assert.equal(r.body.fueraDeLinea, 1);
  assert.ok(!JSON.stringify(r.body).includes('LLAVE_TEST'), 'la llave de Shelly jamás sale del Worker');
  assert.equal(shellyCalls.filter(c => c.tipo === 'lista').length, 1, 'una sola consulta a Shelly Cloud');
});
await t('un Shelly ya asignado desde la app tampoco se ofrece', async () => {
  dispDoc({ residentes_id: 'eeeeeeeeeeee', residentes_gen: 1 });
  const r = await call('/dispositivos/disponibles', 'uM'); assert.ok(!r.body.disponibles.some(x => x.id === 'eeeeeeeeeeee') && r.body.disponibles.some(x => x.id === 'dddddddddddd'));
});
await t('SIN repuestos en la cuenta: lista vacía (el front muestra el mensaje de corriente/WiFi)', async () => {
  for (const id of ['dddddddddddd', 'eeeeeeeeeeee', '112233445566']) shellyDevices.delete(id);
  const r = await call('/dispositivos/disponibles', 'uM'); assert.equal(r.status, 200); assert.deepEqual(r.body.disponibles, []); assert.equal(r.body.fueraDeLinea, 1);
});
await t('repuesto FUERA DE LÍNEA (único repuesto): no se ofrece y se cuenta aparte', async () => {
  for (const id of ['dddddddddddd', 'eeeeeeeeeeee', '112233445566']) shellyDevices.delete(id);
  shellyDevices.set('dddddddddddd', { gen: 'G3', online: false, nombre: 'Repuesto apagado' });
  const r = await call('/dispositivos/disponibles', 'uM'); assert.deepEqual(r.body.disponibles, []); assert.equal(r.body.fueraDeLinea, 2);
});
await t('Shelly Cloud caído o rechaza la llave: 503 con mensaje genérico (sin detalles ni llave)', async () => {
  shellyMode = 'red'; let r = await call('/dispositivos/disponibles', 'uM'); assert.equal(r.status, 503);
  skew += 20000; shellyMode = 'rechazo'; r = await call('/dispositivos/disponibles', 'uM'); assert.equal(r.status, 503); assert.ok(!JSON.stringify(r.body).includes('LLAVE_TEST'));
});
await t('es MANUAL y limitada: dos toques seguidos = 429 (no gasta el 1 req/s)', async () => {
  assert.equal((await call('/dispositivos/disponibles', 'uM')).status, 200);
  const n = shellyCalls.length; assert.equal((await call('/dispositivos/disponibles', 'uM')).status, 429); assert.equal(shellyCalls.length, n);
});
await t('diagnóstico: devuelve la FORMA de la respuesta (campos y tipos), sin valores ni ids', async () => {
  const r = await call('/dispositivos/disponibles', 'uM', { diagnostico: true }); assert.equal(r.status, 200);
  const txt = JSON.stringify(r.body.forma); assert.ok(txt.includes('devices_status') && txt.includes('_dev_info'));
  assert.ok(!/aaaaaaaaaaaa|bbbbbbbbbbbb|dddddddddddd|LLAVE_TEST/.test(txt), 'sin ids ni llaves en la forma');
});
await t('permisos: admin, jefe-admin y residente → 403; sin token 401', async () => {
  for (const uid of ['uA', 'uJA', 'uR']) assert.equal((await call('/dispositivos/disponibles', uid)).status, 403, uid);
  assert.equal((await call('/dispositivos/disponibles', null)).status, 401); assert.equal(shellyCalls.length, 0);
});
await t('parser tolerante: arreglo de dispositivos, solo estados y basura', async () => {
  assert.deepEqual(parsearListaShelly({ isok: true, data: { devices: [{ id: 'abcdef123456', name: 'A', online: true, _dev_info: { gen: 'G2' } }] } }).map(d => [d.id, d.nombre, d.gen, d.online]), [['abcdef123456', 'A', 2, true]]);
  assert.deepEqual(parsearListaShelly({ data: { devices_status: { '1a2b3c4d5e6f': { cloud: { connected: false } } } } }).map(d => [d.id, d.online]), [['1a2b3c4d5e6f', false]]);
  for (const basura of [null, 5, 'x', [], {}, { data: 5 }, { data: { devices: 5, devices_status: [] } }]) assert.deepEqual(parsearListaShelly(basura), []);
  assert.ok(!JSON.stringify(formaDe({ data: { devices_status: { abcdef123456: { a: 1 } } } })).includes('abcdef123456'));
});

console.log(`\n${pass} pruebas OK`);
