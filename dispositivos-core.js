/* ===========================================================
   dispositivos-core.js — lógica PURA del módulo "Dispositivos" (cambiar un Shelly sin tocar secrets).
   Sin Firestore y sin secrets propios: todo llega por parámetros. Vive aparte (igual que
   shelly-core.js) para probarlo en local y para que worker.js no exporte nada extra.

   Modelo: config/dispositivos (Firestore, SOLO el Worker lo escribe) guarda, por puerta,
     <puerta>_id (string)  <puerta>_gen (1|2|3)  [<puerta>_offSec]
   más `historial` (JSON string, tope 100) y `version`. El secret SHELLY_DEVICES SIGUE siendo
   el respaldo: cualquier puerta cuyo dato falte, venga corrupto o no se pueda leer usa el secret.
   =========================================================== */

export const PUERTAS_DISP = ['visitantes', 'residentes', 'peatones', 'salida'];
export const ID_SHELLY_RE = /^[0-9a-fA-F]{6,16}$/;   // id de Shelly Cloud = MAC (o sus últimos bytes), hexadecimal
export const HISTORIAL_MAX = 100;

export const idShellyValido = id => typeof id === 'string' && ID_SHELLY_RE.test(id);
export const genValida = g => g === 1 || g === 2 || g === 3;

/* Convierte los campos ya leídos (readDoc) de config/dispositivos en { puertas, historial, version }.
   Tolerante a TODO: un campo ausente, de tipo raro o con un id mal formado descarta ESA puerta
   (cae al secret), jamás lanza. */
export function parsearDispositivos(d) {
  const out = { puertas: {}, historial: [], version: 0 };
  if (!d || typeof d !== 'object') return out;
  for (const p of PUERTAS_DISP) {
    const id = d[`${p}_id`], gen = d[`${p}_gen`];
    if (!idShellyValido(id) || !genValida(gen)) continue;
    const e = { id, gen };
    const off = d[`${p}_offSec`];
    if (gen >= 2 && Number.isFinite(off) && off > 0 && off <= 30) e.offSec = off;
    out.puertas[p] = e;
  }
  try {
    const h = JSON.parse(d.historial || '[]');
    if (Array.isArray(h)) out.historial = h.filter(x => x && typeof x === 'object' && PUERTAS_DISP.includes(x.puerta)).slice(-HISTORIAL_MAX);
  } catch (e) { /* historial ilegible: se ignora, no afecta las aperturas */ }
  out.version = Number.isFinite(d.version) ? d.version : 0;
  return out;
}

/* JSON en la forma que ya entiende resolveShellyDevice (shelly-core.js), o null si no hay nada válido. */
export function mapaParaTrigger(parsed) {
  const claves = Object.keys(parsed?.puertas || {});
  if (!claves.length) return null;
  const mapa = {};
  for (const p of claves) {
    const { id, gen, offSec } = parsed.puertas[p];
    mapa[p] = gen === 1 ? id : (offSec ? { id, gen, offSec } : { id, gen });
  }
  return JSON.stringify(mapa);
}

/* Dispositivo efectivo de una puerta: documento válido, si no el secret SHELLY_DEVICES (misma forma que
   shelly-core). Devuelve { id, gen, origen } o null si no hay ninguno. */
export function dispositivoEfectivo(parsed, secretJson, puerta) {
  const d = parsed?.puertas?.[puerta];
  if (d) return { id: d.id, gen: d.gen, origen: 'documento' };
  try {
    const m = JSON.parse(secretJson || 'null');
    const e = m && m[puerta];
    if (typeof e === 'string' && e) return { id: e, gen: 1, origen: 'secreto' };
    if (e && typeof e === 'object' && typeof e.id === 'string' && e.id) return { id: e.id, gen: (e.gen === 2 || e.gen === 3) ? e.gen : 1, origen: 'secreto' };
  } catch (e) { /* secret roto: sin dispositivo */ }
  return null;
}

/* ---- Consulta a Shelly Cloud (SOLO LECTURA: estado del dispositivo; nunca enciende nada) ----
   Cloud Control API: POST {host}/device/status (form id + auth_key) -> { isok, data:{ online, _dev_info:{gen} } }.
   Todos los comparativos son tolerantes; si no se puede determinar algo, se dice (nunca se inventa). El
   límite de Shelly Cloud (~1 req/s por cuenta) se respeta con una separación mínima entre consultas. */
let ultimaConsulta = 0;
const dormir = ms => new Promise(r => setTimeout(r, ms));
const ESPACIO_DEF_MS = 1300;   // env.SHELLY_STATUS_SPACING_MS lo cambia (las pruebas locales lo ponen en 0)

export function genDesdeInfo(info) {
  const g = info && (info.gen ?? info.generation);
  if (g === 1 || g === '1' || g === 'G1') return 1;
  if (g === 2 || g === '2' || g === 'G2') return 2;
  if (g === 3 || g === '3' || g === 'G3') return 3;
  return null;
}

/* -> { existe, online, gen, error } ; nunca lanza. */
export async function consultarShelly(env, id, { timeoutMs = 6000 } = {}) {
  if (!idShellyValido(id)) return { existe: false, online: false, gen: null, error: 'formato' };
  if (!env.SHELLY_HOST || !env.SHELLY_AUTH_KEY) return { existe: false, online: false, gen: null, error: 'sin-credenciales' };
  const espera = ultimaConsulta + Number(env.SHELLY_STATUS_SPACING_MS ?? ESPACIO_DEF_MS) - Date.now();
  if (espera > 0) await dormir(espera);
  ultimaConsulta = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${env.SHELLY_HOST}/device/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id, auth_key: env.SHELLY_AUTH_KEY }),
      signal: ctrl.signal,
    });
    const txt = await r.text().catch(() => '');
    if (r.status === 429 || /max_req/i.test(txt)) return { existe: false, online: false, gen: null, error: 'limite' };
    let j = null; try { j = JSON.parse(txt); } catch (e) { /* no JSON */ }
    if (!r.ok || !j) return { existe: false, online: false, gen: null, error: 'respuesta' };
    if (j.isok === false) return { existe: false, online: false, gen: null, error: 'no-existe' };
    const data = j.data || {};
    const online = data.online === true || data.online === 1;
    const gen = genDesdeInfo(data._dev_info) ?? genDesdeInfo(data.device_status && data.device_status._dev_info) ?? genDesdeInfo(data);
    return { existe: true, online, gen, error: null };
  } catch (e) {
    return { existe: false, online: false, gen: null, error: ctrl.signal.aborted ? 'timeout' : 'red' };
  } finally { clearTimeout(timer); }
}

/* ---- Lista de dispositivos de la cuenta (SOLO LECTURA) — para elegir el repuesto sin teclear su ID ----
   Endpoint usado: POST {SHELLY_HOST}/device/all_status  (form: auth_key, show_info=true)  — Cloud Control API v1,
   "estado de todos los dispositivos de la cuenta". OJO: la forma exacta de la respuesta NO está verificada contra la
   nube real (no se consultó). Por eso el parser acepta varias formas y, con diagnostico:true, el Worker devuelve la
   FORMA (nombres de campos y tipos, sin valores ni llaves) para corregirlo antes de cualquier cambio de ID. */
const ALL_STATUS_PATH = '/device/all_status';
const objOrNull = o => (o && typeof o === 'object' && !Array.isArray(o)) ? o : null;

export function parsearListaShelly(j) {
  const root = objOrNull(j && j.data) || objOrNull(j) || {};
  const estados = objOrNull(root.devices_status) || {};
  let infos = root.devices;
  const mapaInfos = {};
  if (Array.isArray(infos)) infos.forEach(x => { if (x && typeof x.id === 'string') mapaInfos[x.id] = x; });
  else if (objOrNull(infos)) Object.assign(mapaInfos, infos);
  const ids = new Set([...Object.keys(estados), ...Object.keys(mapaInfos)]);
  const out = [];
  for (const id of ids) {
    const st = objOrNull(estados[id]) || {}, inf = objOrNull(mapaInfos[id]) || {};
    const di = objOrNull(st._dev_info) || objOrNull(inf._dev_info) || {};
    const flags = [st._dev_info && st._dev_info.online, st.online, inf.online, di.online, st.cloud && st.cloud.connected].filter(v => v !== undefined);
    const online = flags.length ? (flags[0] === true || flags[0] === 1) : false;
    const nombre = [inf.name, inf.device_name, di.name, st.name].find(v => typeof v === 'string' && v.trim()) || null;
    const gen = genDesdeInfo(di) ?? genDesdeInfo(inf) ?? null;
    const modelo = [di.code, inf.code, inf.type, st.code].find(v => typeof v === 'string' && v) || null;
    out.push({ id: String(di.id || inf.id || id), nombre, gen, modelo, online });
  }
  return out;
}

/* Estructura de la respuesta (tipos y nombres de campos hasta 5 niveles; NUNCA valores) para depurar el parser. */
export function formaDe(v, depth = 0) {
  if (Array.isArray(v)) return depth >= 5 ? 'array' : { _array: v.length, _item: v.length ? formaDe(v[0], depth + 1) : null };
  if (v && typeof v === 'object') {
    if (depth >= 5) return 'objeto';
    const ks = Object.keys(v), muestra = ks.slice(0, 12), o = {};
    // las llaves que parecen ids de dispositivo (hex) se normalizan para no exponerlos
    muestra.forEach((k, i) => { o[/^[0-9a-f]{6,16}$/i.test(k) ? '<id-' + i + '>' : k] = formaDe(v[k], depth + 1); });
    if (ks.length > 12) o['…'] = ks.length - 12 + ' más';
    return o;
  }
  return v === null ? 'null' : typeof v;
}

/* -> { ok, dispositivos, forma, error } ; nunca lanza ni devuelve la llave. */
export async function listarDispositivosCuenta(env, { timeoutMs = 8000 } = {}) {
  if (!env.SHELLY_HOST || !env.SHELLY_AUTH_KEY) return { ok: false, dispositivos: [], forma: null, error: 'sin-credenciales' };
  const espera = ultimaConsulta + Number(env.SHELLY_STATUS_SPACING_MS ?? ESPACIO_DEF_MS) - Date.now();
  if (espera > 0) await dormir(espera);
  ultimaConsulta = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${env.SHELLY_HOST}${ALL_STATUS_PATH}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ auth_key: env.SHELLY_AUTH_KEY, show_info: 'true' }), signal: ctrl.signal,
    });
    const txt = await r.text().catch(() => '');
    if (r.status === 429 || /max_req/i.test(txt)) return { ok: false, dispositivos: [], forma: null, error: 'limite' };
    let j = null; try { j = JSON.parse(txt); } catch (e) { /* no JSON */ }
    if (!r.ok || !j) return { ok: false, dispositivos: [], forma: null, error: 'respuesta' };
    if (j.isok === false) return { ok: false, dispositivos: [], forma: formaDe(j), error: 'rechazado' };
    return { ok: true, dispositivos: parsearListaShelly(j), forma: formaDe(j), error: null };
  } catch (e) {
    return { ok: false, dispositivos: [], forma: null, error: ctrl.signal.aborted ? 'timeout' : 'red' };
  } finally { clearTimeout(timer); }
}
