// Pruebas de "casa de prueba": solo master la marca (vía Worker), queda FUERA de cobranza, morosidad,
// recordatorios, aviso de pago, conteos y quórum, y SIGUE funcionando normal (puertas, Siri, suspensión
// manual, revocación). Ejecutar:  node test/casa-prueba.test.mjs
// Worker REAL + Firestore EN MEMORIA + Shelly/FCM/Auth SIMULADOS (hosts ficticios, sin red ni llaves reales).
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSign } from 'node:crypto';
import worker from '../worker.js';

const dir = mkdtempSync(join(tmpdir(), 'mqcp-')); const sh = c => execSync(c, { cwd: dir, stdio: 'pipe' });
sh('openssl genrsa -out k.pem 2048'); sh('openssl pkcs8 -topk8 -nocrypt -in k.pem -out k8.pem'); sh('openssl req -new -x509 -key k.pem -out cert.pem -days 2 -subj "/CN=t"');
const KEY8 = readFileSync(join(dir, 'k8.pem'), 'utf8'), CERT = readFileSync(join(dir, 'cert.pem'), 'utf8');
const PROJ = 'proyecto-prueba';
const RealNow = Date.now.bind(Date); let fakeNow = null;
Date.now = () => fakeNow ?? RealNow();
const b64u = b => Buffer.from(b).toString('base64url');
const idToken = uid => {
  const h = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
  const p = b64u(JSON.stringify({ aud: PROJ, iss: `https://securetoken.google.com/${PROJ}`, sub: uid, user_id: uid, exp: Math.floor(RealNow() / 1000) + 3e7 }));
  return `${h}.${p}.${createSign('RSA-SHA256').update(`${h}.${p}`).sign(KEY8, 'base64url')}`;
};

// ---------- Firestore en memoria (GET/PATCH/POST/DELETE, :commit, :runQuery, transacciones) ----------
const store = new Map(); let fcm = []; const pulsos = [];
const fv = v => v === null ? { nullValue: null } : typeof v === 'string' ? { stringValue: v } : typeof v === 'boolean' ? { booleanValue: v }
  : typeof v === 'number' ? { integerValue: String(v) } : { timestampValue: v.__ts };
const put = (path, o) => store.set(path, Object.fromEntries(Object.entries(o).map(([k, v]) => [k, fv(v)])));
const val = f => f && ('stringValue' in f ? f.stringValue : 'booleanValue' in f ? f.booleanValue : 'integerValue' in f ? +f.integerValue : 'timestampValue' in f ? f.timestampValue : null);
const leer = path => { const f = store.get(path); return f ? Object.fromEntries(Object.entries(f).map(([k, v]) => [k, val(v)])) : null; };
const base = `/v1/projects/${PROJ}/databases/(default)/documents`;
const docOut = (path, fields) => ({ name: `projects/${PROJ}/databases/(default)/documents/${path}`, fields, updateTime: new Date().toISOString() });
const pathDeNombre = n => n.split('/documents/')[1];
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url)); const m = opts.method || 'GET';
  const R = (body, status = 200) => new Response(JSON.stringify(body), { status });
  if (u.hostname === 'oauth2.googleapis.com') return R({ access_token: 'tok' });
  if (u.hostname === 'www.googleapis.com') return new Response(JSON.stringify({ k1: CERT }), { status: 200, headers: { 'cache-control': 'max-age=3600' } });
  if (u.hostname === 'fcm.googleapis.com') { const msg = JSON.parse(opts.body).message; fcm.push({ token: msg.token, ...msg.notification }); return R({}); }
  if (u.hostname === 'identitytoolkit.googleapis.com') {
    const b = JSON.parse(opts.body || '{}');
    return R(u.pathname.endsWith('accounts:lookup') ? { users: [{ localId: b.localId[0], disabled: false }] } : {});
  }
  if (u.hostname === 'shelly.test') { pulsos.push(new URLSearchParams(String(opts.body)).get('id')); return new Response(JSON.stringify({ isok: true })); }
  if (u.hostname !== 'firestore.googleapis.com') throw new Error('red inesperada: ' + u.hostname);
  const p = decodeURIComponent(u.pathname);
  if (p.endsWith(':beginTransaction')) return R({ transaction: 'tx' + Math.random() });
  if (p.endsWith(':rollback')) return R({});
  if (p.endsWith(':commit')) {
    const { writes } = JSON.parse(opts.body);
    for (const w of writes) {
      const path = pathDeNombre(w.update.name);
      if (w.currentDocument?.exists === false && store.has(path)) return R({ error: { status: 'ALREADY_EXISTS' } }, 409);
      if (w.currentDocument?.exists === true && !store.has(path)) return R({ error: { status: 'NOT_FOUND' } }, 404);
    }
    const writeResults = [];
    for (const w of writes) {
      const path = pathDeNombre(w.update.name); const mask = w.updateMask?.fieldPaths;
      if (mask) { const cur = { ...(store.get(path) || {}) }; mask.forEach(k => { if (w.update.fields[k]) cur[k] = w.update.fields[k]; }); store.set(path, cur); }
      else store.set(path, w.update.fields);
      // updateTransforms (increment) — lo usa el folio de recibos
      const transformResults = (w.updateTransforms || []).map(tr => {
        const cur = store.get(path); const n = (+(cur[tr.fieldPath]?.integerValue || 0)) + (+tr.increment.integerValue);
        cur[tr.fieldPath] = { integerValue: String(n) }; return { integerValue: String(n) };
      });
      writeResults.push(transformResults.length ? { transformResults } : {});
    }
    return R({ writeResults });
  }
  if (p.endsWith(':runQuery')) {
    const q = JSON.parse(opts.body).structuredQuery; const col = q.from[0].collectionId, ff = q.where?.fieldFilter;
    const rows = [...store].filter(([k]) => k.startsWith(col + '/') && !k.slice(col.length + 1).includes('/'))
      .filter(([, f]) => !ff || val(f[ff.field.fieldPath]) === val(ff.value)).map(([k, f]) => ({ document: docOut(k, f) }));
    return R(rows.length ? rows : [{ readTime: new Date().toISOString() }]);
  }
  const path = p.slice(base.length + 1);
  if (m === 'GET') {
    if (path.split('/').length % 2 === 0) { const f = store.get(path); return f ? R(docOut(path, f)) : R({}, 404); }
    return R({ documents: [...store].filter(([k]) => k.startsWith(path + '/') && !k.slice(path.length + 1).includes('/')).map(([k, f]) => docOut(k, f)) });
  }
  if (m === 'DELETE') { store.delete(path); return R({}); }
  if (m === 'PATCH') {
    const body = JSON.parse(opts.body); const mask = u.searchParams.getAll('updateMask.fieldPaths');
    if (u.searchParams.get('currentDocument.exists') === 'true' && !store.has(path)) return R({}, 404);
    if (mask.length) { const cur = { ...(store.get(path) || {}) }; mask.forEach(k => { if (body.fields[k]) cur[k] = body.fields[k]; }); store.set(path, cur); }
    else store.set(path, body.fields);
    return R({});
  }
  if (m === 'POST') { store.set(`${path}/auto${store.size}${Math.random().toString(36).slice(2, 6)}`, JSON.parse(opts.body).fields); return R({}); }
  throw new Error('método ' + m);
};
console.error = () => {};
const env = {
  FIREBASE_PROJECT: PROJ, SA_EMAIL: 'sa@test', SA_PRIVATE_KEY: KEY8, ALLOWED_ORIGIN: 'https://x',
  SHELLY_GATE_ENABLED: '0', SHELLY_HOST: 'https://shelly.test', SHELLY_AUTH_KEY: 'clave-shelly-prueba',
  SHELLY_DEVICES: JSON.stringify({ residentes: 'dev-residentes', visitantes: 'dev-visitantes', salida: 'dev-salida' }),
};
const call = async (ruta, uid, body = {}) => {
  const headers = { 'Content-Type': 'application/json' }; if (uid) headers.Authorization = 'Bearer ' + idToken(uid);
  const r = await worker.fetch(new Request('https://w' + ruta, { method: 'POST', headers, body: JSON.stringify(body) }), env);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const voz = async llave => {
  const req = new Request('https://w/abrir-voz', { method: 'POST', headers: { 'CF-Connecting-IP': '198.51.100.9', Authorization: 'Bearer ' + llave } });
  Object.defineProperty(req, 'cf', { value: { country: 'MX' } });
  const r = await worker.fetch(req, env); return { status: r.status, texto: await r.text() };
};
const cron = async (fecha) => {
  fakeNow = Date.parse(fecha + 'T16:00:00Z'); const ps = [];
  await worker.scheduled({}, env, { waitUntil: p => ps.push(p) }); await Promise.all(ps);
};
const hoy = fecha => { fakeNow = Date.parse(fecha + 'T19:00:00Z'); };   // mediodía en Hermosillo

// ---------- padrón: 4 casas reales (1 al corriente, 2 deben, 1 suspendida) + la casa 9 que será de prueba ----------
const jefe = (id, nom, dom, uid, extra = {}) => put(`personas/${id}`, { nombre: nom, rol: 'residente', estado: 'activo', uid, domicilio: dom,
  domicilioNorm: dom.toUpperCase(), jefeId: null, telefono: '66200000' + id.slice(-2).padStart(2, '0'), creadoEn: { __ts: '2026-10-01T00:00:00Z' }, ...extra });
const usuario = (uid, o) => put(`usuarios/${uid}`, { estado: 'activo', suspendido: false, jefeId: '', ...o });
const reset = () => {
  store.clear(); fcm = []; pulsos.length = 0; fakeNow = null;
  put('config/cobranza', { cuotaMensual: 350, fechaInicioCobro: { __ts: '2026-11-01T07:00:00.000Z' } });
  usuario('uM', { nombre: 'McRub', rol: 'master' });
  usuario('uA', { nombre: 'Miguel', rol: 'admin' });
  usuario('uJA', { nombre: 'Jefa Admin', rol: 'residente', esAdmin: true, casa: 'Casa 8', personaId: 'pers-000008' });
  jefe('pers-000008', 'Jefa Admin', 'Casa 8', 'uJA', { esAdmin: true });
  for (const n of [1, 2, 3]) { jefe(`pers-00000${n}`, `Vecino ${n}`, `Casa ${n}`, `u${n}`); usuario(`u${n}`, { nombre: `Vecino ${n}`, rol: 'residente', casa: `Casa ${n}`, personaId: `pers-00000${n}`, fcmToken: `tok${n}` }); }
  jefe('pers-000004', 'Vecino 4', 'Casa 4', 'u4', { estado: 'suspendido' }); usuario('u4', { nombre: 'Vecino 4', rol: 'residente', casa: 'Casa 4', personaId: 'pers-000004', estado: 'suspendido', suspendido: true });
  put('finanzas/f2', { tipo: 'ingreso', categoria: 'Cuota', casa: 'Casa 2', monto: 350, ts: { __ts: '2026-11-20T18:00:00Z' } });
  put('finanzas/f8', { tipo: 'ingreso', categoria: 'Cuota', casa: 'Casa 8', monto: 350, ts: { __ts: '2026-11-20T18:00:00Z' } });
  jefe('pers-000009', 'R Acosta Pruebas', 'Casa de pruebas — Diagonal Catorce', 'u9');
  usuario('u9', { nombre: 'R Acosta Pruebas', rol: 'residente', casa: 'Casa de pruebas — Diagonal Catorce', personaId: 'pers-000009', fcmToken: 'tok9' });
  put('personas/pers-fam-001', { nombre: 'Hija de Uno', rol: 'residente', estado: 'activo', uid: 'uF', domicilio: '', jefeId: 'pers-000001' });
};
const DOM9 = 'Casa de pruebas — Diagonal Catorce';
const marcar = async () => { const r = await call('/personas/casa-prueba', 'uM', { id: 'pers-000009', casaPrueba: true }); assert.equal(r.status, 200, JSON.stringify(r.body)); };
let pass = 0; const t = async (n, fn) => { reset(); await fn(); pass++; console.log('  ok -', n); };

console.log('\n[1] quién puede poner la marca');
await t('master marca y desmarca; queda en personas/{id} y en la bitácora', async () => {
  await marcar();
  assert.equal(leer('personas/pers-000009').casaPrueba, true);
  assert.ok([...store].some(([k, f]) => k.startsWith('aperturas/') && val(f.tipo) === 'gestion' && /CASA DE PRUEBA/.test(val(f.nombre) || '')), 'bitácora');
  assert.equal((await call('/personas/casa-prueba', 'uM', { id: 'pers-000009', casaPrueba: false })).status, 200);
  assert.equal(leer('personas/pers-000009').casaPrueba, false);
});
await t('NADIE más la pone: admin, jefe-admin, el propio residente, sin sesión → rechazado y sin cambios', async () => {
  for (const uid of ['uA', 'uJA', 'u9', 'u1', 'uF']) {
    const r = await call('/personas/casa-prueba', uid, { id: 'pers-000009', casaPrueba: true });
    assert.equal(r.status, 403, uid);
  }
  assert.equal((await call('/personas/casa-prueba', 'uJA', { id: 'pers-000008', casaPrueba: true })).status, 403, 'jefe-admin sobre su propia casa');
  assert.equal((await call('/personas/casa-prueba', null, { id: 'pers-000009', casaPrueba: true })).status, 401);
  assert.equal(leer('personas/pers-000009').casaPrueba, undefined); assert.equal(leer('personas/pers-000008').casaPrueba, undefined);
});
await t('solo sobre un jefe de familia y con true/false', async () => {
  assert.equal((await call('/personas/casa-prueba', 'uM', { id: 'pers-fam-001', casaPrueba: true })).status, 400, 'familiar');
  assert.equal((await call('/personas/casa-prueba', 'uM', { id: 'pers-000009', casaPrueba: 'si' })).status, 400, 'no booleano');
  assert.equal((await call('/personas/casa-prueba', 'uM', { id: 'no-existe-123', casaPrueba: true })).status, 404);
  assert.equal(leer('personas/pers-fam-001').casaPrueba, undefined);
});
await t('ninguna otra ruta la escribe (alta y edición ignoran casaPrueba del cuerpo)', async () => {
  const c = await call('/personas/crear', 'uA', { nombre: 'Nuevo', telefono: '6621112233', domicilio: 'Casa 77', rol: 'residente', casaPrueba: true });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(leer(`personas/${c.body.id}`).casaPrueba, undefined);
  const e = await call('/personas/actualizar', 'uA', { id: 'pers-000001', nombre: 'Vecino Uno', casaPrueba: true });
  assert.equal(e.status, 200, JSON.stringify(e.body));
  assert.equal(leer('personas/pers-000001').casaPrueba, undefined);
});

console.log('\n[2] fuera de cobranza, morosidad, recordatorios, conteos y quórum');
await t('/finanzas/resumen: el total de casas no la cuenta', async () => {
  hoy('2026-12-02');
  const antes = (await call('/finanzas/resumen', 'uA')).body.totalCasas;
  await marcar();
  const despues = (await call('/finanzas/resumen', 'uA')).body.totalCasas;
  assert.equal(antes, 6); assert.equal(despues, 5);
});
await t('/finanzas/cobranza: no aparece en ninguna lista y no cuenta en el total', async () => {
  hoy('2026-12-02'); await marcar();
  const r = (await call('/finanzas/cobranza', 'uA')).body;
  assert.ok(![...r.pagaron, ...r.sinPago].some(c => c.domicilio === DOM9));
  assert.ok(r.sinPago.some(c => c.domicilio === 'Casa 1'), 'las casas reales con adeudo siguen ahí');
  assert.equal(r.totalCasas, 5);
});
await t('/personas/listar: casasActivas no la cuenta y la fila lleva casaPrueba (etiqueta PRUEBA)', async () => {
  const antes = (await call('/personas/listar', 'uA')).body.casasActivas;
  await marcar();
  const r = (await call('/personas/listar', 'uA')).body;
  assert.equal(antes, 5); assert.equal(r.casasActivas, 4);
  assert.equal(r.personas.find(p => p.id === 'pers-000009').casaPrueba, true);
  assert.equal(r.personas.find(p => p.id === 'pers-000001').casaPrueba, false);
});
await t('morosidad automática (cron día 5): la casa de prueba con "adeudo" NO se suspende; una real sí', async () => {
  await marcar();
  const sim = (await call('/admin/probar-suspension-automatica', 'uM', { modo: 'simular' })).body;
  assert.ok(sim.suspendidas && !JSON.stringify(sim.suspendidas).includes(DOM9), 'simulación');
  await cron('2026-12-05');
  assert.equal(leer('personas/pers-000009').estado, 'activo');
  assert.equal(leer('personas/pers-000001').estado, 'suspendido', 'la real con adeudo sí');
});
await t('recordatorios de pago (cron días 1 y 3) y su simulación: no le llegan', async () => {
  await marcar();
  const sim = (await call('/admin/simular-recordatorio-pago', 'uM', { fecha: '2026-12-01' })).body;
  assert.ok(sim.casas.some(c => c.id === 'pers-000001') && !sim.casas.some(c => c.id === 'pers-000009'));
  await cron('2026-12-01');
  const toks = fcm.map(f => f.token);
  assert.ok(toks.includes('tok1') && !toks.includes('tok9'), JSON.stringify(toks));
});
await t('aviso de pago (días 1-4) y estado de cuenta: nunca adeudo para la casa de prueba', async () => {
  hoy('2026-12-02'); await marcar();
  assert.equal((await call('/cobranza/aviso-pago', 'u9')).body.mostrar, false);
  assert.equal((await call('/cobranza/aviso-pago', 'u1')).body.mostrar, true, 'una real con adeudo sí');
  const e9 = (await call('/finanzas/estado-cuenta', 'u9')).body;
  assert.ok(e9.adeudo === 0 && e9.alCorriente === true && e9.casaPrueba === true && e9.avisoCorte === null, JSON.stringify(e9));
  assert.ok((await call('/finanzas/estado-cuenta', 'u1')).body.adeudo > 0);
});
await t('pagos: no se registran ingresos a la casa de prueba (la caja no se ensucia)', async () => {
  await marcar();
  const r = await call('/finanzas/registrar', 'uA', { tipo: 'ingreso', concepto: 'Cuota', categoria: 'Cuota', monto: 350, casa: DOM9 });
  assert.equal(r.status, 400); assert.match(r.body.error, /casa de prueba/);
  { const ok = await call('/finanzas/registrar', 'uA', { tipo: 'ingreso', concepto: 'Cuota', categoria: 'Cuota', monto: 350, casa: 'Casa 3' }); assert.equal(ok.status, 200, JSON.stringify(ok.body)); }
});
await t('votaciones: el quórum no la cuenta y la casa de prueba no vota; las reales sí', async () => {
  await marcar();
  const cierra = new Date(Date.now() + 3 * 864e5).toISOString();
  const v = await call('/votaciones/crear', 'uA', { titulo: 'Prueba', descripcion: 'x', opciones: ['Sí', 'No'], cierraAt: cierra });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  const vid = [...store.keys()].find(k => /^votaciones\/[^/]+$/.test(k));
  assert.equal(leer(vid).totalCasasSnapshot, 4, 'casas activas reales: 1, 2, 3 y 8');
  const r9 = await call('/votaciones/votar', 'u9', { opcion: 'op1' });
  assert.equal(r9.status, 403); assert.match(r9.body.error, /casas de prueba no votan/);
  assert.equal((await call('/votaciones/votar', 'u1', { opcion: 'op1' })).status, 200);
  assert.equal(leer(vid).participaronCount, 1);
});
await t('llaves de voz (Gestión): su casa sale con la marca de prueba', async () => {
  await marcar();
  assert.equal((await call('/voz/llaves/crear', 'u9', { dispositivo: 'iPhone de pruebas' })).status, 200);
  assert.equal((await call('/voz/llaves/crear', 'u1', { dispositivo: 'iPhone de Uno' })).status, 200);
  const r = (await call('/voz/llaves/listar', 'uA')).body;
  assert.equal(r.casas.find(c => c.casa === DOM9).casaPrueba, true);
  assert.equal(r.casas.find(c => c.casa === 'Casa 1').casaPrueba, false);
});

console.log('\n[3] funciona normal para todo lo demás');
await t('abre puertas desde la app y con Siri, y recibe el aviso de Siri', async () => {
  await marcar();
  const a = await call('/abrir', 'u9', { puerta: 'residentes' });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const k = (await call('/voz/llaves/crear', 'u9', { dispositivo: 'iPhone de pruebas' })).body.llave;
  const v = await voz(k);
  assert.equal(v.status, 200, v.texto);
  assert.deepEqual(pulsos, ['dev-residentes', 'dev-residentes']);
  assert.ok(fcm.some(f => f.token === 'tok9' && /abierta por voz/.test(f.title)), 'aviso push de Siri');
});
await t('sigue sujeta a suspensión MANUAL (no abre) y a revocación de su llave', async () => {
  await marcar();
  const k = (await call('/voz/llaves/crear', 'u9', { dispositivo: 'iPhone de pruebas' })).body;
  const s = await call('/personas/suspender', 'uA', { id: 'pers-000009', motivo: 'prueba de suspensión' });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(leer('personas/pers-000009').estado, 'suspendido');
  assert.equal((await call('/abrir', 'u9', { puerta: 'residentes' })).status, 403);
  assert.equal((await voz(k.llave)).texto, 'Acceso suspendido');
  assert.equal((await call('/personas/reactivar', 'uA', { id: 'pers-000009' })).status, 200);
  assert.equal((await voz(k.llave)).status, 200, 'reactivada abre');
  assert.equal((await call('/voz/llaves/revocar', 'uA', { id: k.id })).status, 200);
  fakeNow = Date.now() + 20e3;
  assert.equal((await voz(k.llave)).texto, 'Llave no válida');
  assert.equal(pulsos.length, 1, 'solo abrió la vez que estaba activa');
});

console.log('\n[4] reglas y app');
await t('firestore.rules: personas cerrada al cliente; usuarios solo deja tocar fcmToken', async () => {
  const r = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  assert.match(r, /match \/personas\/\{id\} \{\s*allow read, write: if false;\s*\}/);
  assert.match(r, /match \/usuarios\/\{uid\}[\s\S]*?allow update: if signedIn\(\) && request\.auth\.uid == uid\s*&& request\.resource\.data\.diff\(resource\.data\)\.affectedKeys\(\)\.hasOnly\(\['fcmToken'\]\);/);
  assert.ok(!/document=\*\*/.test(r), 'sin comodines que abran otras rutas');
});
await t('app: etiqueta PRUEBA en el padrón; el botón para marcarla solo lo ve el master', async () => {
  const src = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const ini = src.indexOf('function personaRow(p){'); const fin = src.indexOf('\n}\n', ini) + 2;
  const fn = new Function('ME', 'esc', 'alertaFamActiva', src.slice(ini, fin) + '\nreturn personaRow;');
  const esc = s => String(s ?? '');
  const p9 = { id: 'pers-000009', nombre: 'R Acosta Pruebas', domicilio: DOM9, rol: 'residente', estado: 'activo', casaPrueba: true, registrado: true };
  const p1 = { ...p9, id: 'pers-000001', nombre: 'Vecino 1', domicilio: 'Casa 1', casaPrueba: false };
  const comoMaster = fn({ rol: 'master', uid: 'uM' }, esc, () => null), comoAdmin = fn({ rol: 'admin', uid: 'uA' }, esc, () => null);
  assert.match(comoMaster(p9), /class="tag prueba">PRUEBA</); assert.match(comoAdmin(p9), /class="tag prueba">PRUEBA</);
  assert.doesNotMatch(comoAdmin(p1), /PRUEBA/);
  assert.match(comoMaster(p9), /data-act="casa-prueba"[^>]*>Quitar PRUEBA</); assert.match(comoMaster(p1), /data-act="casa-prueba"[^>]*>🧪 Casa de prueba</);
  assert.doesNotMatch(comoAdmin(p9), /data-act="casa-prueba"/, 'admin no ve el botón');
});

console.log(`\n${pass} pruebas de casa de prueba OK`);
