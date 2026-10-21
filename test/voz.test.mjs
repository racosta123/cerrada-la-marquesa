// Pruebas de "Abrir con Siri": llaves de voz (/voz/llaves/*), /abrir-voz y /config/voz.
// Ejecutar: node test/voz.test.mjs  (Worker real, Firestore en memoria, Shelly simulado, sin red)
// Importa el Worker REAL con fetch simulado: Firestore es un almacén EN MEMORIA, Google Auth se
// firma con llaves RSA generadas aquí (openssl, solo para la prueba). Ninguna puerta real se abre.
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSign, createHash } from 'node:crypto';

// ---------- todo lo que el Worker escriba en consola se guarda para revisar que no salga la llave ----------
const consola = [];
for (const k of ['log', 'error', 'warn', 'info', 'debug']) console[k] = (...a) => consola.push(a.map(String).join(' '));
const mostrar = (...a) => process.stdout.write(a.join(' ') + '\n');

const worker = (await import('../worker.js')).default;

// ---------- llaves de prueba ----------
const dir = mkdtempSync(join(tmpdir(), 'mq-voz-'));
const sh = c => execSync(c, { cwd: dir, stdio: 'pipe' });
sh('openssl genrsa -out k.pem 2048');
sh('openssl pkcs8 -topk8 -nocrypt -in k.pem -out k8.pem');
sh('openssl req -new -x509 -key k.pem -out cert.pem -days 2 -subj "/CN=test"');
const KEY8 = readFileSync(join(dir, 'k8.pem'), 'utf8');
const CERT = readFileSync(join(dir, 'cert.pem'), 'utf8');
const b64u = b => Buffer.from(b).toString('base64url');
const PROJ = 'proyecto-prueba';
const idToken = uid => {
  const h = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
  const p = b64u(JSON.stringify({ aud: PROJ, iss: `https://securetoken.google.com/${PROJ}`, sub: uid, user_id: uid, exp: Math.floor(Date.now() / 1000) + 600 }));
  return `${h}.${p}.${createSign('RSA-SHA256').update(`${h}.${p}`).sign(KEY8, 'base64url')}`;
};

// ---------- Firestore en memoria (GET/PATCH/POST/DELETE, :commit, :runQuery, transacciones) ----------
const store = new Map();   // 'coleccion/id' -> fields
const fv = v => v === null ? { nullValue: null } : typeof v === 'string' ? { stringValue: v }
  : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? { integerValue: String(v) } : (() => { throw new Error('tipo'); })();
const F = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, fv(v)]));
const put = (path, o) => store.set(path, F(o));
const val = f => f && ('stringValue' in f ? f.stringValue : 'booleanValue' in f ? f.booleanValue : 'integerValue' in f ? +f.integerValue : 'timestampValue' in f ? f.timestampValue : null);
const leer = path => { const f = store.get(path); return f ? Object.fromEntries(Object.entries(f).map(([k, v]) => [k, val(v)])) : null; };
const base = `/v1/projects/${PROJ}/databases/(default)/documents`;
const docOut = (path, fields) => ({ name: `projects/${PROJ}/databases/(default)/documents/${path}`, fields, updateTime: new Date().toISOString() });
const pathDeNombre = n => n.split('/documents/')[1];
const authUsers = new Map();   // uid -> { disabled }
const shellyPulsos = [];
const pushes = [];                    // avisos FCM que mandó el Worker: { token, title, body }
const fcm = { falla: false };         // true = FCM responde 500
let llamadasFirestore = 0;
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url)); const m = opts.method || 'GET';
  const R = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
  if (u.hostname === 'oauth2.googleapis.com') return R({ access_token: 'tok' });
  if (u.hostname === 'www.googleapis.com') return R({ k1: CERT }, 200, { 'cache-control': 'max-age=3600' });
  if (u.hostname === 'fcm.googleapis.com') {
    if (fcm.falla) return R({ error: { status: 'INTERNAL' } }, 500);
    const msg = JSON.parse(opts.body).message;
    pushes.push({ token: msg.token, ...msg.notification });
    return R({});
  }
  if (u.hostname === 'firestore.googleapis.com') llamadasFirestore++;
  if (u.hostname === 'identitytoolkit.googleapis.com') {
    const b = JSON.parse(opts.body || '{}');
    if (u.pathname.endsWith('accounts:lookup')) { const a = authUsers.get(b.localId[0]); return R(a ? { users: [{ localId: b.localId[0], disabled: !!a.disabled }] } : {}); }
    return R({});
  }
  if (u.hostname === 'shelly.test') {
    if (u.pathname === '/device/relay/control') { shellyPulsos.push(new URLSearchParams(String(opts.body)).get('id')); return new Response(JSON.stringify({ isok: true })); }
    throw new Error('shelly ruta ' + u.pathname);
  }
  if (u.hostname !== 'firestore.googleapis.com') throw new Error('red inesperada: ' + u.hostname);
  const p = decodeURIComponent(u.pathname);
  if (p.endsWith(':beginTransaction')) return R({ transaction: 'tx' + Math.random() });
  if (p.endsWith(':rollback')) return R({});
  if (p.endsWith(':commit')) {
    const { writes } = JSON.parse(opts.body);
    for (const w of writes) {   // validación previa: el commit es todo o nada
      const path = pathDeNombre(w.update.name);
      if (w.currentDocument?.exists === false && store.has(path)) return R({ error: { status: 'ALREADY_EXISTS' } }, 409);
      if (w.currentDocument?.exists === true && !store.has(path)) return R({ error: { status: 'NOT_FOUND' } }, 404);
    }
    for (const w of writes) {
      const path = pathDeNombre(w.update.name);
      const mask = w.updateMask?.fieldPaths;
      if (mask) { const cur = { ...(store.get(path) || {}) }; mask.forEach(k => { if (w.update.fields[k]) cur[k] = w.update.fields[k]; }); store.set(path, cur); }
      else store.set(path, w.update.fields);
    }
    return R({ writeResults: writes.map(() => ({})) });
  }
  if (p.endsWith(':runQuery')) {
    const q = JSON.parse(opts.body).structuredQuery;
    const col = q.from[0].collectionId, ff = q.where?.fieldFilter;
    const rows = [...store].filter(([k]) => k.startsWith(col + '/') && !k.slice(col.length + 1).includes('/'))
      .filter(([, f]) => !ff || val(f[ff.field.fieldPath]) === val(ff.value))
      .map(([k, f]) => ({ document: docOut(k, f) }));
    return R(rows.length ? rows : [{ readTime: new Date().toISOString() }]);
  }
  const path = p.slice(base.length + 1);
  if (m === 'GET') {
    if (path.includes('/')) { const f = store.get(path); return f ? R(docOut(path, f)) : R({}, 404); }
    const documents = [...store].filter(([k]) => k.startsWith(path + '/') && !k.slice(path.length + 1).includes('/')).map(([k, f]) => docOut(k, f));
    return R({ documents });
  }
  if (m === 'POST') { const id = 'auto' + store.size + Math.random().toString(36).slice(2, 7); store.set(`${path}/${id}`, JSON.parse(opts.body).fields); return R({}); }
  if (m === 'DELETE') { store.delete(path); return R({}); }
  if (m === 'PATCH') {
    const body = JSON.parse(opts.body); const mask = u.searchParams.getAll('updateMask.fieldPaths');
    if (u.searchParams.get('currentDocument.exists') === 'true' && !store.has(path)) return R({}, 404);
    if (mask.length) { const cur = { ...(store.get(path) || {}) }; mask.forEach(k => { if (body.fields[k]) cur[k] = body.fields[k]; }); store.set(path, cur); }
    else store.set(path, body.fields);
    return R({});
  }
  throw new Error('método ' + m);
};

const env = {
  FIREBASE_PROJECT: PROJ, SA_EMAIL: 'sa@test', SA_PRIVATE_KEY: KEY8, ALLOWED_ORIGIN: 'https://x',
  SHELLY_GATE_ENABLED: '0', SHELLY_HOST: 'https://shelly.test', SHELLY_AUTH_KEY: 'clave-shelly-prueba',
  SHELLY_DEVICES: JSON.stringify({ residentes: 'dev-residentes', visitantes: 'dev-visitantes', salida: 'dev-salida' }),
};
const call = async (ruta, uid, body = {}) => {
  const headers = { 'Content-Type': 'application/json' }; if (uid) headers.Authorization = 'Bearer ' + idToken(uid);
  const r = await worker.fetch(new Request('https://w' + ruta, { method: 'POST', headers, body: JSON.stringify(body) }), env);
  return { status: r.status, body: await r.json().catch(() => ({})), headers: r.headers };
};
// Como lo llama el atajo de Siri: POST con "Authorization: Bearer <llave>", sin pasar por la app.
// pais = lo que Cloudflare pone en req.cf.country (null = petición sin req.cf).
const voz = async (llave, { ip = '198.51.100.10', pais = 'MX', body, metodo = 'POST', query = '' } = {}) => {
  const headers = { 'CF-Connecting-IP': ip };
  if (llave !== undefined) headers.Authorization = 'Bearer ' + llave;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const req = new Request('https://w/abrir-voz' + query, { method: metodo, headers, body: body === undefined || metodo === 'GET' ? undefined : JSON.stringify(body) });
  if (pais !== null) Object.defineProperty(req, 'cf', { value: { country: pais } });
  const r = await worker.fetch(req, env);
  return { status: r.status, texto: await r.text(), tipo: r.headers.get('content-type') };
};
const hashDe = k => createHash('sha256').update(k).digest('base64url');
const aperturasVoz = () => [...store].filter(([k]) => k.startsWith('aperturas/')).map(([, f]) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, val(v)]))).filter(a => a.via === 'voz');
const atrasarUltimaApertura = (llave, segundos) => {
  const f = store.get(`tokensVoz/${hashDe(llave)}`);
  f.ultimaApertura = { timestampValue: new Date(Date.now() - segundos * 1000).toISOString() };
};

// ---------- padrón de prueba ----------
const persona = (id, o) => put(`personas/${id}`, { rol: 'residente', estado: 'activo', ...o });
const usuario = (uid, o) => { put(`usuarios/${uid}`, { rol: 'residente', estado: 'activo', suspendido: false, jefeId: '', ...o }); authUsers.set(uid, { disabled: false }); };
persona('p-ana-000001', { nombre: 'Ana Prueba', domicilio: 'Calle 1 #10', uid: 'u-ana' });
usuario('u-ana', { nombre: 'Ana Prueba', casa: 'Calle 1 #10', personaId: 'p-ana-000001', fcmToken: 'fcm-token-ana' });
persona('p-caro-00001', { nombre: 'Caro Prueba', jefeId: 'p-ana-000001', uid: 'u-caro' });
usuario('u-caro', { nombre: 'Caro Prueba', casa: 'Calle 1 #10', personaId: 'p-caro-00001', jefeId: 'p-ana-000001' });
persona('p-beto-00001', { nombre: 'Beto Prueba', domicilio: 'Calle 2 #5', uid: 'u-beto', estado: 'suspendido', motivoSuspension: 'mora' });
usuario('u-beto', { nombre: 'Beto Prueba', casa: 'Calle 2 #5', personaId: 'p-beto-00001', estado: 'suspendido', suspendido: true });
persona('p-dani-00001', { nombre: 'Dani Prueba', domicilio: 'Calle 3 #7', uid: 'u-dani' });
usuario('u-dani', { nombre: 'Dani Prueba', casa: 'Calle 3 #7', personaId: 'p-dani-00001' });
persona('p-eva-000001', { nombre: 'Eva Prueba', domicilio: 'Calle 4 #2', uid: 'u-eva' });
usuario('u-eva', { nombre: 'Eva Prueba', casa: 'Calle 4 #2', personaId: 'p-eva-000001' });
usuario('u-master', { nombre: 'Master Prueba', rol: 'master', casa: '' });
usuario('u-esclavo', { nombre: 'Esclavo Prueba', rol: 'esclavo', residenteUid: 'u-ana' });

const resultados = [];
const prueba = async (nombre, fn) => {
  try { await fn(); resultados.push(['OK   ', nombre]); }
  catch (e) { resultados.push(['FALLA', nombre + ' — ' + e.message]); }
};
const llaves = {};

// ======================= llaves =======================
await prueba('Generar llave: 32 bytes, se muestra una vez, en Firestore solo el hash', async () => {
  const r = await call('/voz/llaves/crear', 'u-ana', { dispositivo: '  iPhone de <b>Ana</b>  ' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.llave, /^mqvoz_[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(r.body.llave.slice(6), 'base64url').length, 32);
  assert.equal(r.body.id, hashDe(r.body.llave));
  const t = leer(`tokensVoz/${r.body.id}`);
  assert.ok(t && t.uid === 'u-ana' && t.casa === 'Calle 1 #10' && t.dispositivo === 'iPhone de bAna/b' && t.revocada === false && t.creadoEn);
  assert.ok(!JSON.stringify([...store]).includes(r.body.llave), 'la llave en claro no debe estar en ningún documento');
  llaves.ana1 = r.body.llave;
  const mias = await call('/voz/llaves/mias', 'u-ana');
  assert.equal(mias.body.llaves.length, 1);
  assert.ok(!JSON.stringify(mias.body).includes(llaves.ana1), '/mias nunca devuelve la llave');
});
await prueba('Máximo 2 llaves activas por residente (la 3a se rechaza)', async () => {
  const r2 = await call('/voz/llaves/crear', 'u-ana', { dispositivo: 'iPad de Ana' });
  assert.equal(r2.status, 200); llaves.ana2 = r2.body.llave;
  const r3 = await call('/voz/llaves/crear', 'u-ana', { dispositivo: 'Otro' });
  assert.equal(r3.status, 409);
  assert.match(r3.body.error, /2 llaves activas/);
});
await prueba('Solo residentes activos generan llave (suspendido, esclavo y master: no)', async () => {
  assert.equal((await call('/voz/llaves/crear', 'u-beto', { dispositivo: 'iPhone de Beto' })).status, 403);
  assert.equal((await call('/voz/llaves/crear', 'u-esclavo', { dispositivo: 'iPhone' })).status, 403);
  assert.equal((await call('/voz/llaves/crear', 'u-master', { dispositivo: 'iPhone' })).status, 403);
  assert.equal((await call('/voz/llaves/crear', 'u-ana')).status, 400);   // sin nombre de dispositivo
});

// ======================= /abrir-voz =======================
await prueba('Llave válida abre Residentes (texto para Siri) y queda en bitácora "por voz (Siri)"', async () => {
  const antes = shellyPulsos.length;
  const r = await voz(llaves.ana1);
  assert.equal(r.status, 200); assert.equal(r.texto, 'Puerta de residentes abierta');
  assert.match(r.tipo, /^text\/plain/);
  assert.deepEqual(shellyPulsos.slice(antes), ['dev-residentes']);
  const a = aperturasVoz().at(-1);
  assert.ok(a && a.resultado === 'ok' && a.puerta === 'residentes' && a.viaEtiqueta === 'por voz (Siri)' && a.dispositivo === 'iPhone de bAna/b' && a.casa === 'Calle 1 #10' && a.nombre === 'Ana Prueba' && a.hogar === 'u-ana');
  assert.ok(leer(`tokensVoz/${hashDe(llaves.ana1)}`).ultimoUso, 'guarda el último uso');
});
await prueba('Límite: una segunda apertura antes de 10 s responde "Espera un momento" y no abre', async () => {
  const antes = shellyPulsos.length;
  const r = await voz(llaves.ana1);
  assert.equal(r.status, 429); assert.equal(r.texto, 'Espera un momento');
  assert.equal(shellyPulsos.length, antes);
  atrasarUltimaApertura(llaves.ana1, 11);
  const r2 = await voz(llaves.ana1);
  assert.equal(r2.status, 200, 'pasados 10 s vuelve a abrir');
});
await prueba('Límite: máximo 30 por hora por llave', async () => {
  const f = store.get(`tokensVoz/${hashDe(llaves.ana1)}`);
  f.aperturasVentana = { integerValue: '30' };
  f.ventanaInicio = { timestampValue: new Date(Date.now() - 20 * 60e3).toISOString() };
  atrasarUltimaApertura(llaves.ana1, 60);
  const r = await voz(llaves.ana1);
  assert.equal(r.status, 429); assert.equal(r.texto, 'Espera un momento');
  f.ventanaInicio = { timestampValue: new Date(Date.now() - 61 * 60e3).toISOString() };   // pasó la hora
  assert.equal((await voz(llaves.ana1)).status, 200);
});
await prueba('Llave válida pidiendo OTRA puerta se rechaza (cuerpo o ?puerta=) y no abre nada', async () => {
  atrasarUltimaApertura(llaves.ana1, 60);
  const antes = shellyPulsos.length;
  for (const opc of [{ body: { puerta: 'visitantes' } }, { body: { puerta: 'salida' } }, { query: '?puerta=peatones' }]) {
    const r = await voz(llaves.ana1, opc);
    assert.equal(r.status, 403); assert.equal(r.texto, 'Esta llave solo abre la puerta de residentes');
  }
  assert.equal(shellyPulsos.length, antes);
  assert.ok(aperturasVoz().some(a => a.resultado === 'error' && a.motivo === 'puerta_no_permitida'), 'el intento queda en bitácora');
  const ok = await voz(llaves.ana1, { body: { puerta: 'residentes' } });
  assert.equal(ok.status, 200, 'pedir explícitamente Residentes sí abre');
});
await prueba('Llave revocada se rechaza ("Llave no válida")', async () => {
  const r = await call('/voz/llaves/revocar', 'u-ana', { id: hashDe(llaves.ana2) });
  assert.equal(r.status, 200);
  const antes = shellyPulsos.length;
  const v = await voz(llaves.ana2, { ip: '198.51.100.20' });
  assert.equal(v.status, 401); assert.equal(v.texto, 'Llave no válida');
  assert.equal(shellyPulsos.length, antes);
  assert.ok(aperturasVoz().some(a => a.resultado === 'error' && a.motivo === 'llave_revocada'));
});
await prueba('Residente suspendido (por mora o manual) se rechaza ("Acceso suspendido")', async () => {
  const r = await call('/voz/llaves/crear', 'u-dani', { dispositivo: 'iPhone de Dani' });
  llaves.dani = r.body.llave;
  // mora: el cron deja estado/suspendido en padrón y perfil
  put('usuarios/u-dani', { ...leer('usuarios/u-dani'), suspendido: true, estado: 'suspendido' });
  const antes = shellyPulsos.length;
  const v = await voz(llaves.dani);
  assert.equal(v.status, 403); assert.equal(v.texto, 'Acceso suspendido');
  // manual: solo el padrón dice suspendido (índice todavía sin sincronizar) — también se rechaza
  put('usuarios/u-dani', { ...leer('usuarios/u-dani'), suspendido: false, estado: 'activo' });
  put('personas/p-dani-00001', { ...leer('personas/p-dani-00001'), estado: 'suspendido', suspendidoPor: 'individual' });
  const v2 = await voz(llaves.dani);
  assert.equal(v2.status, 403); assert.equal(v2.texto, 'Acceso suspendido');
  assert.equal(shellyPulsos.length, antes);
  assert.ok(aperturasVoz().some(a => a.resultado === 'error' && a.motivo === 'suspendido' && a.nombre.startsWith('Dani')));
});
await prueba('Familiar: abre con su llave y la bitácora lleva "Familiar de" + "por voz (Siri)"', async () => {
  const r = await call('/voz/llaves/crear', 'u-caro', { dispositivo: 'iPhone de Caro' });
  llaves.caro = r.body.llave;
  const v = await voz(llaves.caro);
  assert.equal(v.status, 200);
  const a = aperturasVoz().find(x => x.uid === 'u-caro' && x.resultado === 'ok');
  assert.ok(a && a.familiarDe === 'Ana Prueba' && a.dispositivo === 'iPhone de Caro' && a.casa === 'Calle 1 #10');
});
await prueba('Persona borrada o desactivada: su llave queda inválida (y se revoca sola)', async () => {
  const r = await call('/voz/llaves/crear', 'u-eva', { dispositivo: 'iPhone de Eva' });
  llaves.eva = r.body.llave;
  authUsers.set('u-eva', { disabled: true });          // cuenta deshabilitada (baja)
  const v = await voz(llaves.eva, { ip: '198.51.100.30' });
  assert.equal(v.status, 401); assert.equal(v.texto, 'Llave no válida');
  assert.equal(leer(`tokensVoz/${hashDe(llaves.eva)}`).revocada, true);
  authUsers.set('u-eva', { disabled: false });          // aunque la reactiven, esa llave ya no sirve
  assert.equal((await voz(llaves.eva, { ip: '198.51.100.30' })).status, 401);
  // borrada: sin perfil
  const r2 = await call('/voz/llaves/crear', 'u-caro', { dispositivo: 'iPad de Caro' });
  store.delete('usuarios/u-caro');
  const v2 = await voz(r2.body.llave, { ip: '198.51.100.31' });
  assert.equal(v2.status, 401);
  assert.equal(leer(`tokensVoz/${hashDe(r2.body.llave)}`).revocada, true);
  usuario('u-caro', { nombre: 'Caro Prueba', casa: 'Calle 1 #10', personaId: 'p-caro-00001', jefeId: 'p-ana-000001' });
});
const llaveFalsa = () => 'mqvoz_' + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
await prueba('Candado por IP: 5 llaves inexistentes = 15 min bloqueada para llaves inventadas', async () => {
  const ip = '203.0.113.99';
  for (let i = 0; i < 5; i++) {
    const r = await voz(llaveFalsa(), { ip });
    assert.equal(r.status, 401); assert.equal(r.texto, 'Llave no válida');
  }
  const bloqueada = await voz(llaveFalsa(), { ip });
  assert.equal(bloqueada.status, 429); assert.equal(bloqueada.texto, 'Espera un momento');
  const c = [...store].find(([k]) => k.startsWith('vozCandado/'));
  assert.ok(c && !JSON.stringify(c).includes(ip), 'la IP no se guarda en claro');
  const intentos = [...store].filter(([k]) => k.startsWith('registro_intentos/')).map(([k]) => k).join(' ');
  assert.match(intentos, /voz_llave_invalida/);
  assert.match(intentos, /voz_ip_bloqueada/);
});
await prueba('Corrección 1: una llave VÁLIDA abre aunque su IP esté bloqueada', async () => {
  atrasarUltimaApertura(llaves.ana1, 60);
  const antes = shellyPulsos.length;
  const r = await voz(llaves.ana1, { ip: '203.0.113.99' });   // la IP que quedó bloqueada arriba
  assert.equal(r.status, 200, r.texto); assert.equal(r.texto, 'Puerta de residentes abierta');
  assert.deepEqual(shellyPulsos.slice(antes), ['dev-residentes']);
});
await prueba('Corrección 1: llaves revocadas o de suspendidos NO suman fallos a la IP', async () => {
  const ip = '203.0.113.150';
  const candado = async () => leer(`vozCandado/${createHash('sha256').update('voz-ip|' + ip).digest('base64url')}`);
  for (let i = 0; i < 6; i++) assert.equal((await voz(llaves.ana2, { ip })).status, 401);   // revocada
  for (let i = 0; i < 6; i++) assert.equal((await voz(llaves.dani, { ip })).status, 403);   // suspendido
  assert.equal(await candado(), null, 'no hay candado para esa IP');
  const r = await voz(llaveFalsa(), { ip });
  assert.equal(r.status, 401, 'una llave inventada todavía no está bloqueada en esa IP (sin fallos previos)');
  assert.equal((await candado()).fallidos, 1, 'solo la llave inexistente contó');
});
await prueba('Sin llave, llave mal formada o método GET: "Llave no válida"', async () => {
  assert.equal((await voz(undefined, { ip: '192.0.2.1' })).status, 401);
  assert.equal((await voz('mqvoz_corta', { ip: '192.0.2.2' })).status, 401);
  const g = await voz(llaves.ana1, { metodo: 'GET', ip: '192.0.2.3' });
  assert.equal(g.status, 405);
});
await prueba('Corrección 7: formato inválido se rechaza SIN consultar Firestore', async () => {
  const antes = llamadasFirestore;
  for (const k of [undefined, '', 'basura', 'mqvoz_corta', 'mqvoz_' + 'a'.repeat(44), 'MQVOZ_' + 'a'.repeat(43), llaves.ana1 + ' extra']) {
    const r = await voz(k, { ip: '192.0.2.50' });
    assert.equal(r.status, 401); assert.equal(r.texto, 'Llave no válida');
  }
  assert.equal(llamadasFirestore, antes, 'ninguna llamada a Firestore');
});
await prueba('Corrección 7: la respuesta que entrega la llave lleva Cache-Control: no-store', async () => {
  const r = await call('/voz/llaves/crear', 'u-ana', { dispositivo: 'iPhone nuevo de Ana' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.match(r.body.llave, /^mqvoz_/);
  llaves.ana3 = r.body.llave;
  assert.equal((await call('/voz/llaves/revocar', 'u-ana', { id: hashDe(llaves.ana3) })).status, 200);   // deja a Ana con 1 activa
});

// ======================= correcciones de la auditoría =======================
await prueba('Corrección 4: la bitácora guarda IP y país (MX) de cada apertura por voz', async () => {
  atrasarUltimaApertura(llaves.ana1, 60);
  const r = await voz(llaves.ana1, { ip: '198.51.100.77', pais: 'MX' });
  assert.equal(r.status, 200);
  const a = aperturasVoz().at(-1);
  assert.ok(a.resultado === 'ok' && a.ip === '198.51.100.77' && a.pais === 'MX', JSON.stringify(a));
});
await prueba('Corrección 4: fuera de México (o sin país) se rechaza, no abre y queda como rechazada', async () => {
  for (const [pais, ip] of [['US', '198.51.100.81'], ['XX', '198.51.100.82'], ['T1', '198.51.100.83'], [null, '198.51.100.84']]) {
    atrasarUltimaApertura(llaves.ana1, 60);
    const antes = shellyPulsos.length, pushAntes = pushes.length;
    const r = await voz(llaves.ana1, { ip, pais });
    assert.equal(r.status, 403, `país ${pais}`); assert.equal(r.texto, 'Solo se puede abrir desde México');
    assert.equal(shellyPulsos.length, antes, 'no abre');
    assert.equal(pushes.length, pushAntes, 'no hubo apertura, no hay aviso');
    const a = aperturasVoz().at(-1);
    assert.ok(a.resultado === 'error' && a.motivo === 'pais_no_permitido' && a.ip === ip && (a.pais || '') === (pais || ''), JSON.stringify(a));
  }
  // un país rechazado no gasta el límite de la llave: desde MX abre de inmediato
  atrasarUltimaApertura(llaves.ana1, 60);
  assert.equal((await voz(llaves.ana1)).status, 200);
});
await prueba('Corrección 3: aviso push al dueño en cada apertura por voz; queda "enviado" en la bitácora', async () => {
  atrasarUltimaApertura(llaves.ana1, 60);
  const antes = pushes.length;
  assert.equal((await voz(llaves.ana1)).status, 200);
  const p = pushes.slice(antes);
  assert.equal(p.length, 1);
  assert.equal(p[0].token, 'fcm-token-ana');
  assert.match(p[0].body, /iPhone de bAna\/b/);
  assert.ok(!JSON.stringify(p).includes('mqvoz_'), 'el aviso no lleva la llave');
  assert.equal(aperturasVoz().at(-1).avisoPush, 'enviado');
});
await prueba('Corrección 3: si el aviso push falla, la puerta abre igual y el fallo queda registrado', async () => {
  atrasarUltimaApertura(llaves.ana1, 60);
  fcm.falla = true;
  const antes = shellyPulsos.length;
  try {
    const r = await voz(llaves.ana1);
    assert.equal(r.status, 200); assert.equal(r.texto, 'Puerta de residentes abierta');
  } finally { fcm.falla = false; }
  assert.deepEqual(shellyPulsos.slice(antes), ['dev-residentes']);
  const a = aperturasVoz().at(-1);
  assert.ok(a.resultado === 'ok' && a.avisoPush === 'error_http_500', JSON.stringify(a));
  // sin notificaciones activadas (sin fcmToken): abre y queda "sin_token"
  const c = await call('/voz/llaves/crear', 'u-caro', { dispositivo: 'iPhone 2 de Caro' });
  llaves.caro2 = c.body.llave;
  assert.equal((await voz(llaves.caro2)).status, 200);
  assert.equal(aperturasVoz().at(-1).avisoPush, 'sin_token');
});
await prueba('Corrección 6: familiar con jefe suspendido o de baja NO abre; con jefe activo sí', async () => {
  const ana = leer('personas/p-ana-000001');
  try {
    for (const estado of ['suspendido', 'baja']) {
      put('personas/p-ana-000001', { ...ana, estado });
      atrasarUltimaApertura(llaves.caro2, 60);
      const antes = shellyPulsos.length;
      const r = await voz(llaves.caro2);
      assert.equal(r.status, 403, estado); assert.equal(r.texto, 'Acceso suspendido');
      assert.equal(shellyPulsos.length, antes, 'no abre');
      const a = aperturasVoz().at(-1);
      assert.ok(a.resultado === 'error' && a.motivo === 'jefe_inactivo' && a.uid === 'u-caro', JSON.stringify(a));
    }
    store.delete('personas/p-ana-000001');   // jefe borrado del padrón
    atrasarUltimaApertura(llaves.caro2, 60);
    assert.equal((await voz(llaves.caro2)).status, 403);
  } finally { put('personas/p-ana-000001', ana); }
  atrasarUltimaApertura(llaves.caro2, 60);
  assert.equal((await voz(llaves.caro2)).status, 200, 'jefe activo otra vez: abre');
  assert.equal(leer(`tokensVoz/${hashDe(llaves.caro2)}`).revocada, false, 'suspender al jefe no revoca la llave');
});
await prueba('Corrección 5: wrangler.toml apaga los invocation logs (no se registra la petición con Authorization)', async () => {
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8').replace(/#.*$/gm, '');
  assert.match(toml, /\[observability\]\s*\n\s*enabled\s*=\s*true/);
  assert.match(toml, /\[observability\.logs\]\s*\n\s*invocation_logs\s*=\s*false/);
});
await prueba('Corrección 2 (app): «Mis llaves» en cualquier equipo y para suspendidos; generar solo iPhone activo', async () => {
  const src = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const ini = src.indexOf('const esIPhone = ');
  const fin = src.indexOf('async function abrirVozSheet');
  assert.ok(ini > 0 && fin > ini, 'bloque de voz en app.js');
  const bloque = src.slice(ini, fin);
  const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', UA_ANDROID = 'Mozilla/5.0 (Linux; Android 14)', UA_PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
  const casos = [
    // [rol, suspendido, UA, se ve la sección, se puede generar]
    ['residente', false, UA_IPHONE, true, true],
    ['residente', false, UA_ANDROID, true, false],
    ['residente', false, UA_PC, true, false],
    ['residente', true, UA_IPHONE, true, false],
    ['residente', true, UA_ANDROID, true, false],
    ['master', false, UA_IPHONE, false, false],
    ['esclavo', false, UA_IPHONE, false, false],
  ];
  for (const [rol, susp, ua, seVe, genera] of casos) {
    const el = {}; const $ = sel => (el[sel] ||= { textContent: '', clases: new Set(), classList: { toggle(c, on) { on ? el[sel].clases.add(c) : el[sel].clases.delete(c); }, add(c) { el[sel].clases.add(c); }, remove(c) { el[sel].clases.delete(c); } } });
    const ME = { rol, suspendido: susp, estado: susp ? 'suspendido' : 'activo' };
    const navigator = { userAgent: ua, platform: ua === UA_PC ? 'Win32' : '', maxTouchPoints: 0 };
    const correr = new Function('$', 'ME', 'navigator', `${bloque}\nsetupVoz(); limpiarLlaveMostrada();\nreturn { generar: puedeGenerarVoz() };`);
    const r = correr($, ME, navigator);
    const caso = `${rol}/${susp ? 'suspendido' : 'activo'}/${ua.slice(13, 30)}`;
    assert.equal(!$('#vozSection').clases.has('hidden'), seVe, 'sección ' + caso);
    assert.equal(r.generar, genera, 'generar ' + caso);
    if (seVe) {
      assert.equal(!$('#vozForm').clases.has('hidden'), genera, 'formulario ' + caso);
      assert.equal(!$('#vozNoGenerar').clases.has('hidden'), !genera, 'nota ' + caso);
      if (susp) assert.match($('#vozNoGenerar').textContent, /suspendido.*revocar/);
    }
  }
  assert.match(src, /async function abrirVozSheet\(\)\{\s*if \(!esResidenteVoz\(\)\) return;/, 'la hoja abre para cualquier residente');
});

// ======================= staff y config =======================
await prueba('Gestión: staff ve las llaves activas por casa; un residente no', async () => {
  const r = await call('/voz/llaves/listar', 'u-master');
  assert.equal(r.status, 200);
  const casa1 = r.body.casas.find(c => c.casa === 'Calle 1 #10');
  assert.ok(casa1 && casa1.llaves.some(k => k.dispositivo === 'iPhone de bAna/b') && casa1.llaves.some(k => k.dispositivo === 'iPhone de Caro'));
  assert.ok(!r.body.casas.some(c => c.llaves.some(k => k.id === hashDe(llaves.ana2))), 'las revocadas no salen');
  assert.ok(!JSON.stringify(r.body).includes('mqvoz_'), 'nunca devuelve llaves');
  assert.equal((await call('/voz/llaves/listar', 'u-ana')).status, 403);
});
await prueba('Revocar: un residente no revoca la de otro; staff revoca cualquiera', async () => {
  assert.equal((await call('/voz/llaves/revocar', 'u-dani', { id: hashDe(llaves.caro) })).status, 403);
  assert.equal((await call('/voz/llaves/revocar', 'u-master', { id: hashDe(llaves.caro) })).status, 200);
  assert.equal((await voz(llaves.caro)).texto, 'Llave no válida');
});
await prueba('Link del atajo: solo master lo cambia, solo links de iCloud; todos lo leen', async () => {
  const url = 'https://www.icloud.com/shortcuts/0123456789abcdef0123456789abcdef';
  assert.equal((await call('/config/voz-actualizar', 'u-ana', { atajoUrl: url })).status, 403);
  assert.equal((await call('/config/voz-actualizar', 'u-master', { atajoUrl: 'https://malo.example/x' })).status, 400);
  assert.equal((await call('/config/voz-actualizar', 'u-master', { atajoUrl: url })).status, 200);
  assert.equal((await call('/config/voz', 'u-ana')).body.atajoUrl, url);
});
await prueba('/abrir normal sigue igual (otra puerta con sesión de la app)', async () => {
  const antes = shellyPulsos.length;
  const r = await call('/abrir', 'u-ana', { puerta: 'visitantes' });
  assert.equal(r.status, 200);
  assert.deepEqual(shellyPulsos.slice(antes), ['dev-visitantes']);
});
await prueba('Ningún log del Worker contiene una llave, su hash ni el encabezado Authorization', async () => {
  const todo = consola.join('\n');
  for (const k of Object.values(llaves)) { assert.ok(!todo.includes(k), 'llave en logs'); assert.ok(!todo.includes(hashDe(k)), 'hash en logs'); }
  assert.ok(!/mqvoz_|Bearer /.test(todo), 'rastro de llave o Authorization en logs');
  const enStore = JSON.stringify([...store]);
  for (const k of Object.values(llaves)) assert.ok(!enStore.includes(k), 'llave en Firestore');
});

for (const [r, n] of resultados) mostrar(r, n);
mostrar(`\n${resultados.filter(r => r[0].startsWith('OK')).length}/${resultados.length} pruebas OK`);
if (resultados.some(r => r[0] === 'FALLA')) process.exit(1);
