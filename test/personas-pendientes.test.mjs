// Pruebas de /personas/pendientes, /personas/alta-cancelar, /personas/duplicado-revisar y del
// aviso de duplicados en /personas/crear. Ejecutar:  node test/personas-pendientes.test.mjs
// Importa el Worker REAL con fetch simulado: Firestore es un almacén EN MEMORIA, Google Auth se
// firma con llaves RSA generadas aquí (openssl, solo para la prueba). No toca la red, no usa
// ninguna llave real ni de producción.
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import worker from '../worker.js';

// ---------- llaves de prueba ----------
const dir = mkdtempSync(join(tmpdir(), 'mq-'));
const sh = c => execSync(c, { cwd: dir, stdio: 'pipe' });
sh('openssl genrsa -out k.pem 2048');
sh('openssl pkcs8 -topk8 -nocrypt -in k.pem -out k8.pem');
sh('openssl req -new -x509 -key k.pem -out cert.pem -days 2 -subj "/CN=test"');
const KEY8 = readFileSync(join(dir, 'k8.pem'), 'utf8');
const CERT = readFileSync(join(dir, 'cert.pem'), 'utf8');
const { createSign } = await import('node:crypto');
const b64u = b => Buffer.from(b).toString('base64url');
const PROJ = 'proyecto-prueba';
const idToken = uid => {
  const h = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
  const p = b64u(JSON.stringify({ aud: PROJ, iss: `https://securetoken.google.com/${PROJ}`, sub: uid, user_id: uid, exp: Math.floor(Date.now() / 1000) + 600 }));
  const sig = createSign('RSA-SHA256').update(`${h}.${p}`).sign(KEY8, 'base64url');
  return `${h}.${p}.${sig}`;
};

// ---------- Firestore en memoria ----------
const store = new Map();   // 'coleccion/id' -> fields
const fv = v => v === null ? { nullValue: null } : typeof v === 'string' ? { stringValue: v }
  : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? { integerValue: String(v) }
  : v.__ts ? { timestampValue: v.__ts } : (() => { throw new Error('tipo'); })();
const F = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, fv(v)]));
const put = (path, o) => store.set(path, F(o));
const base = `/v1/projects/${PROJ}/databases/(default)/documents`;
const docOut = (path, fields) => ({ name: `projects/${PROJ}/databases/(default)/documents/${path}`, fields });
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url)); const m = opts.method || 'GET';
  const R = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
  if (u.hostname === 'oauth2.googleapis.com') return R({ access_token: 'tok' });
  if (u.hostname === 'www.googleapis.com') return R({ k1: CERT }, 200, { 'cache-control': 'max-age=3600' });
  if (u.hostname === 'fcm.googleapis.com') return R({});
  if (u.hostname !== 'firestore.googleapis.com') throw new Error('red inesperada: ' + u.hostname);
  const path = decodeURIComponent(u.pathname.slice(base.length + 1));
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
const quietLog = console.error; console.error = () => {};

const env = { FIREBASE_PROJECT: PROJ, SA_EMAIL: 'sa@test', SA_PRIVATE_KEY: KEY8, ALLOWED_ORIGIN: 'https://x' };
const call = async (ruta, uid, body = {}) => {
  const headers = { 'Content-Type': 'application/json' }; if (uid) headers.Authorization = 'Bearer ' + idToken(uid);
  const r = await worker.fetch(new Request('https://w' + ruta, { method: 'POST', headers, body: JSON.stringify(body) }), env);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const ahora = Date.now(), iso = ms => new Date(ahora + ms).toISOString();

// ---------- datos ----------
const reset = () => {
  store.clear();
  // staff y residente con cuenta
  put('usuarios/uM', { nombre: 'McRub', rol: 'master', estado: 'activo' });
  put('usuarios/uA', { nombre: 'Miguel Ojeda', rol: 'admin', estado: 'activo' });
  put('usuarios/uJA', { nombre: 'Jefa Admin', rol: 'residente', esAdmin: true, estado: 'activo', casa: 'Casa 9' });
  put('usuarios/uR', { nombre: 'Rosa Residente', rol: 'residente', estado: 'activo', casa: 'Casa 1' });
  put('personas/pMaster-00001', { nombre: 'McRub', rol: 'master', estado: 'activo', uid: 'uM', telefono: '5500000001', jefeId: null });
  put('personas/pAdmin-000001', { nombre: 'Miguel Ojeda', rol: 'admin', estado: 'activo', uid: 'uA', telefono: '5500000002', jefeId: null });
  put('personas/pJefeAdm-00001', { nombre: 'Jefa Admin', rol: 'residente', esAdmin: true, estado: 'activo', uid: 'uJA', telefono: '5500000003', domicilio: 'Casa 9', domicilioNorm: 'CASA 9', jefeId: null });
  put('personas/pResid-000001', { nombre: 'Rosa Residente', rol: 'residente', estado: 'activo', uid: 'uR', telefono: '5500000004', domicilio: 'Casa 1', domicilioNorm: 'CASA 1', jefeId: null });
  // pendientes
  put('personas/pNorma-0000001', { nombre: 'Norma', rol: 'residente', estado: 'activo', uid: null, telefono: '6621112222', domicilio: 'Casa 2', domicilioNorm: 'CASA 2', jefeId: null, creadoPor: 'uA', creadoEn: { __ts: iso(-3600e3) }, dadoDeAltaNombre: 'Miguel Ojeda' });
  put('personas/pAdminPend-000001', { nombre: 'Nuevo Admin', rol: 'admin', estado: 'activo', uid: null, telefono: '6623334444', domicilio: '', domicilioNorm: '', jefeId: null, creadoPor: 'uM', creadoEn: { __ts: iso(-7200e3) } });
  put('personas/pVencida-00000001', { nombre: 'Vera Vencida', rol: 'residente', estado: 'activo', uid: null, telefono: '6625556666', domicilio: 'Casa 3', domicilioNorm: 'CASA 3', jefeId: null, creadoPor: 'uA', creadoEn: { __ts: iso(-9e8) } });
  put('personas/pConPagos-0000001', { nombre: 'Pablo Pagos', rol: 'residente', estado: 'activo', uid: null, telefono: '6627778888', domicilio: 'Casa 4', domicilioNorm: 'CASA 4', jefeId: null, creadoPor: 'uA', creadoEn: { __ts: iso(-5000e3) } });
  put('personas/pConFam-00000001', { nombre: 'Fabio Familia', rol: 'residente', estado: 'activo', uid: null, telefono: '6629990000', domicilio: 'Casa 5', domicilioNorm: 'CASA 5', jefeId: null, creadoPor: 'uA', creadoEn: { __ts: iso(-4000e3) } });
  put('personas/pFam-000000000001', { nombre: 'Hijo de Fabio', rol: 'residente', estado: 'activo', uid: null, telefono: '6620001111', domicilio: '', jefeId: 'pConFam-00000001', creadoPor: 'uA', creadoEn: { __ts: iso(-3000e3) } });
  put('finanzas/f1', { casa: 'Casa 4', monto: 350 });
  // ligas: Norma viva, Vera vencida
  put('registro_invitaciones/hNorma', { hashToken: 'hNorma', personaId: 'pNorma-0000001', usado: false, creadoPor: 'uA', creadoEn: { __ts: iso(-3000e3) }, expiraEn: { __ts: iso(24 * 3600e3) } });
  put('registro_invitaciones/hVera', { hashToken: 'hVera', personaId: 'pVencida-00000001', usado: false, creadoPor: 'uA', creadoEn: { __ts: iso(-9e8) }, expiraEn: { __ts: iso(-8e8) } });
};

let pass = 0;
const t = async (name, fn) => { reset(); await fn(); pass++; console.log('  ok -', name); };
const STAFF = [['master', 'uM'], ['admin', 'uA'], ['jefe-admin', 'uJA']];

console.log('\n[1] /personas/pendientes');
for (const [rol, uid] of STAFF) await t(`${rol}: ve las altas pendientes con creador, fecha y estado de liga`, async () => {
  const r = await call('/personas/pendientes', uid);
  assert.equal(r.status, 200);
  const ids = r.body.pendientes.map(p => p.id);
  assert.ok(ids.includes('pNorma-0000001') && ids.includes('pAdminPend-000001') && ids.includes('pVencida-00000001'));
  assert.ok(!ids.includes('pFam-000000000001'), 'un familiar no es alta pendiente de staff');
  assert.ok(!ids.includes('pMaster-00001') && !ids.includes('pResid-000001') && !ids.includes('pAdmin-000001'), 'quien ya tiene cuenta no aparece');
  const n = r.body.pendientes.find(p => p.id === 'pNorma-0000001');
  assert.equal(n.creadoPorNombre, 'Miguel Ojeda'); assert.equal(n.liga.estado, 'viva'); assert.ok(n.liga.expiraEn); assert.ok(n.creadoEn);
  assert.equal(r.body.pendientes.find(p => p.id === 'pVencida-00000001').liga.estado, 'vencida');
  assert.equal(r.body.pendientes.find(p => p.id === 'pAdminPend-000001').liga.estado, 'sin-liga');
});
await t('residente: 403 · sin token: 401', async () => {
  assert.equal((await call('/personas/pendientes', 'uR')).status, 403);
  assert.equal((await call('/personas/pendientes', null)).status, 401);
});
await t('no expone teléfono ni correo', async () => {
  const r = await call('/personas/pendientes', 'uA');
  assert.ok(!JSON.stringify(r.body).includes('662'));
});

console.log('\n[2] /personas/alta-cancelar');
for (const [rol, uid] of STAFF) await t(`${rol}: cancela un alta sin cuenta; borra persona + liga, respalda y deja bitácora`, async () => {
  const r = await call('/personas/alta-cancelar', uid, { id: 'pNorma-0000001' });
  assert.equal(r.status, 200);
  assert.ok(!store.has('personas/pNorma-0000001'));
  assert.ok(!store.has('registro_invitaciones/hNorma'));
  assert.ok(store.has('personas_borradas/pNorma-0000001'));
  const log = [...store].filter(([k]) => k.startsWith('aperturas/')).map(([, f]) => f.nombre.stringValue);
  assert.ok(log.some(x => x.includes('canceló el alta de Norma') && x.includes('Casa 2')), log.join('|'));
  const quien = [...store].find(([k, f]) => k.startsWith('aperturas/'))[1].uid.stringValue; assert.equal(quien, uid);
});
await t('residente: 403 y no se borra nada', async () => {
  assert.equal((await call('/personas/alta-cancelar', 'uR', { id: 'pNorma-0000001' })).status, 403);
  assert.ok(store.has('personas/pNorma-0000001'));
  assert.equal((await call('/personas/alta-cancelar', null, { id: 'pNorma-0000001' })).status, 401);
});
await t('persona CON cuenta: 409 (no es alta pendiente)', async () => {
  assert.equal((await call('/personas/alta-cancelar', 'uM', { id: 'pResid-000001' })).status, 409);
  assert.ok(store.has('personas/pResid-000001'));
});
await t('master: 403 aunque lo pida otro master', async () => {
  assert.equal((await call('/personas/alta-cancelar', 'uM', { id: 'pMaster-00001' })).status, 403);
});
await t('con familiares: 409', async () => {
  assert.equal((await call('/personas/alta-cancelar', 'uA', { id: 'pConFam-00000001' })).status, 409);
  assert.ok(store.has('personas/pConFam-00000001'));
});
await t('con pagos: 409', async () => {
  assert.equal((await call('/personas/alta-cancelar', 'uA', { id: 'pConPagos-0000001' })).status, 409);
  assert.ok(store.has('personas/pConPagos-0000001'));
});
await t('admin pendiente: solo master lo cancela (admin y jefe-admin: 403)', async () => {
  assert.equal((await call('/personas/alta-cancelar', 'uA', { id: 'pAdminPend-000001' })).status, 403);
  assert.equal((await call('/personas/alta-cancelar', 'uJA', { id: 'pAdminPend-000001' })).status, 403);
  assert.ok(store.has('personas/pAdminPend-000001'));
  assert.equal((await call('/personas/alta-cancelar', 'uM', { id: 'pAdminPend-000001' })).status, 200);
});
await t('id inválido 400 · inexistente 404', async () => {
  assert.equal((await call('/personas/alta-cancelar', 'uA', { id: '../x' })).status, 400);
  assert.equal((await call('/personas/alta-cancelar', 'uA', { id: 'noExiste-123456' })).status, 404);
});
await t('/personas/borrar sigue siendo SOLO master (admin y jefe-admin: 403)', async () => {
  assert.equal((await call('/personas/borrar', 'uA', { id: 'pNorma-0000001' })).status, 403);
  assert.equal((await call('/personas/borrar', 'uJA', { id: 'pNorma-0000001' })).status, 403);
  assert.equal((await call('/personas/borrar', 'uR', { id: 'pNorma-0000001' })).status, 403);
  assert.ok(store.has('personas/pNorma-0000001'));
});

console.log('\n[3] Alta con teléfono/nombre repetido (/personas/crear)');
await t('teléfono repetido: NO crea, responde 409 con aviso para confirmar', async () => {
  const antes = [...store.keys()].filter(k => k.startsWith('personas/')).length;
  const r = await call('/personas/crear', 'uA', { nombre: 'Otra Persona', telefono: '+52 662 111 2222', domicilio: 'Casa 20', rol: 'residente' });
  assert.equal(r.status, 409); assert.equal(r.body.requiereConfirmacion, true);
  assert.ok(r.body.duplicados[0].includes('Norma') && r.body.duplicados[0].includes('Casa 2'));
  assert.equal([...store.keys()].filter(k => k.startsWith('personas/')).length, antes);
});
await t('nombre repetido (mayúsculas/acentos/espacios): avisa', async () => {
  const r = await call('/personas/crear', 'uA', { nombre: '  ROSA   residénte ', telefono: '6629998877', domicilio: 'Casa 21', rol: 'residente' });
  assert.equal(r.status, 409); assert.equal(r.body.requiereConfirmacion, true);
});
await t('confirmado: crea, marca en rojo (duplicadoEstado activa) y aparece así en /listar', async () => {
  const r = await call('/personas/crear', 'uA', { nombre: 'Otra Persona', telefono: '6621112222', domicilio: 'Casa 20', rol: 'residente', confirmarDuplicado: true });
  assert.equal(r.status, 200); assert.equal(r.body.duplicado, true);
  const l = await call('/personas/listar', 'uM');
  const p = l.body.personas.find(x => x.id === r.body.id);
  assert.equal(p.duplicadoEstado, 'activa'); assert.ok(p.duplicadoCon.includes('Norma')); assert.equal(p.dadoDeAltaNombre, 'Miguel Ojeda');
});
await t('sin coincidencia: alta normal sin marca', async () => {
  const r = await call('/personas/crear', 'uA', { nombre: 'Única Persona', telefono: '6620000099', domicilio: 'Casa 22', rol: 'residente' });
  assert.equal(r.status, 200); assert.equal(r.body.duplicado, false);
  const p = (await call('/personas/listar', 'uM')).body.personas.find(x => x.id === r.body.id);
  assert.equal(p.duplicadoEstado, null);
});
await t('casa repetida sigue BLOQUEADA (409 sin requiereConfirmacion), aun con confirmación', async () => {
  const r = await call('/personas/crear', 'uA', { nombre: 'Única Persona', telefono: '6620000099', domicilio: ' casa  2 ', rol: 'residente', confirmarDuplicado: true });
  assert.equal(r.status, 409); assert.ok(!r.body.requiereConfirmacion);
});
await t('residente no puede dar de alta (403) · admin no crea admin (403)', async () => {
  assert.equal((await call('/personas/crear', 'uR', { nombre: 'X Y', telefono: '6620000098', domicilio: 'Casa 23', rol: 'residente' })).status, 403);
  assert.equal((await call('/personas/crear', 'uA', { nombre: 'X Y', telefono: '6620000098', rol: 'admin' })).status, 403);
});

console.log('\n[4] /personas/duplicado-revisar');
await t('staff revisa: quita el rojo y queda en bitácora; residente 403; repetir 409', async () => {
  const r = await call('/personas/crear', 'uA', { nombre: 'Otra Persona', telefono: '6621112222', domicilio: 'Casa 20', rol: 'residente', confirmarDuplicado: true });
  const id = r.body.id;
  assert.equal((await call('/personas/duplicado-revisar', 'uR', { id })).status, 403);
  assert.equal((await call('/personas/duplicado-revisar', 'uJA', { id })).status, 200);
  assert.equal((await call('/personas/duplicado-revisar', 'uJA', { id })).status, 409);
  const p = (await call('/personas/listar', 'uM')).body.personas.find(x => x.id === id);
  assert.equal(p.duplicadoEstado, 'revisada');
  assert.ok([...store].some(([k, f]) => k.startsWith('aperturas/') && f.nombre.stringValue.includes('revisó el alta duplicada')));
});

console.log('\n[5] Roles sobre los demás endpoints de personas (sin cambios)');
await t('/personas/listar: staff 200, residente 403', async () => {
  assert.equal((await call('/personas/listar', 'uA')).status, 200);
  assert.equal((await call('/personas/listar', 'uR')).status, 403);
});

console.error = quietLog;
console.log(`\n${pass} pruebas OK`);
