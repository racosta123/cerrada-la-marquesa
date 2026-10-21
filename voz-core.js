/* ===========================================================
   Cerrada La Marquesa · Abrir con Siri (llaves personales de voz) — lógica pura
   Sin red ni Firestore: lo usa worker.js (/abrir-voz y /voz/llaves/*) y lo prueba test/voz.test.mjs.
   -----------------------------------------------------------
   - La llave son 32 bytes aleatorios (CSPRNG) en base64url con prefijo "mqvoz_" (el prefijo deja
     reconocer una llave filtrada en un escaneo de secretos). Se muestra UNA vez al generarla; en
     Firestore solo vive su hash SHA-256 (id del doc en tokensVoz).
   - Una llave de voz SOLO abre la puerta de Residentes, nunca otra, aunque se pida.
   =========================================================== */

export const VOZ_PREFIJO = 'mqvoz_';
export const VOZ_PUERTA = 'residentes';
export const VOZ_MAX_ACTIVAS = 1;              // una llave por residente: activar de nuevo reemplaza la anterior
export const VOZ_ESPERA_MS = 10 * 1000;        // 1 apertura cada 10 s por llave
export const VOZ_VENTANA_MS = 60 * 60 * 1000;  // ventana de 1 hora…
export const VOZ_MAX_POR_VENTANA = 30;         // …con máximo 30 aperturas por llave
export const VOZ_IP_MAX_FALLOS = 5;            // 5 llaves inválidas desde una IP…
export const VOZ_IP_VENTANA_MS = 15 * 60 * 1000;
export const VOZ_IP_BLOQUEO_MS = 15 * 60 * 1000;   // …= 15 min bloqueada
export const VOZ_DISPOSITIVO_MAX = 40;

// Lo que Siri dice en voz alta (respuesta en texto plano de /abrir-voz).
export const VOZ_MENSAJES = {
  ok: 'Puerta de residentes abierta',
  suspendido: 'Acceso suspendido',
  invalida: 'Llave no válida',
  espera: 'Espera un momento',
  otraPuerta: 'Esta llave solo abre la puerta de residentes',
  falloPuerta: 'No se pudo abrir la puerta. Intenta de nuevo',
  noDisponible: 'No se pudo abrir la puerta. Intenta de nuevo',
  fueraDePais: 'Solo se puede abrir desde México',
};

// Solo se abre por voz si Cloudflare ubica la petición en México. País desconocido (XX), Tor (T1)
// o ausente = no es MX = se rechaza.
export const VOZ_PAISES_PERMITIDOS = ['MX'];
export function paisPermitido(pais) { return VOZ_PAISES_PERMITIDOS.includes(String(pais || '').toUpperCase()); }

/* Jefe de familia de un familiar: tiene que existir y estar activo (ni suspendido ni de baja). */
export function jefeActivo(jefe) { return !!jefe && (jefe.estado || 'activo') === 'activo'; }

/* Freno para llaves que EXISTEN pero se rechazan (revocada, otra puerta, otro país, suspendido,
   jefe inactivo, cuenta inactiva): como máximo 5 rechazos por llave cada 15 min van a la bitácora;
   los demás se contestan igual pero sin escribir nada. No toca el límite de aperturas: una llave
   válida abre aunque haya agotado sus rechazos. estado = { rechazosInicio, rechazosVentana }. */
export const VOZ_RECHAZOS_MAX = 5;
export const VOZ_RECHAZOS_VENTANA_MS = 15 * 60 * 1000;
export function evaluarRechazoLlave(estado, ahora) {
  let inicio = ms(estado?.rechazosInicio);
  let n = Number(estado?.rechazosVentana) || 0;
  if (!Number.isFinite(inicio) || ahora - inicio >= VOZ_RECHAZOS_VENTANA_MS || ahora < inicio) { inicio = ahora; n = 0; }
  if (n >= VOZ_RECHAZOS_MAX) return { registrar: false };
  return { registrar: true, nuevo: { rechazosInicio: new Date(inicio).toISOString(), rechazosVentana: n + 1 } };
}

/* IP para la bitácora, truncada: IPv4 sin el último número (/24), IPv6 solo el prefijo /48.
   '' si no es una IP válida. */
function ipv4Truncada(s) {
  const p = s.split('.');
  return p.length === 4 && p.every(x => /^\d{1,3}$/.test(x) && +x <= 255) ? `${+p[0]}.${+p[1]}.${+p[2]}.0/24` : '';
}
export function truncarIpVoz(ip) {
  const v = String(ip || '').trim();
  if (!v.includes(':')) return ipv4Truncada(v);
  const mapeada = v.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);   // IPv4 escrita como IPv6
  if (mapeada) return ipv4Truncada(mapeada[1]);
  const partes = v.split('::');
  if (partes.length > 2) return '';
  const izq = partes[0] ? partes[0].split(':') : [];
  const der = partes.length === 2 && partes[1] ? partes[1].split(':') : [];
  const relleno = partes.length === 2 ? 8 - izq.length - der.length : 0;
  if (partes.length === 2 && relleno < 1) return '';
  const grupos = [...izq, ...Array(relleno).fill('0'), ...der];
  if (grupos.length !== 8 || !grupos.every(g => /^[0-9a-f]{1,4}$/i.test(g))) return '';
  return grupos.slice(0, 3).map(g => parseInt(g, 16).toString(16)).join(':') + '::/48';
}

const RE_LLAVE = /^mqvoz_[A-Za-z0-9_-]{43}$/;
const RE_ID = /^[A-Za-z0-9_-]{43}$/;   // id del doc = SHA-256 en base64url (43 caracteres)

function bytesAB64url(bytes) {
  let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* Llave nueva: 32 bytes del generador criptográfico del runtime. */
export function generarLlaveVoz() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return VOZ_PREFIJO + bytesAB64url(b);
}

export function formatoLlaveValido(s) { return typeof s === 'string' && RE_LLAVE.test(s); }
export function idLlaveValido(s) { return typeof s === 'string' && RE_ID.test(s); }

/* "Bearer <llave>" → llave (o '' si el encabezado no trae una llave con el formato correcto). */
export function llaveDeEncabezado(h) {
  const v = String(h || '').trim();
  if (!/^Bearer\s+/i.test(v)) return '';
  const llave = v.replace(/^Bearer\s+/i, '').trim();
  return formatoLlaveValido(llave) ? llave : '';
}

export async function hashLlave(llave) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(llave));
  return bytesAB64url(new Uint8Array(d));
}

/* Nombre del dispositivo que escribe el residente ("iPhone de Ana"): sin controles ni <>, espacios
   colapsados, máximo 40. '' si queda vacío. */
export function limpiarDispositivo(s) {
  return String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, VOZ_DISPOSITIVO_MAX);
}

/* El cuerpo de /abrir-voz es opcional. Si pide una puerta, tiene que ser la de Residentes. */
export function puertaPedidaPermitida(body) {
  if (!body || typeof body !== 'object' || !('puerta' in body)) return true;
  return body.puerta === VOZ_PUERTA;
}

const ms = v => (v ? Date.parse(v) : NaN);

/* Límite por llave: 1 apertura cada 10 s y máximo 30 por hora (ventana fija que arranca con la
   primera apertura). estado = { ultimaApertura, ventanaInicio, aperturasVentana } (ISO / número). */
export function evaluarLimiteLlave(estado, ahora) {
  const ult = ms(estado?.ultimaApertura);
  if (Number.isFinite(ult) && ahora - ult < VOZ_ESPERA_MS && ahora >= ult) return { ok: false, motivo: 'espera_10s' };
  let inicio = ms(estado?.ventanaInicio);
  let n = Number(estado?.aperturasVentana) || 0;
  if (!Number.isFinite(inicio) || ahora - inicio >= VOZ_VENTANA_MS || ahora < inicio) { inicio = ahora; n = 0; }
  if (n >= VOZ_MAX_POR_VENTANA) return { ok: false, motivo: 'limite_hora' };
  return {
    ok: true,
    nuevo: { ultimaApertura: new Date(ahora).toISOString(), ventanaInicio: new Date(inicio).toISOString(), aperturasVentana: n + 1 },
  };
}

/* Candado por IP ante llaves inválidas. estado = { fallidos, ventanaInicio, bloqueadoHasta }. */
export function ipBloqueada(estado, ahora) {
  const hasta = ms(estado?.bloqueadoHasta);
  return Number.isFinite(hasta) && hasta > ahora;
}
export function registrarFalloIp(estado, ahora) {
  let inicio = ms(estado?.ventanaInicio);
  let n = Number(estado?.fallidos) || 0;
  if (!Number.isFinite(inicio) || ahora - inicio >= VOZ_IP_VENTANA_MS || ahora < inicio) { inicio = ahora; n = 0; }
  n += 1;
  if (n >= VOZ_IP_MAX_FALLOS) {
    return { fallidos: 0, ventanaInicio: new Date(ahora).toISOString(), bloqueadoHasta: new Date(ahora + VOZ_IP_BLOQUEO_MS).toISOString() };
  }
  return { fallidos: n, ventanaInicio: new Date(inicio).toISOString(), bloqueadoHasta: null };
}

/* Link del atajo plantilla que pega el master en Gestión: solo links de iCloud de Atajos. */
export function atajoUrlValido(s) {
  const v = String(s || '').trim();
  return v === '' || /^https:\/\/www\.icloud\.com\/shortcuts\/[A-Za-z0-9]{16,64}\/?$/.test(v);
}
