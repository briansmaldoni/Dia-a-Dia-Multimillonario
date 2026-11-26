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

const MAX_BODY_CHARS_ = 65536;
const MAX_SECRET_CHARS_ = 256;
const MAX_MONEY_VALUE_ = 1e12;
const ALLOWED_USERS_ = Object.assign(Object.create(null), { Brian: 'Brian', Virginia: 'Virginia' });
const GREEN_API_URL_REGEX_ = /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+green-?api\.com$/i;
const ALLOWED_CONFIG_KEYS_ = Object.assign(Object.create(null), {
  homeBankingTotal: true,
  bolsaTotal: true,
  lastProcessedDate: true,
  diasExcluidos: true,
  listaCompras: true,
  whatsappGroupId: true,
  greenApiUrl_Brian: true,
  greenApiId_Brian: true,
  greenApiUrl_Virginia: true,
  greenApiId_Virginia: true,
  usuarioDefault: true
});

function crearErrorApp_(code, message) {
  const err = new Error(message || 'Error en la solicitud');
  err.appCode = code || 'VALIDATION_ERROR';
  err.isPublic = true;
  return err;
}

function redactarSecretosTexto_(str) {
  return String(str || '')
    .replace(/(\/waInstance\d+\/[A-Za-z0-9_-]+\/)[^/\s"'?&]+/gi, '$1[REDACTED]')
    .replace(/\/(sendMessage|getChats)\/[^/\s"'?&]+/gi, '/$1/[REDACTED]')
    .replace(/([?&]wh=)[^&\s"']+/gi, '$1[REDACTED]')
    .replace(/("accessKey"\s*:\s*")[^"]*"/gi, '$1[REDACTED]"');
}

function constantTimeEquals_(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const da = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, a, Utilities.Charset.UTF_8);
  const db = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, b, Utilities.Charset.UTF_8);
  if (!da || !db || da.length !== db.length) return false;
  let diff = 0;
  for (let i = 0; i < da.length; i++) {
    diff |= (da[i] ^ db[i]);
  }
  return diff === 0;
}

function generarTokenSeguro_(len = 32) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let out = '';
  let round = 0;
  while (out.length < len) {
    round++;
    const seed = Utilities.getUuid() + '|' + Date.now() + '|' + round;
    const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, seed, Utilities.Charset.UTF_8);
    for (let i = 0; i < digest.length && out.length < len; i++) {
      out += alphabet[(digest[i] & 0xff) % alphabet.length];
    }
  }
  return out;
}

function getScriptProp_(key) {
  let propsObj = _scriptPropsCache;
  if (!propsObj) {
    try {
      propsObj = PropertiesService.getScriptProperties().getProperties() || {};
      _scriptPropsCache = propsObj;
    } catch (e) {
      Logger.log('Error leyendo ScriptProperties: ' + redactarSecretosTexto_(String(e)));
      throw crearErrorApp_('SERVICE_UNAVAILABLE', 'Servicio de propiedades temporalmente no disponible');
    }
  }
  return Object.prototype.hasOwnProperty.call(propsObj, key)
    ? String(propsObj[key] || '').trim()
    : '';
}

function validarAccesoApi_(body) {
  const expected = getScriptProp_('APP_ACCESS_KEY');
  if (expected.length < 16) {
    throw crearErrorApp_('AUTH_NOT_CONFIGURED', 'Falta activar la clave de acceso en Apps Script (ejecutá generarClaveAcceso)');
  }
  const provided = (body && typeof body.accessKey === 'string') ? body.accessKey.trim() : '';
  if (!provided || provided.length > MAX_SECRET_CHARS_ || !constantTimeEquals_(provided, expected)) {
    throw crearErrorApp_('UNAUTHORIZED', 'Clave de acceso inválida o faltante');
  }
}

function validarWebhookSecret_(e) {
  const expected = getScriptProp_('WEBHOOK_SECRET');
  if (expected.length < 16) return false;
  const arr = e && e.parameters && e.parameters.wh;
  let cand = '';
  if (Array.isArray(arr)) {
    if (arr.length !== 1) return false;
    cand = String(arr[0] || '').trim();
  } else {
    const single = e && e.parameter && e.parameter.wh;
    cand = String(single || '').trim();
  }
  if (!cand || cand.length > MAX_SECRET_CHARS_) return false;
  return constantTimeEquals_(cand, expected);
}

function doPost(e) {
  try {
    const hasWebhookParam = Boolean(e && ((e.parameter && e.parameter.wh !== undefined) || (e.parameters && e.parameters.wh !== undefined)));
    let webhookAuthorized = false;
    if (hasWebhookParam) {
      if (!validarWebhookSecret_(e)) {
        return ContentService.createTextOutput('UNAUTHORIZED').setMimeType(ContentService.MimeType.TEXT);
      }
      webhookAuthorized = true;
    }

    const rawBody = (e && e.postData && typeof e.postData.contents === 'string') ? e.postData.contents : '';
    if (rawBody.length > MAX_BODY_CHARS_) {
      throw crearErrorApp_('PAYLOAD_TOO_LARGE', 'La solicitud supera el tamaño máximo permitido');
    }
    let body = {};
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch (parseErr) {
        throw crearErrorApp_('VALIDATION_ERROR', 'Formato JSON inválido');
      }
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw crearErrorApp_('VALIDATION_ERROR', 'Cuerpo JSON inválido');
    }

    if (body.typeWebhook !== undefined || hasWebhookParam) {
      if (!webhookAuthorized && !validarWebhookSecret_(e)) {
        return ContentService.createTextOutput('UNAUTHORIZED').setMimeType(ContentService.MimeType.TEXT);
      }
      if (body.typeWebhook) {
        procesarWebhookGreenApi_(body);
      }
      return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
    }

    validarAccesoApi_(body);
    const resultado = ejecutarAccion_(body.action, body.payload || {});
    return responderJSON_({ ok: true, data: resultado });
  } catch (err) {
    if (err && err.isPublic) {
      return responderJSON_({ ok: false, code: err.appCode || 'VALIDATION_ERROR', error: err.message });
    }
    const rawMsg = String((err && err.message) || err || '');
    if (/lock|timeout/i.test(rawMsg)) {
      return responderJSON_({ ok: false, code: 'LOCK_TIMEOUT', error: 'Servidor ocupado, reintentá en unos segundos' });
    }
    Logger.log('Error interno en doPost: ' + redactarSecretosTexto_(String((err && err.stack) || rawMsg)));
    return responderJSON_({ ok: false, code: 'INTERNAL_ERROR', error: 'Error interno del servidor' });
  }
}

function doGet(_e) {
  return responderJSON_({ ok: false, code: 'METHOD_NOT_ALLOWED', error: 'Método no permitido' });
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
    case 'resolverCierreDia': return resolverCierreDia_(payload);
    case 'enviarMensaje': return enviarMensaje_(payload);
    case 'enviarListaComprasWhatsApp': return enviarListaComprasWhatsApp_(payload);
    case 'guardarListaCompras': return guardarListaCompras_(payload);
    default: throw crearErrorApp_('UNKNOWN_ACTION', 'Acción no permitida');
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
let _scriptPropsCache = null;

function invalidarScriptPropsCache_() {
  _scriptPropsCache = null;
}

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

function aplicarFormatoTextoColumnas_(sheet, sheetName, startRow, numRows) {
  const schema = SHEET_SCHEMAS[sheetName];
  if (!schema || !sheet || numRows < 1) return;
  schema.columns.forEach((col, idx) => {
    const tipo = schema.types[col];
    if (tipo === 'string' || tipo === 'json') {
      sheet.getRange(startRow, idx + 1, numRows, 1).setNumberFormat('@');
    }
  });
}

function agregarFila_(sheetName, obj) {
  const sheet = getSheet_(sheetName, true);
  const fila = filaDesdeObjeto_(sheetName, obj);
  const maxCols = sheet.getMaxColumns();
  if (maxCols < fila.length) {
    sheet.insertColumnsAfter(maxCols, fila.length - maxCols);
  }
  const nextRow = Math.max(sheet.getLastRow() + 1, 2);
  const maxRows = sheet.getMaxRows();
  if (maxRows < nextRow) {
    sheet.insertRowsAfter(maxRows, nextRow - maxRows);
  }
  aplicarFormatoTextoColumnas_(sheet, sheetName, nextRow, 1);
  sheet.getRange(nextRow, 1, 1, fila.length).setValues([fila]);
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
      aplicarFormatoTextoColumnas_(sheet, sheetName, i + 1, 1);
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
  const cfg = Object.create(null);
  leerFilas_('Config', forzarLectura).forEach(f => {
    const clave = String(f.clave || '').trim();
    if (clave) cfg[clave] = f.valor;
  });
  _configCache = cfg;
  return cfg;
}

function getConfigNumero_(cfg, clave, porDefecto) {
  const v = cfg[clave];
  if (v === undefined || v === null || v === '') return porDefecto;
  const n = Number(v);
  return Number.isFinite(n) ? n : porDefecto;
}

function escribirConfigSinLock_(cambios) {
  const keys = Object.keys(cambios || {});
  if (!keys.length) return;

  const sheet = getSheet_('Config', true);
  const values = sheet.getDataRange().getValues();
  const rows = values.slice(1).map(r => [r[0], r[1]]);
  const claves = rows.map(r => String(r[0] || '').trim());

  keys.forEach(rawClave => {
    const clave = String(rawClave || '').trim();
    if (!ALLOWED_CONFIG_KEYS_[clave]) {
      throw crearErrorApp_('VALIDATION_ERROR', 'Clave de configuración no permitida: ' + clave);
    }
    const valor = String(cambios[rawClave]);
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

function esIdSeguro_(id) {
  return /^[A-Za-z0-9_][A-Za-z0-9._-]{0,79}$/.test(String(id || '').trim());
}

function normalizarUsuarioPermitido_(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    const fb = String(fallback || '').trim();
    return ALLOWED_USERS_[fb] || 'Brian';
  }
  const clean = String(raw).trim();
  if (!ALLOWED_USERS_[clean]) {
    throw crearErrorApp_('VALIDATION_ERROR', 'Usuario no permitido');
  }
  return ALLOWED_USERS_[clean];
}

function sanitizarDescripcion_(raw, maxLen) {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') throw crearErrorApp_('VALIDATION_ERROR', 'Descripción inválida');
  return raw
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen)
    .replace(/^[\s=+\-@']+/, '')
    .trim();
}

function normalizarDisponibleHoyTexto_(raw) {
  if (raw === undefined || raw === null) return '';
  const s = String(raw).replace(/[\r\n\t]+/g, ' ').trim();
  if (!s || s.length > 28) return '';
  return /^-?\$\s?[\d.,]{1,22}$/.test(s) ? s : '';
}

function hashSha256Hex_(str) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(str || ''), Utilities.Charset.UTF_8);
  return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

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
  const credsBrian = getGreenApiCreds_(cfg, 'Brian');
  const credsVirginia = getGreenApiCreds_(cfg, 'Virginia');
  const hasBrianWa = !!(credsBrian.idInstance && credsBrian.apiToken && credsBrian.apiUrl);
  const hasVirginiaWa = !!(credsVirginia.idInstance && credsVirginia.apiToken && credsVirginia.apiUrl);
  const chatIdOk = /^[0-9-]+@(g\.us|c\.us)$/.test(String(cfg.whatsappGroupId || '').trim());
  const whatsappConfigured = !!(chatIdOk && (hasBrianWa || hasVirginiaWa));

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
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw crearErrorApp_('VALIDATION_ERROR', 'Datos de movimiento inválidos');
  }
  const monto = Number(data.monto);
  if (!Number.isFinite(monto) || monto <= 0 || monto > MAX_MONEY_VALUE_) {
    throw crearErrorApp_('VALIDATION_ERROR', 'El monto debe ser un número válido mayor a 0');
  }
  if (data.tipo !== 'single' && data.tipo !== 'divisible') {
    throw crearErrorApp_('VALIDATION_ERROR', 'Tipo de gasto inválido');
  }
  if (!data.fechasAfectadas) throw crearErrorApp_('VALIDATION_ERROR', 'Faltan fechas afectadas');

  let rawFechas = data.fechasAfectadas;
  if (typeof rawFechas === 'string') {
    try { rawFechas = JSON.parse(rawFechas); } catch (e) { rawFechas = [rawFechas]; }
  }
  if (!Array.isArray(rawFechas) || !rawFechas.length) {
    throw crearErrorApp_('VALIDATION_ERROR', 'Faltan fechas afectadas válidas');
  }
  const seenFechas = Object.create(null);
  const fechas = [];
  for (let i = 0; i < rawFechas.length && fechas.length < 62; i++) {
    const f = String(rawFechas[i] || '').trim();
    if (esFechaCalendarioValida_(f) && !seenFechas[f]) {
      seenFechas[f] = true;
      fechas.push(f);
    }
  }
  if (!fechas.length) throw crearErrorApp_('VALIDATION_ERROR', 'Faltan fechas afectadas válidas');
  if (data.tipo === 'single' && fechas.length > 1) {
    throw crearErrorApp_('VALIDATION_ERROR', 'Un gasto único solo puede asignarse a 1 fecha');
  }

  let hasClientId = false;
  let id = '';
  if (data.id !== undefined && data.id !== null && String(data.id).trim() !== '') {
    const candId = String(data.id).trim();
    if (!esIdSeguro_(candId)) {
      throw crearErrorApp_('VALIDATION_ERROR', 'ID de movimiento inválido');
    }
    id = candId;
    hasClientId = true;
  } else {
    id = Utilities.getUuid();
  }

  const descripcion = sanitizarDescripcion_(data.descripcion === undefined ? '' : data.descripcion, 200);
  const dispHoyLimpio = normalizarDisponibleHoyTexto_(data.disponibleHoyTexto);

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

    const usuario = normalizarUsuarioPermitido_(data.usuario, cfg.usuarioDefault || 'Brian');
    const actorUsuario = normalizarUsuarioPermitido_(data.actorUsuario, usuario);

    const filasMov = leerFilas_('Movimientos', true);
    const movExistente = hasClientId ? filasMov.find(m => String(m.id).trim() === id) : null;

    const nuevoMonto = monto;
    const nuevoFromBag = !!data.fromBag;
    const fechasOrdenadasExist = movExistente
      ? (Array.isArray(movExistente.fechasAfectadas) ? movExistente.fechasAfectadas.slice().sort() : [])
      : [];
    const fechasOrdenadasNuevas = fechas.slice().sort();
    const mismasFechas = Boolean(movExistente && JSON.stringify(fechasOrdenadasExist) === JSON.stringify(fechasOrdenadasNuevas));

    if (
      movExistente &&
      Number(movExistente.monto) === nuevoMonto &&
      movExistente.tipo === data.tipo &&
      String(movExistente.descripcion || '') === descripcion &&
      Boolean(movExistente.fromBag) === nuevoFromBag &&
      mismasFechas
    ) {
      return limpiarFilaParaCliente_(movExistente);
    }

    if (movExistente) {
      hbTotal += (Number(movExistente.monto) || 0);
      if (movExistente.fromBag) {
        bolsaTotal += (Number(movExistente.monto) || 0);
      }
    }

    hbTotal -= nuevoMonto;
    if (nuevoFromBag) {
      bolsaTotal -= nuevoMonto;
    }

    obj = {
      id: id,
      tipo: data.tipo,
      fechasAfectadas: fechas,
      monto: nuevoMonto,
      montoPorFecha: nuevoMonto / fechas.length,
      descripcion: descripcion,
      usuario: usuario,
      fromBag: nuevoFromBag,
      creadoEn: (movExistente && movExistente.creadoEn) ? movExistente.creadoEn : new Date().toISOString()
    };

    const actualizado = movExistente ? actualizarFilaPorId_('Movimientos', id, obj) : false;
    if (!actualizado) agregarFila_('Movimientos', obj);

    escribirConfigSinLock_({
      homeBankingTotal: hbTotal,
      bolsaTotal: bolsaTotal
    });

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
      const dispTxt = dispHoyLimpio
        ? ('\n💰 Disponible para hoy: *' + dispHoyLimpio + '*')
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
  const rawId = (payload && typeof payload === 'object') ? payload.id : payload;
  const id = String(rawId || '').trim();
  if (!id || !esIdSeguro_(id)) {
    throw crearErrorApp_('VALIDATION_ERROR', 'ID de movimiento inválido');
  }
  const hasUsuarioPayload = Boolean(payload && typeof payload === 'object' && payload.usuario && String(payload.usuario).trim());
  const usuarioPayload = hasUsuarioPayload ? normalizarUsuarioPermitido_(payload.usuario, 'Brian') : '';
  const disponibleHoyTexto = normalizarDisponibleHoyTexto_(payload && typeof payload === 'object' ? payload.disponibleHoyTexto : '');
  const silencioso = !!(payload && typeof payload === 'object' && payload.silencioso);

  let borrado = false;
  let waInfo = null;

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    invalidarCacheSheet_('Config');
    invalidarCacheSheet_('Movimientos');

    const filasMov = leerFilas_('Movimientos', true);
    const movExistente = filasMov.find(m => String(m.id).trim() === id);

    if (movExistente) {
      const cfg = leerConfig_(true);
      let hbTotal = getConfigNumero_(cfg, 'homeBankingTotal', 0);
      let bolsaTotal = getConfigNumero_(cfg, 'bolsaTotal', 0);

      hbTotal += (Number(movExistente.monto) || 0);
      if (movExistente.fromBag) {
        bolsaTotal += (Number(movExistente.monto) || 0);
      }

      borrado = borrarFilaPorId_('Movimientos', id);
      if (borrado) {
        escribirConfigSinLock_({
          homeBankingTotal: hbTotal,
          bolsaTotal: bolsaTotal
        });
        if (!silencioso) {
          const actorUsuario = usuarioPayload || normalizarUsuarioPermitido_(movExistente.usuario, cfg.usuarioDefault || 'Brian');
          const descBase = sanitizarDescripcion_(String(movExistente.descripcion || ''), 140);
          const descLimpia = descBase || (movExistente.tipo === 'divisible' ? 'Gasto divisible' : 'Gasto único');
          const montoTxt = formatearMonedaGS_(movExistente.monto || 0);
          const bolsaTxt = movExistente.fromBag ? ' (era de ahorros)' : '';
          const dispTxt = disponibleHoyTexto ? ('\n💰 Disponible para hoy: *' + disponibleHoyTexto + '*') : '';
          const mensajeWa = '🗑️ Amorcito, eliminé este gasto:\n• *' + descLimpia + ':* ' + montoTxt + bolsaTxt + dispTxt;
          waInfo = { cfg: cfg, actorUsuario: actorUsuario, mensajeWa: mensajeWa };
        }
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
  if (payload && (typeof payload !== 'object' || Array.isArray(payload))) {
    throw crearErrorApp_('VALIDATION_ERROR', 'Datos de actualización inválidos');
  }
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
      if (!Number.isFinite(hb) || Math.abs(hb) > MAX_MONEY_VALUE_) {
        throw crearErrorApp_('VALIDATION_ERROR', 'homeBankingTotal inválido');
      }
      cambios.homeBankingTotal = hb;
    }
    if (payload && payload.bolsaTotal !== undefined && payload.bolsaTotal !== null && payload.bolsaTotal !== '') {
      const bolsa = Number(payload.bolsaTotal);
      if (!Number.isFinite(bolsa) || bolsa < 0 || bolsa > MAX_MONEY_VALUE_) {
        throw crearErrorApp_('VALIDATION_ERROR', 'bolsaTotal inválido');
      }
      cambios.bolsaTotal = bolsa;
    }
    if (payload && Array.isArray(payload.diasExcluidos)) {
      const excluidosSolicitados = normalizarDiasExcluidos_(payload.diasExcluidos.slice(0, 100))
        .filter(f => diasInfo.fechas.indexOf(f) !== -1);
      if (diasInfo.fechas.length > 0 && excluidosSolicitados.length >= diasInfo.fechas.length) {
        throw crearErrorApp_('VALIDATION_ERROR', 'Debe quedar al menos 1 día activo');
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

function resolverCierreDia_(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw crearErrorApp_('VALIDATION_ERROR', 'Datos de cierre inválidos');
  }
  const decision = String(payload.decision || 'redistribuir').trim();
  if (decision !== 'bolsa' && decision !== 'redistribuir') {
    throw crearErrorApp_('VALIDATION_ERROR', 'Decisión de cierre inválida');
  }
  const tipo = String(payload.tipo || 'sobrante').trim();
  if (tipo !== 'sobrante' && tipo !== 'deficit') {
    throw crearErrorApp_('VALIDATION_ERROR', 'Tipo de cierre inválido');
  }
  const monto = payload.monto === undefined || payload.monto === null || payload.monto === '' ? 0 : Number(payload.monto);
  if (!Number.isFinite(monto) || monto < 0 || monto > MAX_MONEY_VALUE_) {
    throw crearErrorApp_('VALIDATION_ERROR', 'Monto de cierre inválido');
  }

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
    if (decision === 'bolsa') {
      if (tipo === 'sobrante') {
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
  const user = normalizarUsuarioPermitido_(usuario, 'Brian');
  const rawUrl = String((cfg && cfg['greenApiUrl_' + user]) || '').trim().replace(/\/+$/, '');
  const apiUrl = rawUrl
    ? (GREEN_API_URL_REGEX_.test(rawUrl) ? rawUrl : '')
    : 'https://api.green-api.com';
  const rawId = String((cfg && cfg['greenApiId_' + user]) || '').trim();
  const idInstance = /^\d{4,20}$/.test(rawId) ? rawId : '';
  const propToken = getScriptProp_('greenApiToken_' + user);
  return {
    usuario: user,
    apiUrl: apiUrl,
    idInstance: idInstance,
    apiToken: propToken
  };
}

function enviarWhatsAppGreenApi_(cfg, deUsuario, mensaje) {
  const chatId = String((cfg && cfg.whatsappGroupId) || '').trim();
  const creds = getGreenApiCreds_(cfg, deUsuario);
  const texto = String(mensaje || '').trim();

  if (!/^[0-9-]+@(g\.us|c\.us)$/.test(chatId) || !creds.apiUrl || !creds.idInstance || !creds.apiToken || !texto) {
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
      muteHttpExceptions: true,
      followRedirects: false
    });

    const status = res.getResponseCode();
    if (status < 200 || status >= 300) {
      Logger.log('Green API HTTP ' + status + ' para ' + creds.usuario);
    }
    return {
      sent: status >= 200 && status < 300,
      status: status,
      usuario: creds.usuario
    };
  } catch (e) {
    Logger.log('Error enviando WhatsApp (' + creds.usuario + '): ' + redactarSecretosTexto_(String(e)));
    return { sent: false, reason: 'network_error', usuario: creds.usuario };
  }
}

function listarGruposWhatsApp(usuario) {
  const cfg = leerConfig_(true);
  let creds = getGreenApiCreds_(cfg, usuario || 'Brian');
  if ((!creds.idInstance || !creds.apiToken) && !usuario) {
    const alt = getGreenApiCreds_(cfg, 'Virginia');
    if (alt.idInstance && alt.apiToken) creds = alt;
  }
  if (!creds.apiUrl || !creds.idInstance || !creds.apiToken) {
    Logger.log('Faltan credenciales de Green API válidas para ' + creds.usuario + '.');
    return [];
  }

  try {
    const endpoint = creds.apiUrl +
      '/waInstance' + encodeURIComponent(creds.idInstance) +
      '/getChats/' + encodeURIComponent(creds.apiToken);
    const res = UrlFetchApp.fetch(endpoint, { method: 'get', muteHttpExceptions: true, followRedirects: false });
    const status = res.getResponseCode();
    const bodyText = res.getContentText();
    if (status < 200 || status >= 300) {
      Logger.log('Error getChats (' + status + ') para ' + creds.usuario);
      return [];
    }
    const chats = JSON.parse(bodyText);
    const grupos = (Array.isArray(chats) ? chats : [])
      .filter(c => c && (c.type === 'group' || String(c.id || '').endsWith('@g.us')))
      .map(c => ({ name: String(c.name || 'Grupo sin nombre'), id: String(c.id || '').trim() }));
    grupos.forEach(g => Logger.log(g.name + ' -> ' + g.id));
    return grupos;
  } catch (e) {
    Logger.log('Error listando grupos WhatsApp: ' + redactarSecretosTexto_(String(e)));
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
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw crearErrorApp_('VALIDATION_ERROR', 'Datos de mensaje inválidos');
  }
  const rawTexto = typeof payload.texto === 'string' ? payload.texto : '';
  const texto = rawTexto.trim().slice(0, 500);
  if (!texto) throw crearErrorApp_('VALIDATION_ERROR', 'Escribí un mensaje antes de enviar');

  const cfg = leerConfig_();
  const deUsuario = normalizarUsuarioPermitido_(payload.de, cfg.usuarioDefault || 'Brian');
  const waResult = enviarWhatsAppGreenApi_(cfg, deUsuario, texto);
  return { ok: true, de: deUsuario, texto: texto, whatsapp: waResult };
}

function formatearListaComprasWhatsApp_(cfg) {
  const parsed = parseJsonConfig_(cfg && cfg.listaCompras);
  const lista = Array.isArray(parsed)
    ? parsed.map(it => normalizarItemListaCompras_(it)).filter(Boolean)
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
  const deUsuario = normalizarUsuarioPermitido_(payload && payload.de, cfg.usuarioDefault || 'Brian');
  const texto = formatearListaComprasWhatsApp_(cfg);
  const waResult = enviarWhatsAppGreenApi_(cfg, deUsuario, texto);
  return { ok: true, de: deUsuario, texto: texto, whatsapp: waResult };
}

function procesarWebhookGreenApi_(body) {
  const tipo = String((body && body.typeWebhook) || '').trim();
  if (tipo !== 'outgoingMessageReceived' && tipo !== 'incomingMessageReceived') {
    return { handled: false, reason: 'ignored_type' };
  }

  const msgData = (body && body.messageData) || {};
  const rawText = String(
    (msgData.textMessageData && msgData.textMessageData.textMessage) ||
    (msgData.extendedTextMessageData && msgData.extendedTextMessageData.text) ||
    ''
  ).trim();
  if (!rawText || rawText.length > 500) return { handled: false, reason: 'empty_text' };

  const cmd = rawText
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();

  const WA_STATIC_COMMANDS_ = new Set([
    'menu', '/menu', '!menu', 'ayuda', '?',
    'lista', '/lista', '!lista', 'compras', 'lista de compras',
    '/1', '/2', '/3', '1', '2', '3'
  ]);
  if (!WA_STATIC_COMMANDS_.has(cmd)) {
    return { handled: false, reason: 'not_a_command' };
  }

  const cfg = leerConfig_(true);
  const groupId = String((cfg && cfg.whatsappGroupId) || '').trim();
  const chatId = String((body && body.senderData && body.senderData.chatId) || '').trim();
  if (!groupId || chatId !== groupId) {
    return { handled: false, reason: 'ignored_chat' };
  }

  const idInst = String((body && body.instanceData && body.instanceData.idInstance) || '').trim();
  const idBrian = String((cfg && cfg.greenApiId_Brian) || '').trim();
  const idVirginia = String((cfg && cfg.greenApiId_Virginia) || '').trim();
  let instanciaUser = '';
  if (idInst && idVirginia && idInst === idVirginia) {
    instanciaUser = 'Virginia';
  } else if (idInst && idBrian && idInst === idBrian) {
    instanciaUser = 'Brian';
  } else {
    return { handled: false, reason: 'unauthorized_instance' };
  }

  const idMsg = String((body && body.idMessage) || '').trim();
  const dedupInput = (idMsg && idMsg.length <= 128)
    ? ('id:' + idMsg)
    : ('fb:' + chatId + '|' + tipo + '|' + String((body && body.timestamp) || '') + '|' + cmd);
  const cache = CacheService.getScriptCache();
  const dedupKey = 'wa_msg_' + hashSha256Hex_(dedupInput).slice(0, 40);
  const lock = LockService.getScriptLock();
  const gotLock = (typeof lock.tryLock === 'function') ? lock.tryLock(6000) : true;
  if (!gotLock) {
    return { handled: false, reason: 'lock_busy' };
  }
  try {
    if (cache.get(dedupKey)) return { handled: false, reason: 'duplicate' };
    cache.put(dedupKey, '1', 120);
  } finally {
    lock.releaseLock();
  }

  const menuKey = 'wa_menu_' + hashSha256Hex_(chatId).slice(0, 32);
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

  const actorUsuario = tipo === 'outgoingMessageReceived'
    ? instanciaUser
    : (instanciaUser === 'Virginia' ? 'Brian' : 'Virginia');
  const actorCreds = getGreenApiCreds_(cfg, actorUsuario);
  const usuarioEnvio = (actorCreds.idInstance && actorCreds.apiToken) ? actorUsuario : instanciaUser;

  const waResult = enviarWhatsAppGreenApi_(cfg, usuarioEnvio, respuesta);
  return { handled: true, command: cmd, usuario: usuarioEnvio, whatsapp: waResult };
}

function normalizarItemListaCompras_(it, serverCreatedAt) {
  if (!it || typeof it !== 'object' || Array.isArray(it)) return null;
  const texto = sanitizarDescripcion_(String(it.texto || ''), 120);
  const id = String(it.id || '').trim();
  if (!id || !esIdSeguro_(id) || !texto) return null;
  const rawAutor = String(it.autor || '').trim();
  const autor = ALLOWED_USERS_[rawAutor] || 'Brian';
  const creado = serverCreatedAt !== undefined
    ? String(serverCreatedAt)
    : String(it.creadoEn || new Date().toISOString()).slice(0, 40);
  return {
    id: id,
    texto: texto,
    done: !!it.done,
    autor: autor,
    creadoEn: creado
  };
}

function leerShoppingBatchIds_() {
  try {
    const raw = getScriptProp_('SHOPPING_BATCH_IDS');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(x => typeof x === 'string' && x) : [];
  } catch (e) {
    return [];
  }
}

function registrarShoppingBatchId_(batchId) {
  if (!batchId) return;
  try {
    const ids = leerShoppingBatchIds_().filter(id => id !== batchId);
    ids.push(batchId);
    const trimmed = ids.slice(-30);
    PropertiesService.getScriptProperties().setProperty('SHOPPING_BATCH_IDS', JSON.stringify(trimmed));
    invalidarScriptPropsCache_();
  } catch (e) {
    Logger.log('Error guardando SHOPPING_BATCH_IDS: ' + redactarSecretosTexto_(String(e)));
  }
}

function resumirNombresListaBatch_(items, maxShow) {
  const cap = maxShow || 25;
  const clean = items.slice(0, cap);
  if (items.length > cap) {
    return clean.join(', ') + ' … y ' + (items.length - cap) + ' más';
  }
  return clean.join(', ');
}

function formatearResumenBatchListaCompras_(resumen) {
  const agregados = resumen.added || [];
  const tachados = resumen.checked || [];
  const reabiertos = resumen.unchecked || [];
  const quitados = resumen.deleted || [];
  const totalNet = agregados.length + tachados.length + reabiertos.length + quitados.length;
  if (totalNet === 0) return '';

  if (totalNet === 1) {
    if (agregados.length === 1) return '🛒 Amorcito, agregué a la lista de compras:\n- ' + agregados[0];
    if (tachados.length === 1) return '✅ Amorcito, taché de la lista de compras:\n- ' + tachados[0];
    if (reabiertos.length === 1) return '🛒 Amorcito, volví a agregar a la lista de compras:\n- ' + reabiertos[0];
    if (quitados.length === 1) return '🛒 Amorcito, quité de la lista de compras:\n- ' + quitados[0];
  }

  const lineas = ['🛒 Amorcito, actualicé la lista de compras:'];
  if (agregados.length) lineas.push('➕ Agregué: ' + resumirNombresListaBatch_(agregados, 25));
  if (tachados.length) lineas.push('✅ Taché: ' + resumirNombresListaBatch_(tachados, 25));
  if (reabiertos.length) lineas.push('🔄 Volví a agregar: ' + resumirNombresListaBatch_(reabiertos, 25));
  if (quitados.length) lineas.push('🗑️ Quité: ' + resumirNombresListaBatch_(quitados, 25));

  const texto = lineas.join('\n');
  return texto.length > 3000 ? (texto.slice(0, 2990) + '…') : texto;
}

function aplicarOperacionesListaComprasBatch_(listaActual, ops, cfg) {
  const initialMap = Object.create(null);
  listaActual.forEach(it => {
    initialMap[it.id] = { texto: it.texto, done: !!it.done };
  });

  let lista = listaActual.slice();
  const touchedOrder = [];
  const touchedSet = Object.create(null);
  const wasCheckedBeforeClear = Object.create(null);
  const markTouched = id => {
    if (!touchedSet[id]) {
      touchedSet[id] = true;
      touchedOrder.push(id);
    }
  };

  ops.forEach(step => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      throw crearErrorApp_('VALIDATION_ERROR', 'Operación inválida dentro del lote');
    }
    const stepOp = String(step.op || '').trim();
    if (stepOp === 'add') {
      if (!step.item || typeof step.item !== 'object') {
        throw crearErrorApp_('VALIDATION_ERROR', 'Ítem inválido en lote');
      }
      const rawAddId = String(step.item.id || '').trim();
      if (!esIdSeguro_(rawAddId)) {
        throw crearErrorApp_('VALIDATION_ERROR', 'ID de ítem inválido');
      }
      const existing = lista.find(x => String(x.id) === rawAddId);
      const nuevo = normalizarItemListaCompras_(
        step.item,
        existing ? existing.creadoEn : new Date().toISOString()
      );
      if (!nuevo) {
        throw crearErrorApp_('VALIDATION_ERROR', 'Texto o ID de ítem inválido');
      }
      markTouched(nuevo.id);
      const idx = lista.findIndex(x => String(x.id) === nuevo.id);
      if (idx >= 0) {
        lista[idx] = nuevo;
      } else {
        lista.unshift(nuevo);
      }
    } else if (stepOp === 'toggle') {
      const targetId = String(step.id || '').trim();
      if (!esIdSeguro_(targetId)) {
        throw crearErrorApp_('VALIDATION_ERROR', 'ID de ítem inválido');
      }
      const idx = lista.findIndex(x => String(x.id) === targetId);
      if (idx >= 0) {
        markTouched(targetId);
        const estabaHecho = !!lista[idx].done;
        const nuevoHecho = step.done !== undefined ? !!step.done : !estabaHecho;
        lista[idx].done = nuevoHecho;
      }
    } else if (stepOp === 'delete') {
      const targetId = String(step.id || '').trim();
      if (!esIdSeguro_(targetId)) {
        throw crearErrorApp_('VALIDATION_ERROR', 'ID de ítem inválido');
      }
      const idx = lista.findIndex(x => String(x.id) === targetId);
      if (idx >= 0) {
        markTouched(targetId);
        lista.splice(idx, 1);
      }
    } else if (stepOp === 'clearDone') {
      lista.forEach(it => {
        if (it.done && initialMap[it.id] && !initialMap[it.id].done) {
          wasCheckedBeforeClear[it.id] = true;
          markTouched(it.id);
        }
      });
      lista = lista.filter(x => !x.done);
    } else {
      throw crearErrorApp_('VALIDATION_ERROR', 'Sub-operación de lote no permitida');
    }
  });

  const finalMap = Object.create(null);
  lista.forEach(it => {
    finalMap[it.id] = { texto: it.texto, done: !!it.done };
  });

  const resumen = { added: [], checked: [], unchecked: [], deleted: [] };
  touchedOrder.forEach(id => {
    const init = initialMap[id] || null;
    const fin = finalMap[id] || null;
    if (!init) {
      if (fin && !fin.done) resumen.added.push(fin.texto);
    } else if (!init.done) {
      if (fin) {
        if (fin.done) resumen.checked.push(fin.texto);
      } else if (wasCheckedBeforeClear[id]) {
        resumen.checked.push(init.texto);
      } else {
        resumen.deleted.push(init.texto);
      }
    } else {
      if (fin && !fin.done) resumen.unchecked.push(fin.texto);
    }
  });

  return { lista: lista, resumen: resumen, cfg: cfg };
}

function guardarListaCompras_(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw crearErrorApp_('VALIDATION_ERROR', 'Datos de lista de compras inválidos');
  }
  const op = String(payload.op || '').trim();
  if (op !== 'batch' && op !== 'add' && op !== 'toggle' && op !== 'delete' && op !== 'clearDone') {
    throw crearErrorApp_('VALIDATION_ERROR', 'Operación de lista de compras no permitida');
  }

  let lista = [];
  let waMensaje = '';
  let waUsuario = 'Brian';
  let cfgSnapshot = null;

  if (op === 'batch') {
    const batchId = String(payload.batchId || '').trim();
    if (!esIdSeguro_(batchId)) {
      throw crearErrorApp_('VALIDATION_ERROR', 'batchId inválido');
    }
    if (!Array.isArray(payload.ops) || !payload.ops.length || payload.ops.length > 50) {
      throw crearErrorApp_('VALIDATION_ERROR', 'El lote debe tener entre 1 y 50 operaciones');
    }

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      invalidarCacheSheet_('Config');
      const cfg = leerConfig_(true);
      cfgSnapshot = cfg;
      const parsed = parseJsonConfig_(cfg.listaCompras);
      lista = Array.isArray(parsed)
        ? parsed.slice(0, 150).map(it => normalizarItemListaCompras_(it)).filter(Boolean)
        : [];

      if (leerShoppingBatchIds_().indexOf(batchId) !== -1) {
        return { ok: true, deduplicated: true, listaCompras: lista, whatsapp: null };
      }

      waUsuario = normalizarUsuarioPermitido_(payload.usuario, cfg.usuarioDefault || 'Brian');
      const aplicado = aplicarOperacionesListaComprasBatch_(lista, payload.ops, cfg);
      lista = aplicado.lista;
      if (lista.length > 150) lista = lista.slice(0, 150);
      escribirConfigSinLock_({ listaCompras: JSON.stringify(lista) });
      registrarShoppingBatchId_(batchId);
      waMensaje = formatearResumenBatchListaCompras_(aplicado.resumen);
    } finally {
      lock.releaseLock();
    }

    let waResult = null;
    if (waMensaje && cfgSnapshot) {
      waResult = enviarWhatsAppGreenApi_(cfgSnapshot, waUsuario, waMensaje);
    }
    return { ok: true, listaCompras: lista, whatsapp: waResult };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    invalidarCacheSheet_('Config');
    const cfg = leerConfig_(true);
    cfgSnapshot = cfg;
    const parsed = parseJsonConfig_(cfg.listaCompras);
    lista = Array.isArray(parsed)
      ? parsed.slice(0, 150).map(it => normalizarItemListaCompras_(it)).filter(Boolean)
      : [];

    const fallbackAutor = (payload.item && payload.item.autor && ALLOWED_USERS_[String(payload.item.autor).trim()]) || cfg.usuarioDefault || 'Brian';
    waUsuario = normalizarUsuarioPermitido_(payload.usuario, fallbackAutor);

    if (op === 'add') {
      if (!payload.item || typeof payload.item !== 'object') {
        throw crearErrorApp_('VALIDATION_ERROR', 'Ítem inválido');
      }
      const rawAddId = String(payload.item.id || '').trim();
      if (!esIdSeguro_(rawAddId)) {
        throw crearErrorApp_('VALIDATION_ERROR', 'ID de ítem inválido');
      }
      const existing = lista.find(x => String(x.id) === rawAddId);
      const nuevo = normalizarItemListaCompras_(
        payload.item,
        existing ? existing.creadoEn : new Date().toISOString()
      );
      if (!nuevo) {
        throw crearErrorApp_('VALIDATION_ERROR', 'Texto o ID de ítem inválido');
      }
      const idx = lista.findIndex(x => String(x.id) === nuevo.id);
      if (idx >= 0) {
        lista[idx] = nuevo;
      } else {
        lista.unshift(nuevo);
        if (!nuevo.done) {
          waMensaje = '🛒 Amorcito, agregué a la lista de compras:\n- ' + nuevo.texto;
        }
      }
    } else if (op === 'toggle') {
      const targetId = String(payload.id || '').trim();
      if (!esIdSeguro_(targetId)) {
        throw crearErrorApp_('VALIDATION_ERROR', 'ID de ítem inválido');
      }
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
      }
    } else if (op === 'delete') {
      const targetId = String(payload.id || '').trim();
      if (!esIdSeguro_(targetId)) {
        throw crearErrorApp_('VALIDATION_ERROR', 'ID de ítem inválido');
      }
      const idx = lista.findIndex(x => String(x.id) === targetId);
      if (idx >= 0) {
        if (!lista[idx].done) {
          waMensaje = '🛒 Amorcito, quité de la lista de compras:\n- ' + lista[idx].texto;
        }
        lista.splice(idx, 1);
      }
    } else if (op === 'clearDone') {
      lista = lista.filter(x => !x.done);
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
// 7. SETUP INICIAL Y GESTIÓN DE SECRETOS (SOLO EDITOR APPS SCRIPT)
// ============================================================

function notificarSecretoEditor_(titulo, mensajeConSecreto, resumenSinSecreto) {
  try {
    const ui = SpreadsheetApp.getUi();
    ui.alert(titulo, mensajeConSecreto, ui.ButtonSet.OK);
    Logger.log(resumenSinSecreto);
    return;
  } catch (e) {}
  Logger.log(resumenSinSecreto);
  Logger.log(mensajeConSecreto);
}

function generarClaveAcceso() {
  const key = generarTokenSeguro_(32);
  PropertiesService.getScriptProperties().setProperty('APP_ACCESS_KEY', key);
  invalidarScriptPropsCache_();
  notificarSecretoEditor_(
    'Nueva APP_ACCESS_KEY generada',
    'Copiá esta clave única para cargarla 1 vez en tu teléfono y en el de Virginia:\n\n' + key,
    'APP_ACCESS_KEY generada y guardada en Propiedades del Script.'
  );
  return key;
}

function generarSecretoWebhook() {
  const secret = generarTokenSeguro_(32);
  PropertiesService.getScriptProperties().setProperty('WEBHOOK_SECRET', secret);
  invalidarScriptPropsCache_();
  notificarSecretoEditor_(
    'Nuevo WEBHOOK_SECRET generado',
    'Agregá ?wh=' + secret + ' al final de la URL de webhook en Green API (Brian y Virginia).',
    'WEBHOOK_SECRET guardado en Propiedades del Script.'
  );
  return secret;
}

function configurarTokenGreenApi(usuario, nuevoToken) {
  if (usuario !== 'Brian' && usuario !== 'Virginia') {
    throw new Error("El usuario debe ser exactamente 'Brian' o 'Virginia'");
  }
  const user = usuario;
  const token = String(nuevoToken || '').trim();
  if (!token) throw new Error('El token no puede estar vacío');
  PropertiesService.getScriptProperties().setProperty('greenApiToken_' + user, token);
  invalidarScriptPropsCache_();
  eliminarClavesConfigSheet_(['greenApiToken_' + user]);
  Logger.log('Token de Green API guardado en ScriptProperties para ' + user + '.');
  return true;
}

function leerTokensConfigCrudos_() {
  const tokens = { greenApiToken_Brian: '', greenApiToken_Virginia: '' };
  const presentes = { greenApiToken_Brian: false, greenApiToken_Virginia: false };
  const sheet = getSheet_('Config', false);
  if (!sheet) return { tokens: tokens, presentes: presentes };
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    const k = String(values[i][0] || '').trim();
    if (Object.prototype.hasOwnProperty.call(tokens, k)) {
      presentes[k] = true;
      const v = String(values[i][1] || '').trim();
      if (v) tokens[k] = v;
    }
  }
  return { tokens: tokens, presentes: presentes };
}

function migrarSecretosAPropertiesSinLock_() {
  invalidarCacheSheet_('Config');
  const rawSheet = leerTokensConfigCrudos_();
  const props = PropertiesService.getScriptProperties();
  const migrados = [];
  const conflictos = [];
  const clavesBorrar = [];

  ['Brian', 'Virginia'].forEach(user => {
    const k = 'greenApiToken_' + user;
    const sheetVal = rawSheet.tokens[k];
    const existingProp = String(props.getProperty(k) || '').trim();

    if (sheetVal && !existingProp) {
      props.setProperty(k, sheetVal);
      invalidarScriptPropsCache_();
      migrados.push(user);
    } else if (sheetVal && existingProp && existingProp !== sheetVal) {
      conflictos.push(user);
      Logger.log('Aviso: ' + k + ' ya existe en ScriptProperties con un valor distinto al de Config; se conserva ScriptProperties.');
    }

    if (rawSheet.presentes[k]) {
      const confirmedProp = existingProp || String(props.getProperty(k) || '').trim();
      if (!sheetVal || confirmedProp) {
        clavesBorrar.push(k);
      }
    }
  });

  if (clavesBorrar.length) {
    eliminarClavesConfigSheetSinLock_(clavesBorrar);
  }
  Logger.log(
    'Migración a ScriptProperties completada. Tokens migrados: ' +
    (migrados.length ? migrados.join(', ') : 'ninguno (ya estaban vacíos/migrados)') +
    (conflictos.length ? ' | Conflictos conservando ScriptProperties: ' + conflictos.join(', ') : '')
  );
  return { migrados: migrados, conflictos: conflictos };
}

function migrarSecretosAProperties() {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    return migrarSecretosAPropertiesSinLock_();
  } finally {
    lock.releaseLock();
  }
}

function eliminarClavesConfigSheet_(keys) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    eliminarClavesConfigSheetSinLock_(keys);
  } finally {
    lock.releaseLock();
  }
}

function eliminarClavesConfigSheetSinLock_(keys) {
  const sheet = getSheet_('Config', false);
  if (!sheet || !Array.isArray(keys) || !keys.length) return;
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return;
  for (let i = values.length - 1; i >= 1; i--) {
    const key = String(values[i][0] || '').trim();
    if (keys.indexOf(key) !== -1) {
      if (sheet.getMaxRows() <= 2) {
        sheet.getRange(i + 1, 1, 1, 2).clearContent();
      } else {
        sheet.deleteRow(i + 1);
      }
    }
  }
  invalidarCacheSheet_('Config');
}

function setupSheets() {
  Object.keys(SHEET_SCHEMAS).forEach(nombre => {
    asegurarCabeceras_(nombre);
    const sheet = getSheet_(nombre, true);
    const filasFmt = Math.min(Math.max(sheet.getMaxRows() - 1, 1), 998);
    aplicarFormatoTextoColumnas_(sheet, nombre, 2, filasFmt);
  });

  const cfg = leerConfig_(true);
  setConfigValores_({
    homeBankingTotal: cfg.homeBankingTotal || '0',
    bolsaTotal: cfg.bolsaTotal || '0',
    lastProcessedDate: cfg.lastProcessedDate || formatearFechaISO_(new Date()),
    whatsappGroupId: cfg.whatsappGroupId || '',
    greenApiUrl_Brian: cfg.greenApiUrl_Brian || 'https://api.green-api.com',
    greenApiId_Brian: cfg.greenApiId_Brian || '',
    greenApiUrl_Virginia: cfg.greenApiUrl_Virginia || 'https://api.green-api.com',
    greenApiId_Virginia: cfg.greenApiId_Virginia || ''
  });

  migrarSecretosAProperties();
  limpiarConfigLegacy_();

  Logger.log('Setup y reparación completa. Pestañas y formatos asegurados: ' + Object.keys(SHEET_SCHEMAS).join(', '));
}

function verificarEstadoSeguridad() {
  invalidarScriptPropsCache_();
  invalidarCacheSheet_('Config');
  const propsObj = PropertiesService.getScriptProperties().getProperties() || {};
  const cfg = leerConfig_(true);
  const rawSheet = leerTokensConfigCrudos_();

  const appKey = String(propsObj.APP_ACCESS_KEY || '').trim();
  const whSecret = String(propsObj.WEBHOOK_SECRET || '').trim();
  const groupId = String(cfg.whatsappGroupId || '').trim();

  const whitelistSet = new Set(['https://api.green-api.com/']);
  const inspeccionarGreenApi = user => {
    const tokenKey = 'greenApiToken_' + user;
    const rawUrl = String(cfg['greenApiUrl_' + user] || '').trim().replace(/\/+$/, '');
    const effectiveUrl = rawUrl || 'https://api.green-api.com';
    const urlValid = GREEN_API_URL_REGEX_.test(effectiveUrl);
    if (urlValid) whitelistSet.add(effectiveUrl + '/');
    const rawId = String(cfg['greenApiId_' + user] || '').trim();
    const propToken = String(propsObj[tokenKey] || '').trim();
    const sheetToken = rawSheet.tokens[tokenKey];
    return {
      idConfigured: /^\d{4,20}$/.test(rawId),
      urlOrigin: effectiveUrl,
      urlValid: urlValid,
      tokenInScriptProperties: propToken.length > 0,
      tokenStillInConfigSheet: sheetToken.length > 0
    };
  };

  const brianStatus = inspeccionarGreenApi('Brian');
  const virginiaStatus = inspeccionarGreenApi('Virginia');
  const chatType = /@g\.us$/.test(groupId)
    ? 'group'
    : (/@c\.us$/.test(groupId) ? 'direct' : 'invalid_or_empty');

  const hasAnyTokenInProps = brianStatus.tokenInScriptProperties || virginiaStatus.tokenInScriptProperties;
  const anyPlaintextTokenInSheet = brianStatus.tokenStillInConfigSheet || virginiaStatus.tokenStillInConfigSheet;

  const reporte = {
    appAccessKey: { configured: appKey.length >= 16, length: appKey.length },
    webhookSecret: { configured: whSecret.length >= 16, length: whSecret.length },
    greenApiBrian: brianStatus,
    greenApiVirginia: virginiaStatus,
    whatsappGroup: {
      validFormat: /^[0-9-]+@(g\.us|c\.us)$/.test(groupId),
      chatType: chatType
    },
    anyPlaintextTokenInSheet: anyPlaintextTokenInSheet,
    suggestedUrlFetchWhitelist: Array.from(whitelistSet),
    readyForStage1BFailClosed: (
      appKey.length >= 16 &&
      whSecret.length >= 16 &&
      hasAnyTokenInProps &&
      !anyPlaintextTokenInSheet
    )
  };

  Logger.log(JSON.stringify(reporte, null, 2));
  return reporte;
}

function limpiarConfigLegacy_() {
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
  eliminarClavesConfigSheet_(legacyKeys);
}
