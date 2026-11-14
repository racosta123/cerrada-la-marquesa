/* ===========================================================
   Cerrada La Marquesa · pdf-marquesa.js
   Módulo ÚNICO de presentación de todos los PDF de la app (recibo de pago, reporte financiero
   del mes, historial de pagos por casa y reporte de aperturas). Aquí vive TODO el estilo:
   encabezado con el logo, tarjetas de resumen, fichas, tablas y pie. Los generadores solo
   reciben datos YA calculados por app.js (o demo.html): este archivo no decide montos, folios
   ni permisos, solo cómo se ven.

   Tipografía: Poppins (SIL Open Font License 1.1, vendor/OFL-Poppins.txt), local en vendor/,
   la misma de las cotizaciones de Diagonal Catorce. Sin CDN. Si las fuentes no llegan (sin red
   y sin caché) el PDF sale igual con Helvetica: nunca se bloquea un recibo por la tipografía.

   Uso: await MarquesaPDF.preparar();  // una vez: logo + fuentes (se cachean en memoria)
        const doc = MarquesaPDF.recibo({...});   // síncrono (Web Share necesita el gesto)
   =========================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.MarquesaPDF = factory(root);
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  /* ---------------- Identidad (tonos del logo: negro tinta, rojo vino y beige mármol) ---------------- */
  const C = {
    tinta:   [29, 29, 31],     // #1d1d1f — texto y encabezados de tabla
    gris:    [110, 110, 115],  // #6e6e73 — etiquetas
    gris2:   [150, 150, 155],  // notas y pie
    linea:   [230, 228, 224],
    suave:   [248, 246, 242],  // filas alternadas / fichas (beige muy claro)
    beige:   [233, 220, 196],  // #e9dcc4 — del mármol del logo
    rojo:    [142, 27, 27],    // #8e1b1b — rojo del logo: filete, gastos, fallidas
    rojoBg:  [251, 236, 234],
    verde:   [22, 122, 74],    // #167a4a — cobrado, exitosas, PAGADO
    verdeBg: [230, 244, 236],
    blanco:  [255, 255, 255],
  };
  const HEX = { verde: '#167a4a', rojo: '#8e1b1b', tinta: '#1d1d1f', gris: '#6e6e73', linea: '#ebe8e3' };
  // Dona de gastos: misma familia de color, de oscuro a claro.
  const PALETA_DONA = ['#8e1b1b', '#1d1d1f', '#b4532a', '#a8875a', '#6e6e73', '#c9a227', '#4b5d52', '#d6c3a5'];
  const TONOS = { ok: C.verde, bad: C.rojo, ink: C.tinta, marca: C.rojo };

  const M = 40;              // margen lateral (pt)
  const PIE_Y = 26;          // distancia del pie al borde inferior
  const MARGEN_INF = 58;     // donde se corta el contenido (deja aire al pie)
  const PIE_TEXTO = ['Cerrada La Marquesa', ' · Sistema Monitor Catorce por Diagonal Catorce · '];

  /* ---------------- Textos para humanos ---------------- */
  const money = n => '$' + (n || 0).toLocaleString('es-MX', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const conSigno = (n, positivo) => (positivo ? '+' : '-') + money(Math.abs(n));   // "-" ASCII: seguro en cualquier fuente
  function plural(n, uno, varios) { return `${Number(n || 0).toLocaleString('es-MX')} ${Number(n) === 1 ? uno : varios}`; }

  /* Motivo técnico de la bitácora (worker.js / shelly-core.js) → frase corta para un vecino. */
  function motivoApertura(m) {
    const s = String(m || '').toLowerCase();
    if (!s) return 'no se pudo abrir';
    if (s === 'inactivo') return 'el acceso no está activo';
    if (s === 'suspendido') return 'residente suspendido por adeudo';
    if (s === 'hogar_suspendido') return 'hogar suspendido por adeudo';
    if (s === 'shelly_isok_false') return 'el equipo no confirmó la apertura';
    if (s === 'max_req' || /(^|_)429$/.test(s)) return 'demasiados intentos seguidos';
    if (/(^|_)(401|403)$/.test(s)) return 'acceso no autorizado';
    if (s === 'timeout' || s === 'red' || s === 'sin_respuesta' || s === 'excepcion' || /http_\d+$/.test(s)) return 'el equipo no respondió';
    return 'no se pudo abrir';
  }

  /* ---------------- Recursos: logo + fuentes (una sola carga por sesión) ---------------- */
  const R = { logo: null, logoRatio: 662 / 300, fuentes: null, listo: null };
  const ARCHIVOS = { normal: 'Poppins-Regular.ttf', medium: 'Poppins-Medium.ttf', bold: 'Poppins-Bold.ttf' };

  function abToBase64(buf) {
    const bytes = new Uint8Array(buf); let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  async function bajar(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(url + ' ' + r.status);
    return r.arrayBuffer();
  }
  /* base: carpeta raíz de la app ('' en la app y en demo.html). Nunca falla: lo que no llegue se omite. */
  function preparar(base = '') {
    if (R.listo) return R.listo;
    R.listo = (async () => {
      const [logo, ...fuentes] = await Promise.allSettled([
        bajar(base + 'assets/logo-marquesa.jpg'),
        ...Object.values(ARCHIVOS).map(f => bajar(base + 'vendor/' + f)),
      ]);
      if (logo.status === 'fulfilled') R.logo = 'data:image/jpeg;base64,' + abToBase64(logo.value);
      if (fuentes.every(f => f.status === 'fulfilled')) {
        R.fuentes = {};
        Object.keys(ARCHIVOS).forEach((k, i) => { R.fuentes[k] = abToBase64(fuentes[i].value); });
        // La misma Poppins para el texto horneado en las gráficas (canvas de Chart.js).
        try {
          if (root.FontFace && root.document) {
            await Promise.all(Object.keys(ARCHIVOS).map((k, i) => {
              const ff = new FontFace('MarquesaPoppins', fuentes[i].value.slice(0), { weight: k === 'bold' ? '700' : k === 'medium' ? '500' : '400' });
              return ff.load().then(f => root.document.fonts.add(f));
            }));
          }
        } catch (_) { /* las gráficas caen a Helvetica */ }
      }
      if (!R.logo || !R.fuentes) R.listo = null;   // se reintenta la próxima vez
      return { logo: !!R.logo, fuentes: !!R.fuentes };
    })();
    return R.listo;
  }

  /* ---------------- Documento y tipografía ---------------- */
  function nuevoDoc() {
    const { jsPDF } = root.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'letter' });
    if (R.fuentes) {
      Object.entries(ARCHIVOS).forEach(([estilo, archivo]) => {
        doc.addFileToVFS(archivo, R.fuentes[estilo]);
        doc.addFont(archivo, 'Poppins', estilo);
      });
    }
    doc.setLineHeightFactor(1.3);
    return doc;
  }
  const familia = () => (R.fuentes ? 'Poppins' : 'helvetica');
  const estilo = peso => (R.fuentes ? peso : (peso === 'normal' ? 'normal' : 'bold'));
  function fuente(doc, peso, tam, color) {
    doc.setFont(familia(), estilo(peso || 'normal'));
    if (tam) doc.setFontSize(tam);
    if (color) doc.setTextColor(...color);
  }
  const ancho = doc => doc.internal.pageSize.getWidth();
  const alto = doc => doc.internal.pageSize.getHeight();

  /* Texto con espaciado entre letras (jsPDF no suma el espaciado al alinear, se calcula aquí). */
  function espaciado(doc, txt, x, y, cs, align) {
    const w = doc.getTextWidth(txt) + cs * Math.max(txt.length - 1, 0);
    const x0 = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    doc.text(txt, x0, y, { charSpace: cs });
    return w;
  }
  function etiqueta(doc, txt, x, y, color, align) {
    fuente(doc, 'medium', 6.6, color || C.gris);
    return espaciado(doc, String(txt).toUpperCase(), x, y, 1.1, align);
  }
  /* Segmentos [{t, peso, color}] en una línea, alineados en conjunto. */
  function linea(doc, segs, x, y, tam, align) {
    const anchos = segs.map(s => { fuente(doc, s.peso || 'normal', tam); return doc.getTextWidth(s.t); });
    const total = anchos.reduce((a, b) => a + b, 0);
    let cx = align === 'right' ? x - total : align === 'center' ? x - total / 2 : x;
    segs.forEach((s, i) => { fuente(doc, s.peso || 'normal', tam, s.color || C.tinta); doc.text(s.t, cx, y); cx += anchos[i]; });
    return total;
  }

  /* ---------------- Bloques compartidos ---------------- */
  /* Encabezado: logo a la izquierda; título grande + folio/periodo/fecha a la derecha; filete rojo. */
  function encabezado(doc, { titulo, folio, periodo, generado, generadoEtiqueta }) {
    const W = ancho(doc), top = 30;
    const LOGO_H = 54, LOGO_W = LOGO_H * R.logoRatio;
    if (R.logo) doc.addImage(R.logo, 'JPEG', M, top, LOGO_W, LOGO_H);
    else { fuente(doc, 'bold', 22, C.tinta); doc.text('Marquesa', M, top + 34); }
    etiqueta(doc, 'Cerrada La Marquesa · Hermosillo, Sonora', M, top + LOGO_H + 13, C.gris);

    fuente(doc, 'bold', 19, C.tinta);
    espaciado(doc, titulo.toUpperCase(), W - M, top + 22, 2.2, 'right');
    let ly = top + 40;
    const meta = [];
    if (folio) meta.push(['Folio', folio, true]);
    if (periodo) meta.push(['Periodo', periodo]);
    if (generado) meta.push([generadoEtiqueta || 'Generado', generado]);
    meta.forEach(([k, v, fuerte]) => {
      linea(doc, [{ t: k + '  ', color: C.gris }, { t: v, peso: fuerte ? 'bold' : 'medium', color: fuerte ? C.rojo : C.tinta }], W - M, ly, fuerte ? 9.5 : 8.4, 'right');
      ly += 13;
    });
    const barY = Math.max(top + LOGO_H + 24, ly + 2);
    doc.setFillColor(...C.rojo); doc.rect(M, barY, W - 2 * M, 2.4, 'F');
    doc.setFillColor(...C.tinta); doc.rect(M, barY + 2.4, W - 2 * M, 0.6, 'F');
    return barY + 22;
  }

  /* Fichas tipo cotización: [{etiqueta, titulo, lineas:[]}, {etiqueta, kv:[[k,v],…]}] en columnas. */
  function fichas(doc, y, cols) {
    const W = ancho(doc), gap = 12, n = cols.length;
    const w = (W - 2 * M - gap * (n - 1)) / n, pad = 12;
    const layout = cols.map(c => {
      const piezas = []; let h = pad + 8;
      if (c.titulo) {
        fuente(doc, 'bold', 12.5);
        const l = doc.splitTextToSize(String(c.titulo), w - 2 * pad);
        piezas.push({ tipo: 'titulo', l, y: h + 12 }); h += 12 + (l.length - 1) * 15 + 4;
      }
      (c.lineas || []).forEach(t => {
        fuente(doc, 'normal', 8.6);
        const l = doc.splitTextToSize(String(t), w - 2 * pad);
        piezas.push({ tipo: 'linea', l, y: h + 11 }); h += 11 * l.length + 1;
      });
      (c.kv || []).forEach(([k, v]) => {
        fuente(doc, 'medium', 8.6);
        const l = doc.splitTextToSize(String(v), (w - 2 * pad) * 0.64);
        piezas.push({ tipo: 'kv', k, l, y: h + 12 }); h += 14 + (l.length - 1) * 11;
      });
      return { c, piezas, h: h + pad };
    });
    const H = Math.max(...layout.map(l => l.h));
    layout.forEach(({ c, piezas }, i) => {
      const x = M + i * (w + gap);
      doc.setFillColor(...C.suave); doc.roundedRect(x, y, w, H, 5, 5, 'F');
      etiqueta(doc, c.etiqueta, x + pad, y + pad + 4);
      piezas.forEach(p => {
        if (p.tipo === 'titulo') { fuente(doc, 'bold', 12.5, C.tinta); doc.text(p.l, x + pad, y + p.y, { lineHeightFactor: 1.2 }); }
        if (p.tipo === 'linea') { fuente(doc, 'normal', 8.6, C.tinta); doc.text(p.l, x + pad, y + p.y); }
        if (p.tipo === 'kv') {
          fuente(doc, 'normal', 8.6, C.gris); doc.text(String(p.k), x + pad, y + p.y);
          fuente(doc, 'medium', 8.6, C.tinta); doc.text(p.l, x + w - pad, y + p.y, { align: 'right' });
        }
      });
    });
    return y + H + 14;
  }

  /* Tarjetas de resumen: [{etiqueta, valor, tono:'ok'|'bad'|'ink', nota}] */
  function tarjetas(doc, y, items) {
    const W = ancho(doc), gap = 12, n = items.length;
    const w = (W - 2 * M - gap * (n - 1)) / n, h = 66;
    items.forEach((it, i) => {
      const x = M + i * (w + gap), color = TONOS[it.tono] || C.tinta;
      doc.setDrawColor(...C.linea); doc.setLineWidth(0.7); doc.setFillColor(...C.blanco);
      doc.roundedRect(x, y, w, h, 5, 5, 'FD');
      doc.setFillColor(...color); doc.rect(x, y + 10, 2.6, h - 20, 'F');
      etiqueta(doc, it.etiqueta, x + 14, y + 17);
      fuente(doc, 'bold', 18, color); doc.text(String(it.valor), x + 14, y + 41);
      if (it.nota) { fuente(doc, 'normal', 7.4, it.notaColor || C.gris); doc.text(doc.splitTextToSize(String(it.nota), w - 24)[0], x + 14, y + 56); }
    });
    return y + h + 18;
  }

  /* Título de sección: barrita roja + etiqueta espaciada. Salta de página si no cabe `minimo`. */
  function seccion(doc, y, titulo, minimo = 60) {
    if (y + minimo > alto(doc) - MARGEN_INF) { doc.addPage(); y = 44; }
    doc.setFillColor(...C.rojo); doc.rect(M, y - 6.5, 12, 2.4, 'F');
    fuente(doc, 'medium', 8, C.tinta);
    espaciado(doc, titulo.toUpperCase(), M + 18, y - 3.5, 1.3);
    return y + 10;
  }

  /* Aviso en caja (rojo suave o neutro). */
  function aviso(doc, y, texto, tono) {
    const W = ancho(doc), w = W - 2 * M;
    fuente(doc, 'normal', 8.4);
    const l = doc.splitTextToSize(texto, w - 26);
    const h = 14 + l.length * 11;
    doc.setFillColor(...(tono === 'bad' ? C.rojoBg : C.suave)); doc.roundedRect(M, y, w, h, 4, 4, 'F');
    doc.setFillColor(...(tono === 'bad' ? C.rojo : C.gris)); doc.rect(M, y, 2.6, h, 'F');
    fuente(doc, 'normal', 8.4, tono === 'bad' ? C.rojo : C.tinta); doc.text(l, M + 14, y + 15);
    return y + h + 12;
  }

  /* Tabla estándar: encabezado oscuro, filas alternadas suaves, anchos por proporción.
     cols: [{t:'Fecha', w:.15, align:'left'|'right'|'center'}]; estiloCelda(fila, col, seccion) → {color, peso}. */
  function tabla(doc, { y, cols, body, foot, estiloCelda, vacio }) {
    const W = ancho(doc), util = W - 2 * M;
    const columnStyles = {};
    cols.forEach((c, i) => { columnStyles[i] = { cellWidth: util * c.w, halign: c.align || 'left' }; });
    const filas = body.length ? body : [[{ content: vacio || 'Sin registros', colSpan: cols.length, styles: { halign: 'center', textColor: C.gris } }]];
    doc.autoTable({
      startY: y,
      head: [cols.map((c, i) => ({ content: c.t.toUpperCase(), styles: { halign: c.align || 'left' } }))],
      body: filas,
      foot: foot || undefined,
      showFoot: 'lastPage',
      theme: 'plain',
      styles: {
        font: familia(), fontStyle: estilo('normal'), fontSize: 8.3, textColor: C.tinta,
        cellPadding: { top: 6, bottom: 6, left: 8, right: 8 }, valign: 'middle', overflow: 'linebreak',
        lineColor: C.linea, lineWidth: { bottom: 0.5 },
      },
      headStyles: { fillColor: C.tinta, textColor: C.blanco, fontStyle: estilo('medium'), fontSize: 7, cellPadding: { top: 7, bottom: 7, left: 8, right: 8 }, lineWidth: 0 },
      alternateRowStyles: { fillColor: C.suave },
      footStyles: { fillColor: C.blanco, textColor: C.tinta, fontStyle: estilo('bold'), fontSize: 8.6, lineWidth: 0 },
      columnStyles,
      margin: { left: M, right: M, top: 44, bottom: MARGEN_INF },
      didParseCell(d) {
        if (!estiloCelda || d.section === 'head' || !body.length) return;
        const s = estiloCelda(d.row.index, d.column.index, d.section);
        if (!s) return;
        if (s.color) d.cell.styles.textColor = s.color;
        if (s.peso) d.cell.styles.fontStyle = estilo(s.peso);
        if (s.fondo) d.cell.styles.fillColor = s.fondo;
      },
      didDrawCell(d) {
        // Doble filete sobre los totales, como en un estado de cuenta.
        if (d.section === 'foot' && d.row.index === 0 && d.column.index === 0) {
          doc.setDrawColor(...C.tinta); doc.setLineWidth(0.7);
          doc.line(M, d.cell.y, W - M, d.cell.y);
          doc.setLineWidth(0.3); doc.line(M, d.cell.y + 2, W - M, d.cell.y + 2);
        }
      },
    });
    return doc.lastAutoTable.finalY + 16;
  }

  /* Pie en TODAS las páginas: "Cerrada La Marquesa · Sistema Monitor Catorce por Diagonal Catorce · Página X de Y". */
  function pies(doc) {
    const W = ancho(doc), H = alto(doc), n = doc.internal.getNumberOfPages();
    for (let p = 1; p <= n; p++) {
      doc.setPage(p);
      doc.setDrawColor(...C.linea); doc.setLineWidth(0.6); doc.line(M, H - PIE_Y - 11, W - M, H - PIE_Y - 11);
      linea(doc, [
        { t: PIE_TEXTO[0], peso: 'medium', color: C.tinta },
        { t: PIE_TEXTO[1], color: C.gris2 },
        { t: `Página ${p} de ${n}`, peso: 'medium', color: C.gris },
      ], W / 2, H - PIE_Y, 7, 'center');
    }
  }

  function pastilla(doc, txt, xDer, y, tono) {
    fuente(doc, 'bold', 10);
    const cs = 1.6, w = doc.getTextWidth(txt) + cs * (txt.length - 1) + 26, h = 22;
    doc.setFillColor(...(tono === 'bad' ? C.rojo : C.verde)); doc.roundedRect(xDer - w, y, w, h, h / 2, h / 2, 'F');
    fuente(doc, 'bold', 10, C.blanco); espaciado(doc, txt, xDer - w / 2, y + 14.8, cs, 'center');
    return w;
  }

  function marcaAgua(doc, txt) {
    const W = ancho(doc), H = alto(doc);
    doc.saveGraphicsState();
    try { doc.setGState(new doc.GState({ opacity: 0.16 })); } catch (_) {}
    fuente(doc, 'bold', 84, C.rojo);
    // Con ángulo, jsPDF ignora align:'center': se centra a mano con el ancho real del texto.
    const ANG = 35, rad = ANG * Math.PI / 180, tw = doc.getTextWidth(txt);
    doc.text(txt, W / 2 - (tw / 2) * Math.cos(rad), H / 2 + (tw / 2) * Math.sin(rad), { angle: ANG });
    doc.restoreGraphicsState();
  }

  /* =========================================================
     1) RECIBO DE PAGO — comprobante formal
     d: { folio, emitido, casa, concepto, categoria, monto, registro, corrigeA, cancelado,
          motivoCancelacion, sustituidoPor }
     ========================================================= */
  function recibo(d) {
    const doc = nuevoDoc(), W = ancho(doc), H = alto(doc);
    let y = encabezado(doc, { titulo: 'Recibo de pago', folio: d.folio, generado: d.emitido, generadoEtiqueta: 'Emitido' });

    // Panel del monto: tinta con el importe destacado y el estado del comprobante.
    const ph = 104, pw = W - 2 * M;
    doc.setFillColor(...C.tinta); doc.roundedRect(M, y, pw, ph, 7, 7, 'F');
    etiqueta(doc, 'Monto recibido', M + 22, y + 26, C.beige);
    fuente(doc, 'bold', 34, C.blanco); doc.text(money(d.monto), M + 22, y + 66);
    fuente(doc, 'normal', 8.4, C.beige); doc.text('Pesos mexicanos (MXN)', M + 22, y + 84);
    pastilla(doc, d.cancelado ? 'CANCELADO' : 'PAGADO', W - M - 22, y + 22, d.cancelado ? 'bad' : 'ok');
    linea(doc, [{ t: 'Folio  ', color: C.beige }, { t: d.folio, peso: 'medium', color: C.blanco }], W - M - 22, y + 66, 9.5, 'right');
    fuente(doc, 'normal', 8, C.beige); doc.text(d.emitido, W - M - 22, y + 82, { align: 'right' });
    y += ph + 18;

    y = fichas(doc, y, [
      { etiqueta: 'Recibido de', titulo: d.casa || '—', lineas: ['Residente de Cerrada La Marquesa'] },
      { etiqueta: 'Datos del pago', kv: [
        ['Concepto', d.concepto || '—'],
        ['Categoría', d.categoria || 'Otro'],
        ['Fecha y hora', d.emitido],
        ['Registró', d.registro || '—'],
      ] },
    ]);

    if (d.corrigeA) y = aviso(doc, y, `Este recibo corrige al recibo ${d.corrigeA}, que quedó cancelado.`);
    if (d.cancelado) {
      y = aviso(doc, y, `RECIBO CANCELADO: este comprobante ya no es válido. Motivo: ${d.motivoCancelacion || 'sin motivo registrado'}.`
        + (d.sustituidoPor ? ` Lo sustituye el recibo ${d.sustituidoPor}.` : ''), 'bad');
    }

    // Leyenda y firma de la administración.
    fuente(doc, 'normal', 8.2, C.gris);
    const leyenda = d.cancelado
      ? 'Este comprobante se conserva solo como registro: fue cancelado y no ampara ningún pago.'
      : 'Este comprobante ampara el pago descrito. Fue emitido electrónicamente por el Sistema Monitor Catorce; con el folio la administración puede verificarlo en cualquier momento.';
    const ll = doc.splitTextToSize(leyenda, W - 2 * M);
    doc.text(ll, M, y + 4);
    const fy = Math.min(y + ll.length * 11 + 78, H - 110);
    doc.setDrawColor(...C.tinta); doc.setLineWidth(0.6); doc.line(W / 2 - 110, fy, W / 2 + 110, fy);
    fuente(doc, 'medium', 9, C.tinta); doc.text('Administración', W / 2, fy + 14, { align: 'center' });
    fuente(doc, 'normal', 7.6, C.gris); doc.text('Cerrada La Marquesa', W / 2, fy + 26, { align: 'center' });

    pies(doc);
    if (d.cancelado) marcaAgua(doc, 'CANCELADO');
    return doc;
  }

  /* =========================================================
     2) REPORTE DE APERTURAS POR RESIDENTE
     d: { nombre, domicilio, periodo, generado, total, exitosas, fallidas, truncado, maxRegistros,
          registros:[{fecha, hora, puerta, via, ok, motivo}] }
     ========================================================= */
  function reporteAperturas(d) {
    const doc = nuevoDoc();
    let y = encabezado(doc, { titulo: 'Reporte de aperturas', periodo: d.periodo, generado: d.generado });
    y = fichas(doc, y, [
      { etiqueta: 'Residente', titulo: d.nombre || 'Residente', lineas: [d.domicilio ? `Domicilio: ${d.domicilio}` : 'Sin domicilio registrado'] },
      { etiqueta: 'Datos del reporte', kv: [['Periodo', d.periodo], ['Registros en el reporte', plural(d.registros.length, 'registro', 'registros')], ['Uso', 'Interno de administración']] },
    ]);
    const pct = n => (d.total > 0 ? `${Math.round(n / d.total * 100)}% del total` : 'Sin intentos');
    y = tarjetas(doc, y, [
      { etiqueta: 'Total', valor: d.total, tono: 'ink', nota: plural(d.total, 'apertura', 'aperturas') + ' en el periodo' },
      { etiqueta: 'Exitosas', valor: d.exitosas, tono: 'ok', nota: pct(d.exitosas) },
      { etiqueta: 'Fallidas', valor: d.fallidas, tono: 'bad', nota: pct(d.fallidas) },
    ]);
    if (d.truncado) y = aviso(doc, y, `Se muestran los ${d.maxRegistros} registros más recientes del periodo; hay más. Acorta el rango de fechas para verlos todos.`, 'bad');
    y = seccion(doc, y, 'Detalle de aperturas');
    tabla(doc, {
      y,
      cols: [{ t: 'Fecha', w: .15 }, { t: 'Hora', w: .11 }, { t: 'Puerta', w: .22 }, { t: 'Vía', w: .11 }, { t: 'Resultado', w: .41 }],
      body: d.registros.map(x => [x.fecha, x.hora, x.puerta, x.via, x.ok ? 'Abrió' : `Fallido · ${motivoApertura(x.motivo)}`]),
      vacio: 'Sin aperturas en ese rango',
      estiloCelda: (r, c) => (c === 4 ? { color: d.registros[r].ok ? C.verde : C.rojo, peso: 'medium' } : null),
    });
    pies(doc);
    return doc;
  }

  /* =========================================================
     3) HISTORIAL DE PAGOS DE UNA CASA
     d: { casa, generado, total, pagos:[{fecha, concepto, categoria, folio, envio, monto}] }
     ========================================================= */
  function reporteCasa(d) {
    const doc = nuevoDoc();
    let y = encabezado(doc, { titulo: 'Historial de pagos', generado: d.generado });
    y = fichas(doc, y, [
      { etiqueta: 'Casa', titulo: d.casa, lineas: ['Pagos registrados en la administración, del más reciente al más antiguo.'] },
      { etiqueta: 'Datos del reporte', kv: [['Pagos', plural(d.pagos.length, 'pago', 'pagos')], ['Último pago', d.pagos[0] ? d.pagos[0].fecha : '—'], ['Uso', 'Soporte para aclaraciones']] },
    ]);
    y = tarjetas(doc, y, [
      { etiqueta: 'Pagos registrados', valor: d.pagos.length, tono: 'ink', nota: plural(d.pagos.length, 'pago', 'pagos') + ' con recibo' },
      { etiqueta: 'Total pagado', valor: money(d.total), tono: 'ok', nota: 'Suma de pagos vigentes' },
      { etiqueta: 'Último pago', valor: d.pagos[0] ? money(d.pagos[0].monto) : '—', tono: 'ink', nota: d.pagos[0] ? d.pagos[0].fecha : '' },
    ]);
    y = seccion(doc, y, 'Detalle de pagos');
    tabla(doc, {
      y,
      cols: [{ t: 'Fecha', w: .13 }, { t: 'Concepto', w: .26 }, { t: 'Categoría', w: .11 }, { t: 'Folio', w: .17 }, { t: 'Recibo', w: .20 }, { t: 'Monto', w: .13, align: 'right' }],
      body: d.pagos.map(m => [m.fecha, m.concepto || '—', m.categoria || 'Otro', m.folio || '—', m.envio, '+' + money(m.monto)]),
      foot: [[{ content: 'Total pagado', colSpan: 5, styles: { halign: 'right' } }, { content: '+' + money(d.total), styles: { halign: 'right', textColor: C.verde } }]],
      estiloCelda: (r, c, s) => (s === 'body' && c === 5 ? { color: C.verde, peso: 'medium' } : s === 'body' && c === 3 ? { color: C.gris } : null),
    });
    pies(doc);
    return doc;
  }

  /* =========================================================
     4) REPORTE FINANCIERO DEL MES (estado de cuenta)
     d: { periodo, generado, folio, cobrado, gastos, saldo, saldoIni, saldoFinal, cmpCobrado, cmpGastos,
          barras:{labels, ingresos, gastos}, categorias:{labels, data, hasData},
          movimientos:[{fecha, tipo, categoria, concepto, monto}] }
     Async: las gráficas se hornean con Chart.js (si no está cargado, el reporte sale sin ellas).
     ========================================================= */
  async function reporteFinanciero(d) {
    const doc = nuevoDoc(), W = ancho(doc);
    let y = encabezado(doc, { titulo: 'Reporte financiero', folio: d.folio, periodo: d.periodo, generado: d.generado });

    const cmp = (v, masEsMejor) => {
      if (v === null || v === undefined) return { nota: 'Sin datos del mes anterior' };
      const sube = v >= 0, bien = masEsMejor ? sube : !sube;
      return { nota: `${sube ? '+' : '-'}${Math.abs(v)}% vs. mes anterior`, notaColor: bien ? C.verde : C.rojo };
    };
    y = tarjetas(doc, y, [
      { etiqueta: 'Cobrado', valor: money(d.cobrado), tono: 'ok', ...cmp(d.cmpCobrado, true) },
      { etiqueta: 'Gastado', valor: money(d.gastos), tono: 'bad', ...cmp(d.cmpGastos, false) },
      { etiqueta: 'Saldo en caja', valor: money(d.saldoFinal), tono: 'ink', nota: `Inicial ${money(d.saldoIni)}  ${conSigno(d.saldo, d.saldo >= 0)} del mes` },
    ]);

    // Salud financiera: proporción gastos / cobrado.
    y = seccion(doc, y, 'Salud financiera del mes', 40);
    const bw = W - 2 * M;
    if (d.cobrado > 0) {
      const pct = Math.min(d.gastos / d.cobrado, 1), pctTxt = Math.round(pct * 100);
      const color = pct < 0.5 ? C.verde : pct < 0.8 ? [176, 128, 22] : C.rojo;
      doc.setFillColor(...C.linea); doc.roundedRect(M, y, bw, 7, 3.5, 3.5, 'F');
      doc.setFillColor(...color); doc.roundedRect(M, y, Math.max(bw * pct, 7), 7, 3.5, 3.5, 'F');
      linea(doc, [{ t: 'Los gastos representan el ', color: C.gris }, { t: `${pctTxt}%`, peso: 'bold', color }, { t: ' de lo recaudado este mes.', color: C.gris }], M, y + 22, 8.6);
    } else {
      fuente(doc, 'normal', 8.6, C.gris); doc.text('Sin cobros este mes: no hay datos para el indicador.', M, y + 8);
    }
    y += 40;

    const hayChart = typeof root.Chart !== 'undefined' && root.document;
    if (hayChart) {
      y = seccion(doc, y, 'Ingresos vs. gastos', 250);
      const img = await barrasImg(d.barras), ih = (bw - 20) * BARRAS_H / BARRAS_W;
      doc.setDrawColor(...C.linea); doc.setLineWidth(0.7); doc.roundedRect(M, y, bw, ih + 16, 5, 5, 'S');
      doc.addImage(img, 'PNG', M + 10, y + 8, bw - 20, ih, undefined, 'FAST');
      y += ih + 26;
      // leyenda
      let lx = W / 2 - 80;
      [['Ingresos', C.verde], ['Gastos', C.rojo]].forEach(([t, col]) => {
        doc.setFillColor(...col); doc.roundedRect(lx, y + 2, 9, 9, 2, 2, 'F');
        fuente(doc, 'medium', 8.6, C.tinta); doc.text(t, lx + 14, y + 10); lx += 90;
      });
      y += 30;

      y = seccion(doc, y, 'Gastos por categoría', 170);
      const cat = ordenarCategorias(d.categorias);
      const size = 148;
      doc.addImage(await donaImg(cat, money(d.gastos)), 'PNG', M, y - 4, size, size, undefined, 'FAST');
      leyendaCategorias(doc, cat, M + size + 28, W - M, y + 8);
      y += Math.max(size, cat.labels.length * 22 + 16) + 12;
    }

    y = seccion(doc, y, 'Movimientos del mes', 130);
    const movs = d.movimientos;
    tabla(doc, {
      y,
      cols: [{ t: 'Fecha', w: .17 }, { t: 'Categoría', w: .17 }, { t: 'Concepto', w: .45 }, { t: 'Monto', w: .21, align: 'right' }],
      body: movs.map(m => [m.fecha, m.categoria || 'Otro', m.concepto || '', conSigno(m.monto, m.tipo === 'ingreso')]),
      vacio: 'Sin movimientos este mes',
      foot: [
        [{ content: 'Saldo inicial del mes', colSpan: 3, styles: { halign: 'right', textColor: C.gris, fontStyle: estilo('medium') } }, { content: money(d.saldoIni), styles: { halign: 'right' } }],
        [{ content: 'Saldo del periodo', colSpan: 3, styles: { halign: 'right', textColor: C.gris, fontStyle: estilo('medium') } }, { content: conSigno(d.saldo, d.saldo >= 0), styles: { halign: 'right', textColor: d.saldo >= 0 ? C.verde : C.rojo } }],
        [{ content: 'Saldo final', colSpan: 3, styles: { halign: 'right', fontSize: 9.5 } }, { content: money(d.saldoFinal), styles: { halign: 'right', fontSize: 10.5 } }],
      ],
      estiloCelda: (r, c, s) => {
        if (s !== 'body') return null;
        const ing = movs[r].tipo === 'ingreso';
        if (c === 3) return { color: ing ? C.verde : C.rojo, peso: 'medium' };
        if (c === 1) return { color: ing ? C.verde : C.rojo };
        return null;
      },
    });
    pies(doc);
    return doc;
  }

  function ordenarCategorias(c) {
    if (!c || !c.hasData) return { labels: [], data: [], hasData: false };
    const ord = c.labels.map((_, i) => i).sort((a, b) => c.data[b] - c.data[a]);
    return { labels: ord.map(i => c.labels[i]), data: ord.map(i => c.data[i]), hasData: true };
  }
  function hexRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function leyendaCategorias(doc, cat, x0, x1, y) {
    if (!cat.hasData) { fuente(doc, 'normal', 9, C.gris); doc.text('Sin gastos registrados este mes.', x0, y + 10); return; }
    const total = cat.data.reduce((a, b) => a + b, 0) || 1;
    cat.labels.forEach((l, i) => {
      const ry = y + i * 22;
      doc.setFillColor(...hexRgb(PALETA_DONA[i % PALETA_DONA.length])); doc.roundedRect(x0, ry, 10, 10, 2, 2, 'F');
      fuente(doc, 'medium', 9, C.tinta); doc.text(l, x0 + 17, ry + 8.5);
      linea(doc, [{ t: `${Math.round(cat.data[i] / total * 100)}%   `, color: C.gris }, { t: money(cat.data[i]), peso: 'medium' }], x1, ry + 8.5, 9, 'right');
      doc.setDrawColor(...C.linea); doc.setLineWidth(0.5); doc.line(x0, ry + 15, x1, ry + 15);
    });
  }

  /* ---------------- Gráficas horneadas en alta resolución (solo para el PDF) ---------------- */
  const BARRAS_W = 1500, BARRAS_H = 560;
  const FUENTE_CANVAS = '"MarquesaPoppins", Helvetica, Arial, sans-serif';
  const tick = () => new Promise(r => setTimeout(r, 0));   // setTimeout, no rAF: rAF no corre en pestañas ocultas
  async function barrasImg({ labels, ingresos, gastos }) {
    const off = root.document.createElement('canvas'); off.width = BARRAS_W; off.height = BARRAS_H;
    const valores = {
      id: 'valores',
      afterDatasetsDraw(chart) {
        const { ctx } = chart;
        chart.data.datasets.forEach((ds, di) => chart.getDatasetMeta(di).data.forEach((bar, i) => {
          if (!ds.data[i]) return;
          ctx.save(); ctx.fillStyle = HEX.tinta; ctx.font = `600 20px ${FUENTE_CANVAS}`; ctx.textAlign = 'center';
          ctx.fillText(money(ds.data[i]), bar.x, bar.y - 12); ctx.restore();
        }));
      },
    };
    const chart = new root.Chart(off, {
      type: 'bar',
      data: { labels, datasets: [
        { label: 'Ingresos', data: ingresos, backgroundColor: HEX.verde, borderRadius: 6, maxBarThickness: 46 },
        { label: 'Gastos', data: gastos, backgroundColor: HEX.rojo, borderRadius: 6, maxBarThickness: 46 },
      ] },
      options: {
        responsive: false, animation: false, devicePixelRatio: 1, layout: { padding: { top: 36, right: 12 } },
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: {
          x: { ticks: { color: HEX.gris, font: { size: 22, family: FUENTE_CANVAS } }, grid: { display: false } },
          y: { ticks: { color: HEX.gris, font: { size: 19, family: FUENTE_CANVAS }, callback: v => money(v) }, grid: { color: HEX.linea }, border: { display: false }, beginAtZero: true },
        },
      },
      plugins: [valores],
    });
    await tick();
    const url = off.toDataURL('image/png'); chart.destroy(); return url;
  }
  async function donaImg(cat, totalTexto) {
    const off = root.document.createElement('canvas'); off.width = 900; off.height = 900;
    const labels = cat.hasData ? cat.labels : ['Sin gastos'], data = cat.hasData ? cat.data : [1];
    const centro = {
      id: 'centro',
      afterDraw(chart) {
        const { ctx, chartArea: a } = chart; if (!a) return;
        const cx = (a.left + a.right) / 2, cy = (a.top + a.bottom) / 2;
        ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = HEX.tinta; ctx.font = `700 64px ${FUENTE_CANVAS}`; ctx.fillText(totalTexto, cx, cy - 18);
        ctx.fillStyle = HEX.gris; ctx.font = `500 30px ${FUENTE_CANVAS}`; ctx.fillText('Total de gastos', cx, cy + 40);
        ctx.restore();
      },
    };
    const chart = new root.Chart(off, {
      type: 'doughnut',
      data: { labels, datasets: [{ data, backgroundColor: cat.hasData ? labels.map((_, i) => PALETA_DONA[i % PALETA_DONA.length]) : ['#e5e2dc'], borderColor: '#ffffff', borderWidth: 6 }] },
      options: { responsive: false, animation: false, devicePixelRatio: 1, cutout: '62%', layout: { padding: 20 }, plugins: { legend: { display: false }, tooltip: { enabled: false } } },
      plugins: [centro],
    });
    await tick();
    const url = off.toDataURL('image/png'); chart.destroy(); return url;
  }

  return { preparar, recibo, reporteAperturas, reporteCasa, reporteFinanciero, plural, motivoApertura, money };
});
