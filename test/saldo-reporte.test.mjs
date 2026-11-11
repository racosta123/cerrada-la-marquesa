// Pruebas de (1) saldo ACUMULADO en /finanzas/resumen (saldo inicial del mes = cierre del anterior,
// guardado en saldos/{YYYY-MM} solo por el Worker e invalidado al cancelar/corregir/reactivar meses
// cerrados) y (2) /aperturas/reporte (solo staff, rango y registros topados).
// Ejecutar:  node test/saldo-reporte.test.mjs
// Worker REAL + Firestore EN MEMORIA (con filtros compuestos, rangos, orderBy y limit) + Auth simulado.
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSign } from 'node:crypto';
import worker from '../worker.js';

const dir = mkdtempSync(join(tmpdir(), 'mqsr-')); const sh = c => execSync(c, { cwd: dir, stdio: 'pipe' });
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

// ---------- Firestore en memoria ----------
const store = new Map(); let lecturasFin = 0; let queries = [];
const fv = v => v === null ? { nullValue: null } : typeof v === 'string' ? { stringValue: v } : typeof v === 'boolean' ? { booleanValue: v }
  : typeof v === 'number' ? { doubleValue: v } : { timestampValue: v.__ts };
const put = (path, o) => store.set(path, Object.fromEntries(Object.entries(o).map(([k, v]) => [k, fv(v)])));
const val = f => f && ('stringValue' in f ? f.stringValue : 'booleanValue' in f ? f.booleanValue : 'integerValue' in f ? +f.integerValue
  : 'doubleValue' in f ? +f.doubleValue : 'timestampValue' in f ? Date.parse(f.timestampValue) : null);
const leer = path => { const f = store.get(path); return f ? Object.fromEntries(Object.entries(f).map(([k, v]) => [k, val(v)])) : null; };
const base = `/v1/projects/${PROJ}/databases/(default)/documents`;
const docOut = (path, fields) => ({ name: `projects/${PROJ}/databases/(default)/documents/${path}`, fields, updateTime: new Date().toISOString() });
const pathDeNombre = n => n.split('/documents/')[1];
const hijos = col => [...store].filter(([k]) => k.startsWith(col + '/') && !k.slice(col.length + 1).includes('/'));
const OPS = { EQUAL: (a, b) => a === b, GREATER_THAN_OR_EQUAL: (a, b) => a >= b, LESS_THAN: (a, b) => a < b };
const cumple = (f, w) => {
  if (!w) return true;
  if (w.compositeFilter) return w.compositeFilter.filters.every(x => cumple(f, x));
  const ff = w.fieldFilter; const a = val(f[ff.field.fieldPath]);
  return a != null && OPS[ff.op](a, val(ff.value));
};
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url)); const m = opts.method || 'GET';
  const R = (body, status = 200) => new Response(JSON.stringify(body), { status });
  if (u.hostname === 'oauth2.googleapis.com') return R({ access_token: 'tok' });
  if (u.hostname === 'www.googleapis.com') return new Response(JSON.stringify({ k1: CERT }), { status: 200, headers: { 'cache-control': 'max-age=3600' } });
  if (u.hostname !== 'firestore.googleapis.com') throw new Error('red inesperada: ' + u.hostname);
  const p = decodeURIComponent(u.pathname);
  if (p.endsWith(':beginTransaction')) return R({ transaction: 'tx' + Math.random() });
  if (p.endsWith(':rollback')) return R({});
  if (p.endsWith(':commit')) {
    const { writes } = JSON.parse(opts.body);
    for (const w of writes) {
      if (w.delete) continue;
      const path = pathDeNombre(w.update.name);
      if (w.currentDocument?.exists === false && store.has(path)) return R({ error: { status: 'ALREADY_EXISTS' } }, 409);
      if (w.currentDocument?.exists === true && !store.has(path)) return R({ error: { status: 'NOT_FOUND' } }, 404);
    }
    for (const w of writes) {
      if (w.delete) { store.delete(pathDeNombre(w.delete)); continue; }
      const path = pathDeNombre(w.update.name); const mask = w.updateMask?.fieldPaths;
      if (mask) { const cur = { ...(store.get(path) || {}) }; mask.forEach(k => { if (w.update.fields[k]) cur[k] = w.update.fields[k]; else delete cur[k]; }); store.set(path, cur); }
      else store.set(path, w.update.fields);
      for (const tr of w.updateTransforms || []) {
        const cur = store.get(path); cur[tr.fieldPath] = { integerValue: String((+(cur[tr.fieldPath]?.integerValue || 0)) + (+tr.increment.integerValue)) };
      }
    }
    return R({ writeResults: writes.map(() => ({})) });
  }
  if (p.endsWith(':runQuery')) {
    const q = JSON.parse(opts.body).structuredQuery; const col = q.from[0].collectionId; queries.push(q);
    let rows = hijos(col).filter(([, f]) => cumple(f, q.where));
    const ob = q.orderBy?.[0];
    if (ob) rows.sort((a, b) => (val(a[1][ob.field.fieldPath]) - val(b[1][ob.field.fieldPath])) * (ob.direction === 'DESCENDING' ? -1 : 1));
    if (q.limit) rows = rows.slice(0, q.limit);
    if (col === 'finanzas') lecturasFin += rows.length;
    rows = rows.map(([k, f]) => ({ document: docOut(k, f) }));
    return R(rows.length ? rows : [{ readTime: new Date().toISOString() }]);
  }
  const path = p.slice(base.length + 1);
  if (m === 'GET') {
    if (path.split('/').length % 2 === 0) { const f = store.get(path); return f ? R(docOut(path, f)) : R({}, 404); }
    const docs = hijos(path); if (path === 'finanzas') lecturasFin += docs.length;
    return R({ documents: docs.map(([k, f]) => docOut(k, f)) });
  }
  if (m === 'PATCH') { store.set(path, JSON.parse(opts.body).fields); return R({}); }
  if (m === 'POST') { store.set(`${path}/auto${store.size}${Math.random().toString(36).slice(2, 6)}`, JSON.parse(opts.body).fields); return R({}); }
  throw new Error('método ' + m);
};
console.error = () => {};
const env = { FIREBASE_PROJECT: PROJ, SA_EMAIL: 'sa@test', SA_PRIVATE_KEY: KEY8, ALLOWED_ORIGIN: 'https://x' };
const call = async (ruta, uid, body = {}) => {
  const headers = { 'Content-Type': 'application/json' }; if (uid) headers.Authorization = 'Bearer ' + idToken(uid);
  const r = await worker.fetch(new Request('https://w' + ruta, { method: 'POST', headers, body: JSON.stringify(body) }), env);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const hoy = iso => { fakeNow = Date.parse(iso); };
const mov = (id, tipo, monto, ts, extra = {}) => put(`finanzas/${id}`, { tipo, monto, categoria: tipo === 'ingreso' ? 'Cuota' : 'Luz', casa: tipo === 'ingreso' ? 'Casa 1' : '', concepto: 'x', ts: { __ts: ts }, ...extra });
const usuario = (uid, o) => put(`usuarios/${uid}`, { estado: 'activo', ...o });
const reset = () => {
  store.clear(); lecturasFin = 0; queries = []; fakeNow = null;
  usuario('uM', { nombre: 'McRub', rol: 'master' });
  usuario('uA', { nombre: 'Miguel', rol: 'admin' });
  usuario('uJA', { nombre: 'Jefa Admin', rol: 'residente', esAdmin: true, casa: 'Casa 8' });
  usuario('uJS', { nombre: 'Jefe Admin suspendido', rol: 'residente', esAdmin: true, estado: 'suspendido', casa: 'Casa 7' });
  usuario('u1', { nombre: 'Vecino 1', rol: 'residente', casa: 'Casa 1', personaId: 'pers-000001' });
  usuario('u2', { nombre: 'Vecino 2', rol: 'residente', casa: 'Casa 2', personaId: 'pers-000002' });
  put('personas/pers-000001', { nombre: 'Vecino 1', rol: 'residente', estado: 'activo', uid: 'u1', domicilio: 'Casa 1', domicilioNorm: 'CASA 1', jefeId: null });
  put('personas/pers-000002', { nombre: 'Vecino 2', rol: 'residente', estado: 'activo', uid: 'u2', domicilio: 'Casa 2', domicilioNorm: 'CASA 2', jefeId: null });
  put('personas/pers-fam-001', { nombre: 'Hija de Uno', rol: 'residente', estado: 'activo', uid: 'uF', domicilio: '', jefeId: 'pers-000001' });
  put('personas/pers-sin-cta', { nombre: 'Sin Cuenta', rol: 'residente', estado: 'activo', domicilio: 'Casa 3', jefeId: null });
};
let pass = 0; const t = async (n, fn) => { reset(); await fn(); pass++; console.log('  ok -', n); };

// Historia: septiembre +1000 −200 (cancelado −999 no cuenta), octubre +500 −300, noviembre (en curso) +350 −50.
const historia = () => {
  mov('s1', 'ingreso', 1000, '2026-09-10T18:00:00Z'); mov('s2', 'egreso', 200, '2026-09-15T18:00:00Z');
  mov('s3', 'egreso', 999, '2026-09-16T18:00:00Z', { estado: 'cancelado' });
  mov('o1', 'ingreso', 500, '2026-10-05T18:00:00Z'); mov('o2', 'egreso', 300, '2026-10-20T18:00:00Z');
  // 31-oct 23:30 Hermosillo = 1-nov 06:30 UTC: es de OCTUBRE (UTC-7), no de noviembre.
  mov('o3', 'ingreso', 10, '2026-11-01T06:30:00Z');
  mov('n1', 'ingreso', 350, '2026-11-03T18:00:00Z'); mov('n2', 'egreso', 50, '2026-11-04T18:00:00Z');
};

console.log('\n[1] saldo acumulado en /finanzas/resumen');
await t('saldo inicial = cierre de octubre; saldo actual = inicial + cobrado − gastado (Hermosillo, sin cancelados)', async () => {
  historia(); hoy('2026-11-11T19:00:00Z');
  const r = await call('/finanzas/resumen', 'u2');   // un residente normal ve el saldo acumulado
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mes, '2026-11');
  assert.equal(r.body.saldoInicial, 1000 - 200 + 500 - 300 + 10);   // 1010
  assert.equal(r.body.ingreso, 350); assert.equal(r.body.egreso, 50); assert.equal(r.body.balance, 300);
  assert.equal(r.body.saldoActual, 1310);
  assert.equal(leer('saldos/2026-09').cierre, 800);
  assert.equal(leer('saldos/2026-10').cierre, 1010);
  assert.equal(leer('saldos/2026-11'), null, 'el mes en curso nunca se guarda');
});
await t('la segunda carga NO relee la historia: solo el mes en curso', async () => {
  historia(); hoy('2026-11-11T19:00:00Z');
  await call('/finanzas/resumen', 'u2');
  lecturasFin = 0;
  const r = await call('/finanzas/resumen', 'u2');
  assert.equal(r.body.saldoActual, 1310);
  assert.equal(lecturasFin, 2, 'solo n1 y n2');
});
await t('al cambiar de mes el saldo NO regresa a cero (diciembre abre con el cierre de noviembre)', async () => {
  historia(); hoy('2026-11-11T19:00:00Z'); await call('/finanzas/resumen', 'u2');
  hoy('2026-12-01T08:00:00Z');   // 1-dic 01:00 Hermosillo
  const r = await call('/finanzas/resumen', 'u2');
  assert.equal(r.body.saldoInicial, 1310); assert.equal(r.body.ingreso, 0); assert.equal(r.body.saldoActual, 1310);
  assert.equal(leer('saldos/2026-11').cierre, 1310);
});
await t('mes con huecos y sin movimientos: cero y cierres continuos', async () => {
  hoy('2026-11-11T19:00:00Z');
  let r = await call('/finanzas/resumen', 'u2');
  assert.equal(r.body.saldoInicial, 0); assert.equal(r.body.saldoActual, 0);
  reset(); mov('j1', 'ingreso', 100, '2026-07-10T18:00:00Z'); hoy('2026-11-11T19:00:00Z');
  r = await call('/finanzas/resumen', 'u2');
  assert.equal(r.body.saldoInicial, 100);
  for (const ym of ['2026-07', '2026-08', '2026-09', '2026-10']) assert.equal(leer(`saldos/${ym}`).cierre, 100);
});
await t('cancelar un movimiento de un mes cerrado invalida y recalcula el saldo', async () => {
  historia(); mov('octubre-gasto-largo', 'egreso', 100, '2026-10-25T18:00:00Z');   // id largo: pasa ID_MOV_RE
  hoy('2026-11-11T19:00:00Z');
  let r = await call('/finanzas/resumen', 'u2');
  assert.equal(r.body.saldoInicial, 910);
  const c2 = await call('/finanzas/cancelar', 'uM', { id: 'octubre-gasto-largo', motivo: 'error de captura' });
  assert.equal(c2.status, 200, JSON.stringify(c2.body));
  assert.equal(leer('saldos/2026-10'), null, 'se borró en la misma transacción');
  assert.equal(leer('saldos/2026-09').cierre, 800, 'meses anteriores intactos');
  r = await call('/finanzas/resumen', 'u2');
  assert.equal(r.body.saldoInicial, 1010); assert.equal(r.body.saldoActual, 1310);
  // reactivar (solo master) lo vuelve a contar
  const re = await call('/finanzas/reactivar', 'uM', { id: 'octubre-gasto-largo', motivo: 'sí era válido' });
  assert.equal(re.status, 200, JSON.stringify(re.body));
  r = await call('/finanzas/resumen', 'u2');
  assert.equal(r.body.saldoInicial, 910);
});
await t('corregir un movimiento de un mes cerrado también recalcula; uno del mes en curso no toca saldos', async () => {
  historia(); mov('octubre-luz-0001', 'egreso', 100, '2026-10-25T18:00:00Z'); mov('noviembre-luz-01', 'egreso', 20, '2026-11-05T18:00:00Z');
  hoy('2026-11-11T19:00:00Z'); await call('/finanzas/resumen', 'u2');
  const c = await call('/finanzas/corregir', 'uM', { id: 'octubre-luz-0001', motivo: 'monto mal capturado', tipo: 'egreso', concepto: 'Luz', categoria: 'Luz', monto: 40 });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  let r = await call('/finanzas/resumen', 'u2');
  assert.equal(r.body.saldoInicial, 970);
  const antes = leer('saldos/2026-10');
  const c2 = await call('/finanzas/cancelar', 'uM', { id: 'noviembre-luz-01', motivo: 'duplicado xx' });
  assert.equal(c2.status, 200);
  assert.deepEqual(leer('saldos/2026-10'), antes);
  r = await call('/finanzas/resumen', 'u2');
  assert.equal(r.body.saldoActual, 970 + 350 - 50);
});
await t('reglas: el cliente no tiene acceso a "saldos" (sin match = negado)', async () => {
  const reglas = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  assert.ok(!/match\s+\/saldos/.test(reglas));
  assert.ok(!/\{document=\*\*\}|\{path=\*\*\}/.test(reglas), 'sin comodín que lo abra');
});

console.log('\n[2] /aperturas/reporte');
const ap = (id, uid, ts, extra = {}) => put(`aperturas/${id}`, { uid, nombre: 'n', puerta: 'residentes', hogar: uid, tipo: 'app', resultado: 'ok', ts: { __ts: ts }, ...extra });
await t('staff (master, admin, jefe-admin) obtiene conteo y detalle del rango, solo de esa persona', async () => {
  ap('a1', 'u1', '2026-11-02T07:30:00Z');                                       // 2-nov 00:30 Hermosillo: entra
  ap('a2', 'u1', '2026-11-02T06:59:00Z');                                       // 1-nov 23:59 Hermosillo: fuera
  ap('a3', 'u1', '2026-11-05T18:00:00Z', { resultado: 'error', motivo: 'suspendido', puerta: 'visitantes' });
  ap('a4', 'u1', '2026-11-06T18:00:00Z', { via: 'voz', puerta: 'peatones' });
  ap('a5', 'u1', '2026-11-08T06:59:00Z');                                       // 7-nov 23:59 Hermosillo: entra (hasta incluido)
  ap('a6', 'u1', '2026-11-08T07:00:00Z');                                       // 8-nov 00:00: fuera
  ap('a7', 'u2', '2026-11-03T18:00:00Z');                                       // otra persona
  ap('a8', 'u1', '2026-11-03T18:00:00Z', { tipo: 'gestion', puerta: 'gestion' }); // no es apertura
  for (const uid of ['uM', 'uA', 'uJA']) {
    const r = await call('/aperturas/reporte', uid, { personaId: 'pers-000001', desde: '2026-11-02', hasta: '2026-11-07' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.total, 4); assert.equal(r.body.exitosas, 3); assert.equal(r.body.fallidas, 1);
    assert.equal(r.body.persona.nombre, 'Vecino 1'); assert.equal(r.body.persona.domicilio, 'Casa 1');
    assert.deepEqual(r.body.registros.map(x => x.puerta), ['residentes', 'peatones', 'visitantes', 'residentes']);   // más reciente primero
    assert.equal(r.body.registros[1].via, 'Siri'); assert.equal(r.body.registros[2].motivo, 'suspendido');
    assert.equal(r.body.truncado, false);
  }
});
await t('residente normal → 403 (aunque pida su propio reporte o el de otro); jefe-admin suspendido → 403; sin token → 401', async () => {
  ap('a1', 'u1', '2026-11-03T18:00:00Z');
  const body = { personaId: 'pers-000001', desde: '2026-11-01', hasta: '2026-11-10' };
  assert.equal((await call('/aperturas/reporte', 'u2', body)).status, 403);
  assert.equal((await call('/aperturas/reporte', 'u1', body)).status, 403);
  assert.equal((await call('/aperturas/reporte', 'uJS', body)).status, 403);
  assert.equal((await call('/aperturas/reporte', 'uNoExiste', body)).status, 403);
  assert.equal((await call('/aperturas/reporte', null, body)).status, 401);
  assert.equal(queries.filter(q => q.from[0].collectionId === 'aperturas').length, 0, 'ni una consulta a la bitácora');
});
await t('topes: rango máximo 92 días, fechas inválidas, y máximo 500 registros por consulta', async () => {
  const q = b => call('/aperturas/reporte', 'uA', { personaId: 'pers-000001', ...b });
  assert.equal((await q({ desde: '2026-01-01', hasta: '2026-11-10' })).status, 400);
  assert.equal((await q({ desde: '2026-08-11', hasta: '2026-11-10' })).status, 200);   // 92 días
  assert.equal((await q({ desde: '2026-08-10', hasta: '2026-11-10' })).status, 400);   // 93
  assert.equal((await q({ desde: '2026-11-10', hasta: '2026-11-01' })).status, 400);
  assert.equal((await q({ desde: '2026-02-31', hasta: '2026-03-02' })).status, 400);
  assert.equal((await q({ desde: 'ayer', hasta: '2026-03-02' })).status, 400);
  assert.equal((await call('/aperturas/reporte', 'uA', { personaId: '../usuarios/uM', desde: '2026-11-01', hasta: '2026-11-02' })).status, 400);
  assert.equal((await call('/aperturas/reporte', 'uA', { personaId: 'no-existe', desde: '2026-11-01', hasta: '2026-11-02' })).status, 404);
  for (let i = 0; i < 520; i++) ap(`m${i}`, 'u1', new Date(Date.parse('2026-11-03T18:00:00Z') + i * 60000).toISOString());
  queries = [];
  const r = await q({ desde: '2026-11-01', hasta: '2026-11-10' });
  assert.equal(r.body.total, 500); assert.equal(r.body.truncado, true);
  assert.equal(queries[0].limit, 501);
});
await t('familiar: domicilio heredado del jefe; persona sin cuenta → 0 sin consultar la bitácora', async () => {
  ap('f1', 'uF', '2026-11-03T18:00:00Z');
  let r = await call('/aperturas/reporte', 'uM', { personaId: 'pers-fam-001', desde: '2026-11-01', hasta: '2026-11-10' });
  assert.equal(r.body.total, 1); assert.equal(r.body.persona.domicilio, 'Casa 1');
  queries = [];
  r = await call('/aperturas/reporte', 'uM', { personaId: 'pers-sin-cta', desde: '2026-11-01', hasta: '2026-11-10' });
  assert.equal(r.status, 200); assert.equal(r.body.total, 0); assert.equal(r.body.persona.registrado, false);
  assert.equal(queries.length, 0);
});
await t('el índice compuesto uid + tipo + ts está declarado', async () => {
  const idx = JSON.parse(readFileSync(new URL('../firestore.indexes.json', import.meta.url), 'utf8')).indexes;
  assert.ok(idx.some(i => i.collectionGroup === 'aperturas' && i.fields.map(f => f.fieldPath).join() === 'uid,tipo,ts'));
});

console.log(`\n${pass} pruebas OK`);
