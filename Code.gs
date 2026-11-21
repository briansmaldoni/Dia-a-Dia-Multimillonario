/**
 * ============================================================
 * MINIMAL FINANCE — BACKEND MÓDULO DIARIO (Google Apps Script)
 * ============================================================
 */

// ============================================================
// 1. ESQUEMA DE LAS PESTAÑAS
// ============================================================

const SHEET_SCHEMAS = {
  Config: {
    columns: ['clave', 'valor'],
    types: { clave: 'string', valor: 'string' }
  },
  Movimientos: {
    columns: ['id', 'tipo', 'fechasAfectadas', 'monto', 'montoPorFecha', 'descripcion', 'usuario', 'fromBag', 'creadoEn'],
    types: {
      id: 'string', tipo: 'string', fechasAfectadas: 'json', monto: 'number',
      montoPorFecha: 'number', descripcion: 'string', usuario: 'string',
      fromBag: 'boolean', creadoEn: 'string'
    }
  },
  Feriados: {
    columns: ['id', 'year', 'month', 'day', 'descripcion'],
    types: { id: 'string', year: 'number', month: 'number', day: 'number', descripcion: 'string' }
  }
};

// ============================================================
// 2. ENTRY POINTS Y ROUTER
// ============================================================

function doPost(e) {
  try {
    const body = e && e.postData && e.postData.contents ? JSON.parse(e.postData.contents) : {};
    if (body && body.typeWebhook) {
      procesarWebhookGreenApi_(body);
      return HtmlService.createHtmlOutput('OK');
    }
    const resultado = ejecutarAccion_(body.action, body.payload || {});
    return responderJSON_({ ok: true, data: resultado });
  } catch (err) {
    return responderJSON_({ ok: false, error: err.message });
  }
}

function doGet(e) {
  try {
    const payload = e.parameter.payload ? JSON.parse(e.parameter.payload) : {};
    const resultado = ejecutarAccion_(e.parameter.action, payload);
    return responderJSON_({ ok: true, data: resultado });
  } catch (err) {
    return responderJSON_({ ok: false, error: err.message });
  }
}

function responderJSON_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function ejecutarAccion_(accion, payload) {
  switch (accion) {
    case 'getEstadoDiario': return getEstadoDiario_();
    case 'guardarMovimiento': return guardarMovimiento_(payload);
    case 'eliminarMovimiento': return eliminarMovimiento_(payload);
    case 'actualizarHB': return actualizarHB_(payload);
    case 'limpiarMovimientosPendientes': return limpiarMovimientosPendientes_();
    case 'resolverCierreDia': return resolverCierreDia_(payload);
    case 'actualizarConfig': return actualizarConfig_(payload);
    case 'enviarMensaje': return enviarMensaje_(payload);
    case 'enviarListaComprasWhatsApp': return enviarListaComprasWhatsApp_(payload);
    case 'guardarListaCompras': return guardarListaCompras_(payload);
    case 'diagnosticoConexion': return diagnosticoConexion_();
    default: throw new Error('Acción desconocida: ' + accion);
  }
}

// ============================================================
// 3. HELPERS OPTIMIZADOS DE HOJAS
// ============================================================

// Memoria de ejecución para la misma petición HTTP
let _ssActiva = null;
let _sheetsCache = {};
let _configCache = null;
let _filasCache = {};
let _cabecerasVerificadas = {};

function getActiveSpreadsheet_() {
  if (!_ssActiva) {
    _ssActiva = SpreadsheetApp.getActiveSpreadsheet();
  }
  return _ssActiva;
}

function invalidarCacheSheet_(sheetName) {
  delete _filasCache[sheetName];
  if (sheetName === 'Config') {
    _configCache = null;
  }
}

function asegurarCabecerasSheet_(sheet, sheetName) {
  if (_cabecerasVerificadas[sheetName]) return;
  const schema = SHEET_SCHEMAS[sheetName];
  if (!schema || !sheet) return;

  const maxCols = sheet.getMaxColumns();
  if (maxCols < schema.columns.length) {
    sheet.insertColumnsAfter(maxCols, schema.columns.length - maxCols);
  }

  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) {
    sheet.appendRow(schema.columns);
    sheet.setFrozenRows(1);
    _cabecerasVerificadas[sheetName] = true;
    return;
  }

  const colsToRead = Math.max(lastCol, schema.columns.length);
  const currentHeaders = sheet.getRange(1, 1, 1, colsToRead).getValues()[0];
  let changed = false;

  schema.columns.forEach((colName, idx) => {
    if (currentHeaders[idx] !== colName) {
      currentHeaders[idx] = colName;
      changed = true;
    }
  });

  if (changed) {
    sheet.getRange(1, 1, 1, currentHeaders.length).setValues([currentHeaders]);
  }
  _cabecerasVerificadas[sheetName] = true;
}

function asegurarCabeceras_(sheetName) {
  const ss = getActiveSpreadsheet_();
  let sheet = ss.getSheetByName(sheetName);
  if (sheet) {
    asegurarCabecerasSheet_(sheet, sheetName);
  }
}

function getSheet_(nombre, crearSiNoExiste) {
  if (_sheetsCache[nombre]) {
    return _sheetsCache[nombre];
  }
  const ss = getActiveSpreadsheet_();
  let sheet = ss.getSheetByName(nombre);
  if (!sheet && crearSiNoExiste) {
    sheet = ss.insertSheet(nombre);
    const schema = SHEET_SCHEMAS[nombre];
    if (schema) {
      sheet.appendRow(schema.columns);
      sheet.setFrozenRows(1);
      schema.columns.forEach((col, idx) => {
        const tipo = schema.types[col];
        if (tipo === 'string' || tipo === 'json') {
          sheet.getRange(2, idx + 1, 998, 1).setNumberFormat('@');
        }
      });
    }
    _sheetsCache[nombre] = sheet;
    return sheet;
  }
  if (sheet && SHEET_SCHEMAS[nombre]) {
    asegurarCabecerasSheet_(sheet, nombre);
  }
  if (sheet) {
    _sheetsCache[nombre] = sheet;
  }
  return sheet;
}

function castValor_(sheetName, col, raw) {
  const schema = SHEET_SCHEMAS[sheetName];
  const tipo = (schema && schema.types[col]) || 'string';
  if (raw === '' || raw === null || raw === undefined) {
    if (tipo === 'boolean') return false;
    if (tipo === 'number') return null;
    if (tipo === 'json') return [];
    return '';
  }
  if (raw instanceof Date) {
    return formatearFechaISO_(raw);
  }
  switch (tipo) {
    case 'number': {
      const n = Number(raw);
      return isNaN(n) ? null : n;
    }
    case 'boolean':
      return raw === true || raw === 'true' || raw === 1 || raw === '1';
    case 'json':
      if (typeof raw === 'object' && raw !== null) return raw;
      if (typeof raw === 'string') {
        try { return JSON.parse(raw); } catch (err) { return [raw]; }
      }
      return [];
    default:
      return String(raw);
  }
}

function leerFilas_(sheetName, forzarLectura = false) {
  if (!forzarLectura && _filasCache[sheetName]) {
    return _filasCache[sheetName];
  }
  const sheet = getSheet_(sheetName, true);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) {
    _filasCache[sheetName] = [];
    return [];
  }
  const headers = values[0];
  const filas = [];
  for (let i = 1; i < values.length; i++) {
    const rowValues = values[i];
    const vacia = rowValues.every(v => v === '' || v === null || v === undefined);
    if (vacia) continue;
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = castValor_(sheetName, h, rowValues[idx]); });
    obj._rowIndex = i + 1;
    filas.push(obj);
  }
  _filasCache[sheetName] = filas;
  return filas;
}

function limpiarFilaParaCliente_(fila) {
  const copia = Object.assign({}, fila);
  delete copia._rowIndex;
  return copia;
}

function filaDesdeObjeto_(sheetName, obj) {
  const schema = SHEET_SCHEMAS[sheetName];
  return schema.columns.map(col => {
    const tipo = schema.types[col];
    const v = obj[col];
    if (v === undefined || v === null) return '';
    if (tipo === 'json') return JSON.stringify(v);
    return v;
  });
}

function agregarFila_(sheetName, obj) {
  const sheet = getSheet_(sheetName, true);
  const fila = filaDesdeObjeto_(sheetName, obj);
  const maxCols = sheet.getMaxColumns();
  if (maxCols < fila.length) {
    sheet.insertColumnsAfter(maxCols, fila.length - maxCols);
  }
  sheet.appendRow(fila);
  invalidarCacheSheet_(sheetName);
}

function actualizarFilaPorId_(sheetName, id, obj) {
  const sheet = getSheet_(sheetName, true);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return false;
  const headers = values[0];
  const idColIdx = headers.indexOf('id');
  if (idColIdx === -1) return false;

  for (let i = 1; i < values.length; i++) {
    const cellId = String(values[i][idColIdx] || '').trim();
    if (cellId === String(id).trim()) {
      const fila = filaDesdeObjeto_(sheetName, obj);
      const maxCols = sheet.getMaxColumns();
      if (maxCols < fila.length) {
        sheet.insertColumnsAfter(maxCols, fila.length - maxCols);
      }
      sheet.getRange(i + 1, 1, 1, fila.length).setValues([fila]);
      invalidarCacheSheet_(sheetName);
      return true;
    }
  }
  return false;
}

function borrarFilaPorId_(sheetName, id) {
  const sheet = getSheet_(sheetName, true);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return false;
  const headers = values[0];
  const idColIdx = headers.indexOf('id');
  if (idColIdx === -1) return false;

  for (let i = 1; i < values.length; i++) {
    const cellId = String(values[i][idColIdx] || '').trim();
    if (cellId === String(id).trim()) {
      if (sheet.getMaxRows() <= 2) {
        sheet.getRange(i + 1, 1, 1, Math.max(sheet.getLastColumn(), headers.length)).clearContent();
      } else {
        sheet.deleteRow(i + 1);
      }
      invalidarCacheSheet_(sheetName);
      return true;
    }
  }
  return false;
}

function borrarFilaPorIndice_(sheetName, rowIndex) {
  const sheet = getSheet_(sheetName, true);
  sheet.deleteRow(rowIndex);
  invalidarCacheSheet_(sheetName);
}

// ============================================================
// 4. CONFIG (clave -> valor)
// ============================================================

function leerConfig_(forzarLectura = false) {
  if (!forzarLectura && _configCache) {
    return _configCache;
  }
  const cfg = {};
  leerFilas_('Config', forzarLectura).forEach(f => { cfg[f.clave] = f.valor; });
  _configCache = cfg;
  return cfg;
}

function getConfigNumero_(cfg, clave, porDefecto) {
  const v = cfg[clave];
  if (v === undefined || v === null || v === '') return porDefecto;
  const n = Number(v);
  return isNaN(n) ? porDefecto : n;
}

function escribirConfigSinLock_(cambios) {
  const keys = Object.keys(cambios || {});
  if (!keys.length) return;

  const sheet = getSheet_('Config', true);
  const values = sheet.getDataRange().getValues();
  const rows = values.slice(1).map(r => [r[0], r[1]]);
  const claves = rows.map(r => String(r[0] || '').trim());

  keys.forEach(clave => {
    const valor = String(cambios[clave]);
    const idx = claves.indexOf(clave);
    if (idx !== -1) {
      rows[idx][1] = valor;
    } else {
      rows.push([clave, valor]);
      claves.push(clave);
    }
  });

  if (rows.length > 0) {
    const maxRows = sheet.getMaxRows();
    if (maxRows < rows.length + 1) {
      sheet.insertRowsAfter(maxRows, rows.length + 1 - maxRows);
    }
    const range = sheet.getRange(2, 1, rows.length, 2);
    range.setNumberFormat('@');
    range.setValues(rows);
  }
  SpreadsheetApp.flush();
  invalidarCacheSheet_('Config');
}

function setConfigValores_(cambios) {
  const keys = Object.keys(cambios || {});
  if (!keys.length) return;

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    escribirConfigSinLock_(cambios);
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
// 5. FERIADOS ARGENTINA Y DÍA DE COBRO
// ============================================================

const FERIADOS_FIJOS = [
  { mes: 1, dia: 1, desc: 'Año Nuevo' },
  { mes: 3, dia: 24, desc: 'Día Nacional de la Memoria por la Verdad y la Justicia' },
  { mes: 4, dia: 2, desc: 'Día del Veterano y de los Caídos en la Guerra de Malvinas' },
  { mes: 5, dia: 1, desc: 'Día del Trabajador' },
  { mes: 5, dia: 25, desc: 'Día de la Revolución de Mayo' },
  { mes: 6, dia: 20, desc: 'Paso a la Inmortalidad del Gral. Belgrano' },
  { mes: 7, dia: 9, desc: 'Día de la Independencia' },
  { mes: 12, dia: 8, desc: 'Inmaculada Concepción de María' },
  { mes: 12, dia: 25, desc: 'Navidad' }
];

const FERIADOS_TRASLADABLES_BASE = [
  { mes: 6, dia: 17, desc: 'Paso a la Inmortalidad del Gral. Güemes' },
  { mes: 8, dia: 17, desc: 'Paso a la Inmortalidad del Gral. San Martín' },
  { mes: 10, dia: 12, desc: 'Día del Respeto a la Diversidad Cultural' },
  { mes: 11, dia: 20, desc: 'Día de la Soberanía Nacional' }
];

function calcularPascua_(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, mes - 1, dia);
}

function sumarDias_(fecha, dias) {
  const f = new Date(fecha.getTime());
  f.setDate(f.getDate() + dias);
  return f;
}

function mismaFecha_(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function aplicarTrasladoLunes_(fecha) {
  const diaSemana = fecha.getDay();
  if (diaSemana === 2) return sumarDias_(fecha, -1);
  if (diaSemana === 3) return sumarDias_(fecha, -2);
  if (diaSemana === 4) return sumarDias_(fecha, 4);
  if (diaSemana === 5) return sumarDias_(fecha, 3);
  return fecha;
}

function calcularFeriadosDelAnio_(year) {
  const feriados = [];
  FERIADOS_FIJOS.forEach(f => feriados.push(new Date(year, f.mes - 1, f.dia)));

  const pascua = calcularPascua_(year);
  feriados.push(sumarDias_(pascua, -48));
  feriados.push(sumarDias_(pascua, -47));
  feriados.push(sumarDias_(pascua, -2));

  FERIADOS_TRASLADABLES_BASE.forEach(f => {
    feriados.push(aplicarTrasladoLunes_(new Date(year, f.mes - 1, f.dia)));
  });

  return feriados;
}

function esFeriado_(fecha, feriadosExtra) {
  const delAnio = calcularFeriadosDelAnio_(fecha.getFullYear());
  if (delAnio.some(f => mismaFecha_(f, fecha))) return true;
  return feriadosExtra.some(f => f.year === fecha.getFullYear() && f.month === fecha.getMonth() && f.day === fecha.getDate());
}

function esHabil_(fecha, feriadosExtra) {
  const diaSemana = fecha.getDay();
  if (diaSemana === 0 || diaSemana === 6) return false;
  return !esFeriado_(fecha, feriadosExtra);
}

function calcularDiaCobro_(year, month, feriadosExtra) {
  let habiles = 0;
  for (let dia = 1; dia <= 15; dia++) {
    const fecha = new Date(year, month, dia);
    if (esHabil_(fecha, feriadosExtra)) {
      habiles++;
      if (habiles === 2) return fecha;
    }
  }
  throw new Error('No se pudo calcular el día de cobro para ' + year + '-' + (month + 1));
}

function calcularProximoCobro_(desde, feriadosExtra) {
  let year = desde.getFullYear();
  let month = desde.getMonth();
  let cobro = calcularDiaCobro_(year, month, feriadosExtra);
  if (cobro <= desde) {
    month++;
    if (month > 11) { month = 0; year++; }
    cobro = calcularDiaCobro_(year, month, feriadosExtra);
  }
  return cobro;
}

function formatearFechaISO_(fecha) {
  const y = fecha.getFullYear();
  const m = String(fecha.getMonth() + 1).padStart(2, '0');
  const d = String(fecha.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

function calcularDiasRestantes_(desde, feriadosExtra) {
  const cobro = calcularProximoCobro_(desde, feriadosExtra);
  const fechas = [];
  let f = new Date(desde.getFullYear(), desde.getMonth(), desde.getDate());
  while (f < cobro) {
    fechas.push(formatearFechaISO_(f));
    f = sumarDias_(f, 1);
  }
  return { diaCobro: formatearFechaISO_(cobro), fechas: fechas };
}

// ============================================================
// 6. MÓDULO DIARIO
// ============================================================

function getEstadoDiario_() {
  const cfg = leerConfig_();
  const feriadosExtra = leerFilas_('Feriados');
  const hoy = new Date();
  const diasInfo = calcularDiasRestantes_(hoy, feriadosExtra);
  const movimientos = leerFilas_('Movimientos').map(limpiarFilaParaCliente_);

  const ayerStr = formatearFechaISO_(sumarDias_(hoy, -1));
  const lastProcessedNorm = String(cfg.lastProcessedDate || '').trim();
  const rawExcluidos = normalizarDiasExcluidos_(parseJsonConfig_(cfg.diasExcluidos));
  const diasExcluidos = rawExcluidos.filter(f =>
    diasInfo.fechas.indexOf(f) !== -1 || f === ayerStr || (lastProcessedNorm && f === lastProcessedNorm)
  );

  const listaRaw = parseJsonConfig_(cfg.listaCompras);
  const hasBrianWa = !!(String(cfg.greenApiId_Brian || '').trim() && String(cfg.greenApiToken_Brian || '').trim());
  const hasVirginiaWa = !!(String(cfg.greenApiId_Virginia || '').trim() && String(cfg.greenApiToken_Virginia || '').trim());
  const whatsappConfigured = !!(String(cfg.whatsappGroupId || '').trim() && (hasBrianWa || hasVirginiaWa));

  return {
    homeBankingTotal: getConfigNumero_(cfg, 'homeBankingTotal', 0),
    bolsaTotal: getConfigNumero_(cfg, 'bolsaTotal', 0),
    lastProcessedDate: cfg.lastProcessedDate || null,
    diaCobro: diasInfo.diaCobro,
    diasRestantes: diasInfo.fechas,
    diasExcluidos: diasExcluidos,
    movimientos: movimientos,
    listaCompras: Array.isArray(listaRaw) ? listaRaw : [],
    whatsappConfigured: whatsappConfigured
  };
}

function guardarMovimiento_(data) {
  const monto = Number(data.monto);
  if (isNaN(monto) || monto <= 0) throw new Error('El monto debe ser un número estrictamente mayor a 0');
  if (!data.fechasAfectadas) throw new Error('Faltan fechas afectadas');

  let fechas = data.fechasAfectadas;
  if (typeof fechas === 'string') {
    try { fechas = JSON.parse(fechas); } catch(e) { fechas = [fechas]; }
  }
  if (!Array.isArray(fechas) || !fechas.length) throw new Error('Faltan fechas afectadas válidas');
  fechas = fechas.map(f => String(f).trim()).filter(Boolean);
  if (!fechas.length) throw new Error('Faltan fechas afectadas válidas');

  if (data.tipo !== 'single' && data.tipo !== 'divisible') throw new Error('Tipo inválido: ' + data.tipo);

  let obj = null;
  let waInfo = null;

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    invalidarCacheSheet_('Config');
    invalidarCacheSheet_('Movimientos');

    const cfg = leerConfig_(true);
    let hbTotal = getConfigNumero_(cfg, 'homeBankingTotal', 0);
    let bolsaTotal = getConfigNumero_(cfg, 'bolsaTotal', 0);

    const usuario = (data.usuario && String(data.usuario).trim()) ? String(data.usuario).trim() : (cfg.usuarioDefault || 'Brian');
    const actorUsuario = (data.actorUsuario && String(data.actorUsuario).trim()) ? String(data.actorUsuario).trim() : usuario;

    const id = data.id || Utilities.getUuid();
    const filasMov = leerFilas_('Movimientos', true);
    const movExistente = data.id ? filasMov.find(m => String(m.id).trim() === String(data.id).trim()) : null;

    if (movExistente) {
      hbTotal += (movExistente.monto || 0);
      if (movExistente.fromBag) {
        bolsaTotal += (movExistente.monto || 0);
      }
    }

    const nuevoMonto = monto;
    const nuevoFromBag = !!data.fromBag;

    hbTotal -= nuevoMonto;
    if (nuevoFromBag) {
      bolsaTotal -= nuevoMonto;
    }

    escribirConfigSinLock_({
      homeBankingTotal: hbTotal,
      bolsaTotal: bolsaTotal
    });

    obj = {
      id: id,
      tipo: data.tipo,
      fechasAfectadas: fechas,
      monto: nuevoMonto,
      montoPorFecha: nuevoMonto / fechas.length,
      descripcion: (data.descripcion || '').trim(),
      usuario: usuario,
      fromBag: nuevoFromBag,
      creadoEn: data.creadoEn || (movExistente ? movExistente.creadoEn : new Date().toISOString())
    };

    const actualizado = data.id ? actualizarFilaPorId_('Movimientos', id, obj) : false;
    if (!actualizado) agregarFila_('Movimientos', obj);

    if (!data.silencioso) {
      const esEdicion = !!(movExistente || actualizado);
      const descLimpia = obj.descripcion || (obj.tipo === 'divisible' ? 'Gasto divisible' : 'Gasto único');
      const montoTxt = formatearMonedaGS_(nuevoMonto);
      const extras = [];
      if (obj.tipo === 'divisible' && fechas.length > 1) {
        extras.push('en ' + fechas.length + ' días · ' + formatearMonedaGS_(obj.montoPorFecha) + '/día');
      }
      if (nuevoFromBag) {
        extras.push('desde ahorros');
      }
      const extraTxt = extras.length ? (' (' + extras.join(', ') + ')') : '';
      const antesTxt = (esEdicion && movExistente && Number(movExistente.monto) !== nuevoMonto)
        ? (' (antes ' + formatearMonedaGS_(movExistente.monto) + ')')
        : '';
      const dispTxt = (data.disponibleHoyTexto && String(data.disponibleHoyTexto).trim())
        ? ('\n💰 Disponible para hoy: *' + String(data.disponibleHoyTexto).trim() + '*')
        : '';
      const encabezado = esEdicion ? '✏️ Amorcito, edité este gasto:' : '💸 Amorcito, registré este gasto:';
      const mensajeWa = encabezado + '\n• *' + descLimpia + ':* ' + montoTxt + antesTxt + extraTxt + dispTxt;
      waInfo = { cfg: cfg, actorUsuario: actorUsuario, mensajeWa: mensajeWa };
    }
  } finally {
    lock.releaseLock();
  }

  if (waInfo) {
    enviarWhatsAppGreenApi_(waInfo.cfg, waInfo.actorUsuario, waInfo.mensajeWa);
  }

  return obj;
}

function eliminarMovimiento_(payload) {
  const id = (payload && typeof payload === 'object') ? payload.id : payload;
  if (!id) return false;
  const usuarioPayload = (payload && typeof payload === 'object' && payload.usuario) ? String(payload.usuario).trim() : '';
  const disponibleHoyTexto = (payload && typeof payload === 'object' && payload.disponibleHoyTexto) ? String(payload.disponibleHoyTexto).trim() : '';
  const silencioso = !!(payload && typeof payload === 'object' && payload.silencioso);

  let borrado = false;
  let waInfo = null;

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    invalidarCacheSheet_('Config');
    invalidarCacheSheet_('Movimientos');

    const filasMov = leerFilas_('Movimientos', true);
    const movExistente = filasMov.find(m => String(m.id).trim() === String(id).trim());

    if (movExistente) {
      const cfg = leerConfig_(true);
      let hbTotal = getConfigNumero_(cfg, 'homeBankingTotal', 0);
      let bolsaTotal = getConfigNumero_(cfg, 'bolsaTotal', 0);

      hbTotal += (movExistente.monto || 0);
      if (movExistente.fromBag) {
        bolsaTotal += (movExistente.monto || 0);
      }

      escribirConfigSinLock_({
        homeBankingTotal: hbTotal,
        bolsaTotal: bolsaTotal
      });

      borrado = borrarFilaPorId_('Movimientos', id);
      if (borrado && !silencioso) {
        const actorUsuario = usuarioPayload || movExistente.usuario || cfg.usuarioDefault || 'Brian';
        const descLimpia = movExistente.descripcion || (movExistente.tipo === 'divisible' ? 'Gasto divisible' : 'Gasto único');
        const montoTxt = formatearMonedaGS_(movExistente.monto || 0);
        const bolsaTxt = movExistente.fromBag ? ' (era de ahorros)' : '';
        const dispTxt = disponibleHoyTexto ? ('\n💰 Disponible para hoy: *' + disponibleHoyTexto + '*') : '';
        const mensajeWa = '🗑️ Amorcito, eliminé este gasto:\n• *' + descLimpia + ':* ' + montoTxt + bolsaTxt + dispTxt;
        waInfo = { cfg: cfg, actorUsuario: actorUsuario, mensajeWa: mensajeWa };
      }
    }
  } finally {
    lock.releaseLock();
  }

  if (waInfo) {
    enviarWhatsAppGreenApi_(waInfo.cfg, waInfo.actorUsuario, waInfo.mensajeWa);
  }
  return borrado;
}

function actualizarHB_(payload) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    invalidarCacheSheet_('Config');
    const cfgActual = leerConfig_(true);
    const feriadosExtra = leerFilas_('Feriados', true);
    const hoy = new Date();
    const diasInfo = calcularDiasRestantes_(hoy, feriadosExtra);
    const ayerStr = formatearFechaISO_(sumarDias_(hoy, -1));
    const lastProcessedNorm = String(cfgActual.lastProcessedDate || '').trim();

    const cambios = {};
    if (payload && payload.homeBankingTotal !== undefined && payload.homeBankingTotal !== null && payload.homeBankingTotal !== '') {
      const hb = Number(payload.homeBankingTotal);
      if (isNaN(hb)) throw new Error('homeBankingTotal inválido');
      cambios.homeBankingTotal = hb;
    }
    if (payload && payload.bolsaTotal !== undefined && payload.bolsaTotal !== null && payload.bolsaTotal !== '') {
      const bolsa = Number(payload.bolsaTotal);
      if (isNaN(bolsa) || bolsa < 0) throw new Error('bolsaTotal inválido');
      cambios.bolsaTotal = bolsa;
    }
    if (payload && Array.isArray(payload.diasExcluidos)) {
      const excluidosSolicitados = normalizarDiasExcluidos_(payload.diasExcluidos)
        .filter(f => diasInfo.fechas.indexOf(f) !== -1);
      if (diasInfo.fechas.length > 0 && excluidosSolicitados.length >= diasInfo.fechas.length) {
        throw new Error('Debe quedar al menos 1 día activo');
      }
      const previos = normalizarDiasExcluidos_(parseJsonConfig_(cfgActual.diasExcluidos));
      const historicosPreservados = previos.filter(f =>
        diasInfo.fechas.indexOf(f) === -1 && (f === ayerStr || (lastProcessedNorm && f === lastProcessedNorm))
      );
      cambios.diasExcluidos = JSON.stringify(normalizarDiasExcluidos_(excluidosSolicitados.concat(historicosPreservados)));
    }
    if (Object.keys(cambios).length > 0) {
      escribirConfigSinLock_(cambios);
    }
    const cfg = leerConfig_(true);
    const rawExcluidos = normalizarDiasExcluidos_(parseJsonConfig_(cfg.diasExcluidos));
    const diasExcluidos = rawExcluidos.filter(f =>
      diasInfo.fechas.indexOf(f) !== -1 || f === ayerStr || (lastProcessedNorm && f === lastProcessedNorm)
    );
    return {
      homeBankingTotal: getConfigNumero_(cfg, 'homeBankingTotal', 0),
      bolsaTotal: getConfigNumero_(cfg, 'bolsaTotal', 0),
      diasExcluidos: diasExcluidos
    };
  } finally {
    lock.releaseLock();
  }
}

function limpiarMovimientosPendientes_() {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    invalidarCacheSheet_('Movimientos');
    const sheet = getSheet_('Movimientos', true);
    const lastRow = sheet.getLastRow();
    const borrados = Math.max(0, lastRow - 1);
    if (borrados > 0) {
      const numCols = Math.max(sheet.getLastColumn(), SHEET_SCHEMAS.Movimientos.columns.length);
      sheet.getRange(2, 1, borrados, numCols).clearContent();
      SpreadsheetApp.flush();
      invalidarCacheSheet_('Movimientos');
    }
    return { borrados: borrados, candidatos: [] };
  } finally {
    lock.releaseLock();
  }
}

function resolverCierreDia_(payload) {
  const hoyStr = formatearFechaISO_(new Date());
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    invalidarCacheSheet_('Config');
    const cfg = leerConfig_(true);
    let bolsaActual = getConfigNumero_(cfg, 'bolsaTotal', 0);
    if (String(cfg.lastProcessedDate || '').trim() === hoyStr) {
      return { bolsaTotal: bolsaActual, lastProcessedDate: hoyStr };
    }

    const cambios = { lastProcessedDate: hoyStr };
    if (payload && payload.decision === 'bolsa') {
      const monto = Math.max(0, Number(payload.monto) || 0);
      if (payload.tipo === 'sobrante') {
        bolsaActual += monto;
      } else {
        bolsaActual = Math.max(bolsaActual - monto, 0);
      }
      cambios.bolsaTotal = bolsaActual;
    }

    escribirConfigSinLock_(cambios);
    return { bolsaTotal: bolsaActual, lastProcessedDate: hoyStr };
  } finally {
    lock.releaseLock();
  }
}

function actualizarConfig_(cambios) {
  setConfigValores_(cambios);
  return leerConfig_();
}

function parseJsonConfig_(rawVal) {
  if (!rawVal) return null;
  if (typeof rawVal === 'object') return rawVal;
  try {
    return JSON.parse(String(rawVal));
  } catch (e) {
    return null;
  }
}

function esFechaCalendarioValida_(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === (mo - 1) && dt.getDate() === d;
}

function normalizarDiasExcluidos_(raw) {
  let lista = raw;
  if (typeof lista === 'string') {
    lista = parseJsonConfig_(lista);
  }
  if (!Array.isArray(lista)) return [];
  const seen = {};
  return lista
    .map(f => String(f || '').trim())
    .filter(esFechaCalendarioValida_)
    .filter(f => {
      if (seen[f]) return false;
      seen[f] = true;
      return true;
    })
    .sort();
}

function formatearMonedaGS_(n) {
  const num = Math.round(Number(n) || 0);
  const sign = num < 0 ? '-$ ' : '$ ';
  const absStr = Math.abs(num).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return sign + absStr;
}

function getGreenApiCreds_(cfg, usuario) {
  const user = String(usuario || '').trim() === 'Virginia' ? 'Virginia' : 'Brian';
  const rawUrl = String((cfg && cfg['greenApiUrl_' + user]) || '').trim().replace(/\/+$/, '');
  return {
    usuario: user,
    apiUrl: rawUrl || 'https://api.green-api.com',
    idInstance: String((cfg && cfg['greenApiId_' + user]) || '').trim(),
    apiToken: String((cfg && cfg['greenApiToken_' + user]) || '').trim()
  };
}

function enviarWhatsAppGreenApi_(cfg, deUsuario, mensaje) {
  const chatId = String((cfg && cfg.whatsappGroupId) || '').trim();
  const creds = getGreenApiCreds_(cfg, deUsuario);
  const texto = String(mensaje || '').trim();

  if (!chatId || !creds.idInstance || !creds.apiToken || !texto) {
    return { sent: false, reason: 'missing_greenapi_config', usuario: creds.usuario };
  }

  try {
    const endpoint = creds.apiUrl +
      '/waInstance' + encodeURIComponent(creds.idInstance) +
      '/sendMessage/' + encodeURIComponent(creds.apiToken);

    const res = UrlFetchApp.fetch(endpoint, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ chatId: chatId, message: texto }),
      muteHttpExceptions: true
    });

    const status = res.getResponseCode();
    const bodyText = res.getContentText();
    return {
      sent: status >= 200 && status < 300,
      status: status,
      usuario: creds.usuario,
      response: bodyText
    };
  } catch (e) {
    return { sent: false, usuario: creds.usuario, error: String(e) };
  }
}

function listarGruposWhatsApp(usuario) {
  const cfg = leerConfig_(true);
  let creds = getGreenApiCreds_(cfg, usuario || 'Brian');
  if ((!creds.idInstance || !creds.apiToken) && !usuario) {
    const alt = getGreenApiCreds_(cfg, 'Virginia');
    if (alt.idInstance && alt.apiToken) creds = alt;
  }
  if (!creds.idInstance || !creds.apiToken) {
    Logger.log('Faltan credenciales greenApiId_' + creds.usuario + ' o greenApiToken_' + creds.usuario + ' en Config.');
    return [];
  }

  try {
    const endpoint = creds.apiUrl +
      '/waInstance' + encodeURIComponent(creds.idInstance) +
      '/getChats/' + encodeURIComponent(creds.apiToken);
    const res = UrlFetchApp.fetch(endpoint, { method: 'get', muteHttpExceptions: true });
    const status = res.getResponseCode();
    const bodyText = res.getContentText();
    if (status < 200 || status >= 300) {
      Logger.log('Error getChats (' + status + '): ' + bodyText);
      return [];
    }
    const chats = JSON.parse(bodyText);
    const grupos = (Array.isArray(chats) ? chats : [])
      .filter(c => c && (c.type === 'group' || String(c.id || '').endsWith('@g.us')))
      .map(c => ({ name: String(c.name || 'Grupo sin nombre'), id: String(c.id || '').trim() }));
    grupos.forEach(g => Logger.log(g.name + ' -> ' + g.id));
    return grupos;
  } catch (e) {
    Logger.log('Error listando grupos WhatsApp: ' + String(e));
    return [];
  }
}

function probarWhatsAppBrian() {
  const res = enviarWhatsAppGreenApi_(leerConfig_(true), 'Brian', '✅ Prueba de conexión desde Dia a Dia Multimillonarios!');
  Logger.log(JSON.stringify(res));
  return res;
}

function probarWhatsAppVirginia() {
  const res = enviarWhatsAppGreenApi_(leerConfig_(true), 'Virginia', '✅ Prueba de conexión desde Dia a Dia Multimillonarios!');
  Logger.log(JSON.stringify(res));
  return res;
}

const WA_PRESET_MESSAGES = [
  'Te amo mucho ❤️',
  'Ya actualicé la aplicación, te amo mucho ❤️'
];

function enviarMensaje_(payload) {
  const texto = String((payload && payload.texto) || '').trim().slice(0, 500);
  if (!texto) throw new Error('Escribí un mensaje antes de enviar');

  const cfg = leerConfig_();
  const deUsuario = (payload && payload.de && String(payload.de).trim()) || (cfg.usuarioDefault || 'Brian');
  const waResult = enviarWhatsAppGreenApi_(cfg, deUsuario, texto);
  return { ok: true, de: deUsuario, texto: texto, whatsapp: waResult };
}

function formatearListaComprasWhatsApp_(cfg) {
  const parsed = parseJsonConfig_(cfg && cfg.listaCompras);
  const lista = Array.isArray(parsed)
    ? parsed.map(normalizarItemListaCompras_).filter(Boolean)
    : [];
  const pendientes = lista.filter(it => !it.done);
  const comprados = lista.filter(it => it.done);

  if (!pendientes.length) {
    if (comprados.length > 0) {
      return '🛒 *Lista de compras actual:*\n¡No hay productos pendientes! ✨\n\n✅ _Tachados (' + comprados.length + '): ' + comprados.map(i => i.texto).join(', ') + '_';
    }
    return '🛒 *Lista de compras actual:*\nNo hay productos pendientes ✨';
  }

  let texto = '🛒 *Lista de compras actual* (' + pendientes.length + (pendientes.length === 1 ? ' pendiente' : ' pendientes') + '):\n' +
    pendientes.map(i => '• ' + i.texto).join('\n');
  if (comprados.length > 0) {
    texto += '\n\n✅ _Tachados (' + comprados.length + '): ' + comprados.map(i => i.texto).join(', ') + '_';
  }
  return texto;
}

function construirMenuWhatsApp_() {
  return [
    '📋 *Menú — Día a Día Multimillonarios*',
    '',
    'Respondé con un número (o escribí *lista* en cualquier momento):',
    '1️⃣ Consultar lista de compras actual 🛒',
    '2️⃣ ' + WA_PRESET_MESSAGES[0],
    '3️⃣ ' + WA_PRESET_MESSAGES[1]
  ].join('\n');
}

function enviarListaComprasWhatsApp_(payload) {
  const cfg = leerConfig_(true);
  const deUsuario = (payload && payload.de && String(payload.de).trim()) || (cfg.usuarioDefault || 'Brian');
  const texto = formatearListaComprasWhatsApp_(cfg);
  const waResult = enviarWhatsAppGreenApi_(cfg, deUsuario, texto);
  return { ok: true, de: deUsuario, texto: texto, whatsapp: waResult };
}

function procesarWebhookGreenApi_(body) {
  const tipo = String((body && body.typeWebhook) || '').trim();
  if (tipo !== 'outgoingMessageReceived' && tipo !== 'incomingMessageReceived') {
    return { handled: false, reason: 'ignored_type' };
  }

  const cfg = leerConfig_(true);
  const groupId = String((cfg && cfg.whatsappGroupId) || '').trim();
  const chatId = String((body && body.senderData && body.senderData.chatId) || '').trim();
  if (!groupId || chatId !== groupId) {
    return { handled: false, reason: 'ignored_chat' };
  }

  const idMsg = String((body && body.idMessage) || '').trim();
  const cache = CacheService.getScriptCache();
  if (idMsg) {
    const dedupKey = 'wa_msg_' + idMsg;
    if (cache.get(dedupKey)) return { handled: false, reason: 'duplicate' };
    cache.put(dedupKey, '1', 120);
  }

  const msgData = (body && body.messageData) || {};
  const rawText = String(
    (msgData.textMessageData && msgData.textMessageData.textMessage) ||
    (msgData.extendedTextMessageData && msgData.extendedTextMessageData.text) ||
    ''
  ).trim();
  if (!rawText) return { handled: false, reason: 'empty_text' };

  const cmd = rawText
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();

  const menuKey = 'wa_menu_activo_' + chatId;
  const menuActivo = !!cache.get(menuKey);
  let respuesta = '';

  if (cmd === 'menu' || cmd === '/menu' || cmd === '!menu' || cmd === 'ayuda' || cmd === '?') {
    respuesta = construirMenuWhatsApp_();
    cache.put(menuKey, '1', 300);
  } else if (
    cmd === 'lista' ||
    cmd === '/lista' ||
    cmd === '!lista' ||
    cmd === 'compras' ||
    cmd === 'lista de compras' ||
    cmd === '/1' ||
    (menuActivo && cmd === '1')
  ) {
    respuesta = formatearListaComprasWhatsApp_(cfg);
  } else if (cmd === '/2' || (menuActivo && cmd === '2')) {
    respuesta = WA_PRESET_MESSAGES[0];
  } else if (cmd === '/3' || (menuActivo && cmd === '3')) {
    respuesta = WA_PRESET_MESSAGES[1];
  } else {
    return { handled: false, reason: 'not_a_command' };
  }

  const idInst = String((body && body.instanceData && body.instanceData.idInstance) || '').trim();
  const instanciaUser = (idInst && String(cfg.greenApiId_Virginia || '').trim() === idInst) ? 'Virginia' : 'Brian';
  const actorUsuario = tipo === 'outgoingMessageReceived'
    ? instanciaUser
    : (instanciaUser === 'Virginia' ? 'Brian' : 'Virginia');
  const actorCreds = getGreenApiCreds_(cfg, actorUsuario);
  const usuarioEnvio = (actorCreds.idInstance && actorCreds.apiToken) ? actorUsuario : instanciaUser;

  const waResult = enviarWhatsAppGreenApi_(cfg, usuarioEnvio, respuesta);
  return { handled: true, command: cmd, usuario: usuarioEnvio, whatsapp: waResult };
}

function normalizarItemListaCompras_(it) {
  if (!it || typeof it !== 'object') return null;
  const texto = String(it.texto || '').trim().slice(0, 120);
  const id = String(it.id || '').trim();
  if (!id || !texto) return null;
  return {
    id: id,
    texto: texto,
    done: !!it.done,
    autor: String(it.autor || '').trim() || 'Brian',
    creadoEn: String(it.creadoEn || new Date().toISOString())
  };
}

function guardarListaCompras_(payload) {
  let lista = [];
  let waMensaje = '';
  let waUsuario = 'Brian';
  let cfgSnapshot = null;

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    invalidarCacheSheet_('Config');
    const cfg = leerConfig_(true);
    cfgSnapshot = cfg;
    const parsed = parseJsonConfig_(cfg.listaCompras);
    lista = Array.isArray(parsed)
      ? parsed.map(normalizarItemListaCompras_).filter(Boolean)
      : [];

    waUsuario = String(
      (payload && payload.usuario) ||
      (payload && payload.item && payload.item.autor) ||
      cfg.usuarioDefault ||
      'Brian'
    ).trim();

    const op = String((payload && payload.op) || '').trim();
    if (op === 'add' && payload.item) {
      const nuevo = normalizarItemListaCompras_(payload.item);
      if (nuevo) {
        const idx = lista.findIndex(x => String(x.id) === nuevo.id);
        if (idx >= 0) {
          lista[idx] = nuevo;
        } else {
          lista.unshift(nuevo);
          if (!nuevo.done) {
            waMensaje = '🛒 Amorcito, agregué a la lista de compras:\n- ' + nuevo.texto;
          }
        }
      }
    } else if (op === 'toggle' && payload.id) {
      const targetId = String(payload.id).trim();
      const idx = lista.findIndex(x => String(x.id) === targetId);
      if (idx >= 0) {
        const estabaHecho = !!lista[idx].done;
        const nuevoHecho = payload.done !== undefined ? !!payload.done : !estabaHecho;
        lista[idx].done = nuevoHecho;
        if (nuevoHecho !== estabaHecho) {
          waMensaje = nuevoHecho
            ? ('✅ Amorcito, taché de la lista de compras:\n- ' + lista[idx].texto)
            : ('🛒 Amorcito, volví a agregar a la lista de compras:\n- ' + lista[idx].texto);
        }
      } else if (Array.isArray(payload.items)) {
        lista = payload.items.map(normalizarItemListaCompras_).filter(Boolean);
      }
    } else if (op === 'delete' && payload.id) {
      const targetId = String(payload.id).trim();
      const idx = lista.findIndex(x => String(x.id) === targetId);
      if (idx >= 0) {
        if (!lista[idx].done) {
          waMensaje = '🛒 Amorcito, quité de la lista de compras:\n- ' + lista[idx].texto;
        }
        lista.splice(idx, 1);
      }
    } else if (op === 'clearDone') {
      lista = lista.filter(x => !x.done);
    } else if (Array.isArray(payload && payload.items)) {
      lista = payload.items.map(normalizarItemListaCompras_).filter(Boolean);
    }

    if (lista.length > 150) lista = lista.slice(0, 150);
    escribirConfigSinLock_({ listaCompras: JSON.stringify(lista) });
  } finally {
    lock.releaseLock();
  }

  let waResult = null;
  if (waMensaje && cfgSnapshot) {
    waResult = enviarWhatsAppGreenApi_(cfgSnapshot, waUsuario, waMensaje);
  }

  return { ok: true, listaCompras: lista, whatsapp: waResult };
}

// ============================================================
// 7. SETUP INICIAL
// ============================================================

function setupSheets() {
  Object.keys(SHEET_SCHEMAS).forEach(nombre => {
    asegurarCabeceras_(nombre);
    const schema = SHEET_SCHEMAS[nombre];
    const sheet = getSheet_(nombre, true);
    const filasFmt = Math.min(Math.max(sheet.getMaxRows() - 1, 1), 998);
    schema.columns.forEach((col, idx) => {
      const tipo = schema.types[col];
      if (tipo === 'string' || tipo === 'json') {
        sheet.getRange(2, idx + 1, filasFmt, 1).setNumberFormat('@');
      }
    });
  });

  const cfg = leerConfig_(true);
  setConfigValores_({
    homeBankingTotal: cfg.homeBankingTotal || '0',
    bolsaTotal: cfg.bolsaTotal || '0',
    lastProcessedDate: cfg.lastProcessedDate || formatearFechaISO_(new Date()),
    whatsappGroupId: cfg.whatsappGroupId || '',
    greenApiUrl_Brian: cfg.greenApiUrl_Brian || 'https://api.green-api.com',
    greenApiId_Brian: cfg.greenApiId_Brian || '',
    greenApiToken_Brian: cfg.greenApiToken_Brian || '',
    greenApiUrl_Virginia: cfg.greenApiUrl_Virginia || 'https://api.green-api.com',
    greenApiId_Virginia: cfg.greenApiId_Virginia || '',
    greenApiToken_Virginia: cfg.greenApiToken_Virginia || ''
  });

  limpiarConfigLegacy_();

  Logger.log('Setup y reparación completa. Pestañas y formatos asegurados: ' + Object.keys(SHEET_SCHEMAS).join(', '));
}

function limpiarConfigLegacy_() {
  const sheet = getSheet_('Config', false);
  if (!sheet) return;
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return;
  const legacyKeys = [
    'accentColorBrian',
    'accentColorVirginia',
    'onesignalAppId',
    'onesignalApiKey',
    'pushSub_Brian',
    'pushSub_Virginia',
    'ultimaNotificacion',
    'ultimoMensaje'
  ];
  for (let i = values.length - 1; i >= 1; i--) {
    const key = String(values[i][0] || '').trim();
    if (legacyKeys.includes(key)) {
      sheet.deleteRow(i + 1);
    }
  }
  invalidarCacheSheet_('Config');
}

function diagnosticoConexion_() {
  const resultado = {};
  Object.keys(SHEET_SCHEMAS).forEach(nombre => {
    const sheet = getSheet_(nombre, true);
    resultado[nombre] = {
      maxCols: sheet.getMaxColumns(),
      lastCol: sheet.getLastColumn(),
      headers: sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0]
    };
  });
  return resultado;
}
