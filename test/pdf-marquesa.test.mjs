// Pruebas de pdf-marquesa.js (módulo único de estilo de los PDF): textos para humanos.
// Ejecutar:  node test/pdf-marquesa.test.mjs
// El armado visual de cada PDF se revisa con las muestras (no hay jsPDF/Chart.js en Node).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const P = require('../pdf-marquesa.js');

// Plurales correctos, nunca "apertura(s)".
assert.equal(P.plural(1, 'apertura', 'aperturas'), '1 apertura');
assert.equal(P.plural(29, 'apertura', 'aperturas'), '29 aperturas');
assert.equal(P.plural(0, 'pago', 'pagos'), '0 pagos');
assert.equal(P.plural(1500, 'registro', 'registros'), '1,500 registros');

// Motivos técnicos de la bitácora (worker.js / shelly-core.js) → frases para un vecino.
const casos = {
  http_503: 'el equipo no respondió', http_502: 'el equipo no respondió', timeout: 'el equipo no respondió',
  red: 'el equipo no respondió', sin_respuesta: 'el equipo no respondió', excepcion: 'el equipo no respondió',
  shelly_http_500: 'el equipo no respondió', shelly_isok_false: 'el equipo no confirmó la apertura',
  max_req: 'demasiados intentos seguidos', http_429: 'demasiados intentos seguidos',
  http_403: 'acceso no autorizado', inactivo: 'el acceso no está activo',
  suspendido: 'residente suspendido por adeudo', hogar_suspendido: 'hogar suspendido por adeudo',
  '': 'no se pudo abrir', algo_raro: 'no se pudo abrir',
};
for (const [m, esperado] of Object.entries(casos)) assert.equal(P.motivoApertura(m), esperado, m);
for (const m of Object.keys(casos)) assert.doesNotMatch(P.motivoApertura(m), /_|http|\d{3}/, 'sin códigos técnicos: ' + m);
assert.equal(P.motivoApertura(undefined), 'no se pudo abrir');

// Montos con el mismo formato que la app.
assert.equal(P.money(1500), '$1,500');
assert.equal(P.money(1234.5), '$1,234.5');

// API pública: los cuatro generadores que usan app.js y demo.html.
for (const f of ['preparar', 'recibo', 'reporteAperturas', 'reporteCasa', 'reporteFinanciero']) assert.equal(typeof P[f], 'function', f);

console.log('pdf-marquesa: OK');
