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
    const body = JSON.parse(e.postData.contents);
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
    case 'eliminarMovimiento': return eliminarMovimiento_(payload.id);
    case 'actualizarHB': return actualizarHB_(payload);
    case 'limpiarMovimientosPendientes': return limpiarMovimientosPendientes_();
    case 'resolverCierreDia': return resolverCierreDia_(payload);
    case 'actualizarConfig': return actualizarConfig_(payload);
    case 'enviarMensaje': return enviarMensaje_(payload);
    case 'registrarPushSub': return registrarPushSub_(payload);
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
      sheet.deleteRow(i + 1);
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
  const diasInfo = calcularDiasRestantes_(new Date(), feriadosExtra);
  const movimientos = leerFilas_('Movimientos').map(limpiarFilaParaCliente_);

  const listaRaw = parseJsonConfig_(cfg.listaCompras);

  return {
    homeBankingTotal: getConfigNumero_(cfg, 'homeBankingTotal', 0),
    bolsaTotal: getConfigNumero_(cfg, 'bolsaTotal', 0),
    lastProcessedDate: cfg.lastProcessedDate || null,
    diaCobro: diasInfo.diaCobro,
    diasRestantes: diasInfo.fechas,
    movimientos: movimientos,
    listaCompras: Array.isArray(listaRaw) ? listaRaw : [],
    ultimaNotificacion: parseJsonConfig_(cfg.ultimaNotificacion),
    ultimoMensaje: parseJsonConfig_(cfg.ultimoMensaje),
    onesignalAppId: String(cfg.onesignalAppId || '').trim(),
    pushConfigured: !!(String(cfg.onesignalAppId || '').trim() && String(cfg.onesignalApiKey || '').trim())
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

  const cfg = leerConfig_();
  let hbTotal = getConfigNumero_(cfg, 'homeBankingTotal', 0);
  let bolsaTotal = getConfigNumero_(cfg, 'bolsaTotal', 0);

  const usuario = (data.usuario && String(data.usuario).trim()) ? String(data.usuario).trim() : (cfg.usuarioDefault || 'Brian');

  const id = data.id || Utilities.getUuid();
  const filasMov = leerFilas_('Movimientos');
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

  setConfigValores_({
    homeBankingTotal: hbTotal,
    bolsaTotal: bolsaTotal
  });

  const obj = {
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

  if (!movExistente && !actualizado) {
    const paraUsuario = usuario === 'Virginia' ? 'Brian' : 'Virginia';
    const descLimpia = obj.descripcion || 'Gasto registrado';
    const montoTxt = formatearMonedaGS_(nuevoMonto);
    const restoTxt = (data.disponibleHoyTexto && String(data.disponibleHoyTexto).trim())
      ? (' · Queda para hoy: ' + String(data.disponibleHoyTexto).trim())
      : '';
    const notif = {
      id: 'ntf_' + Utilities.getUuid(),
      tipo: 'gasto',
      de: usuario,
      para: paraUsuario,
      titulo: 'Tu amorcito registró un gasto en la aplicación',
      cuerpo: descLimpia + ': ' + montoTxt + restoTxt,
      creadoEn: new Date().toISOString()
    };
    setConfigValores_({ ultimaNotificacion: JSON.stringify(notif) });
    enviarWebPushOneSignal_(cfg, paraUsuario, notif.titulo, notif.cuerpo, notif);
  }

  return obj;
}

function eliminarMovimiento_(id) {
  const filasMov = leerFilas_('Movimientos');
  const movExistente = filasMov.find(m => String(m.id).trim() === String(id).trim());

  if (movExistente) {
    const cfg = leerConfig_();
    let hbTotal = getConfigNumero_(cfg, 'homeBankingTotal', 0);
    let bolsaTotal = getConfigNumero_(cfg, 'bolsaTotal', 0);

    hbTotal += (movExistente.monto || 0);
    if (movExistente.fromBag) {
      bolsaTotal += (movExistente.monto || 0);
    }

    setConfigValores_({
      homeBankingTotal: hbTotal,
      bolsaTotal: bolsaTotal
    });

    return borrarFilaPorId_('Movimientos', id);
  }
  return false;
}

function actualizarHB_(payload) {
  const cambios = {};
  if (payload.homeBankingTotal !== undefined && payload.homeBankingTotal !== null && payload.homeBankingTotal !== '') {
    const hb = Number(payload.homeBankingTotal);
    if (isNaN(hb)) throw new Error('homeBankingTotal inválido');
    cambios.homeBankingTotal = hb;
  }
  if (payload.bolsaTotal !== undefined && payload.bolsaTotal !== null && payload.bolsaTotal !== '') {
    const bolsa = Number(payload.bolsaTotal);
    if (isNaN(bolsa) || bolsa < 0) throw new Error('bolsaTotal inválido');
    cambios.bolsaTotal = bolsa;
  }
  if (Object.keys(cambios).length > 0) {
    setConfigValores_(cambios);
  }
  const cfg = leerConfig_();
  return {
    homeBankingTotal: getConfigNumero_(cfg, 'homeBankingTotal', 0),
    bolsaTotal: getConfigNumero_(cfg, 'bolsaTotal', 0)
  };
}

function limpiarMovimientosPendientes_() {
  const hoyStr = formatearFechaISO_(new Date());
  const movimientos = leerFilas_('Movimientos');
  const aBorrar = [];
  const candidatos = [];

  const cfg = leerConfig_();
  let hbTotal = getConfigNumero_(cfg, 'homeBankingTotal', 0);
  let bolsaTotal = getConfigNumero_(cfg, 'bolsaTotal', 0);
  let cambioHB = false;

  movimientos.forEach(m => {
    const fechas = castValor_('Movimientos', 'fechasAfectadas', m.fechasAfectadas);
    const afectaHoy = fechas.indexOf(hoyStr) !== -1;
    const tienePendiente = fechas.some(f => f >= hoyStr);

    if (!tienePendiente) {
      aBorrar.push(m.id);
      return;
    }
    if (m.tipo === 'single' && afectaHoy) return;
    if (m.tipo === 'divisible' && afectaHoy) {
      candidatos.push(limpiarFilaParaCliente_(m));
      return;
    }
    
    hbTotal += (m.monto || 0);
    if (m.fromBag) bolsaTotal += (m.monto || 0);
    cambioHB = true;
    aBorrar.push(m.id);
  });

  if (cambioHB) {
    setConfigValores_({ homeBankingTotal: hbTotal, bolsaTotal: bolsaTotal });
  }

  aBorrar.forEach(id => borrarFilaPorId_('Movimientos', id));
  return { borrados: aBorrar.length, candidatos: candidatos };
}

function resolverCierreDia_(payload) {
  const cfg = leerConfig_();
  let bolsaActual = getConfigNumero_(cfg, 'bolsaTotal', 0);

  if (payload.decision === 'bolsa') {
    if (payload.tipo === 'sobrante') {
      bolsaActual += payload.monto;
    } else {
      bolsaActual = Math.max(bolsaActual - payload.monto, 0);
    }
    setConfigValores_({ bolsaTotal: bolsaActual });
  }

  const hoyStr = formatearFechaISO_(new Date());
  setConfigValores_({ lastProcessedDate: hoyStr });
  return { bolsaTotal: bolsaActual, lastProcessedDate: hoyStr };
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

function formatearMonedaGS_(n) {
  const num = Math.round(Number(n) || 0);
  const sign = num < 0 ? '-$ ' : '$ ';
  const absStr = Math.abs(num).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return sign + absStr;
}

function enviarMensaje_(payload) {
  const texto = String((payload && payload.texto) || '').trim();
  if (!texto) throw new Error('Escribí un mensaje antes de enviar');

  const cfg = leerConfig_();
  const deUsuario = (payload.de && String(payload.de).trim()) || (cfg.usuarioDefault || 'Brian');
  const paraUsuario = (payload.para && String(payload.para).trim()) || (deUsuario === 'Virginia' ? 'Brian' : 'Virginia');

  const notif = {
    id: 'msg_' + Utilities.getUuid(),
    tipo: 'mensaje',
    de: deUsuario,
    para: paraUsuario,
    titulo: '💌 Mensaje de ' + deUsuario,
    cuerpo: texto.slice(0, 240),
    creadoEn: new Date().toISOString()
  };

  const jsonNotif = JSON.stringify(notif);
  setConfigValores_({
    ultimaNotificacion: jsonNotif,
    ultimoMensaje: jsonNotif
  });

  const pushResult = enviarWebPushOneSignal_(cfg, paraUsuario, notif.titulo, notif.cuerpo, notif);
  return { notif: notif, push: pushResult };
}

function registrarPushSub_(payload) {
  const usuario = String((payload && payload.usuario) || '').trim();
  const subscriptionId = String((payload && payload.subscriptionId) || '').trim();
  if (usuario !== 'Brian' && usuario !== 'Virginia') throw new Error('Usuario inválido');
  const key = 'pushSub_' + usuario;
  setConfigValores_({ [key]: subscriptionId });
  return { ok: true, key: key, subscriptionId: subscriptionId };
}

function enviarWebPushOneSignal_(cfg, paraUsuario, titulo, cuerpo, dataExtra) {
  const appId = String((cfg && cfg.onesignalAppId) || '').trim();
  const apiKey = String((cfg && cfg.onesignalApiKey) || '').trim();
  if (!appId || !apiKey) {
    return { sent: false, reason: 'missing_onesignal_config' };
  }

  try {
    const subId = String(cfg['pushSub_' + paraUsuario] || '').trim();
    const body = {
      app_id: appId,
      headings: { en: titulo, es: titulo },
      contents: { en: cuerpo, es: cuerpo },
      data: dataExtra || {}
    };
    if (subId) {
      body.include_subscription_ids = [subId];
    } else {
      body.include_aliases = { external_id: [paraUsuario] };
      body.target_channel = 'push';
    }

    const res = UrlFetchApp.fetch('https://api.onesignal.com/notifications', {
      method: 'post',
      contentType: 'application/json',
      headers: {
        Authorization: 'Key ' + apiKey
      },
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    });
    return { sent: true, status: res.getResponseCode(), response: res.getContentText() };
  } catch (e) {
    return { sent: false, error: String(e) };
  }
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
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    invalidarCacheSheet_('Config');
    const cfg = leerConfig_(true);
    const parsed = parseJsonConfig_(cfg.listaCompras);
    let lista = Array.isArray(parsed)
      ? parsed.map(normalizarItemListaCompras_).filter(Boolean)
      : [];

    const op = String((payload && payload.op) || '').trim();
    if (op === 'add' && payload.item) {
      const nuevo = normalizarItemListaCompras_(payload.item);
      if (nuevo) {
        const idx = lista.findIndex(x => String(x.id) === nuevo.id);
        if (idx >= 0) lista[idx] = nuevo;
        else lista.unshift(nuevo);
      }
    } else if (op === 'toggle' && payload.id) {
      const targetId = String(payload.id).trim();
      const idx = lista.findIndex(x => String(x.id) === targetId);
      if (idx >= 0) {
        lista[idx].done = payload.done !== undefined ? !!payload.done : !lista[idx].done;
      } else if (Array.isArray(payload.items)) {
        lista = payload.items.map(normalizarItemListaCompras_).filter(Boolean);
      }
    } else if (op === 'delete' && payload.id) {
      const targetId = String(payload.id).trim();
      lista = lista.filter(x => String(x.id) !== targetId);
    } else if (op === 'clearDone') {
      lista = lista.filter(x => !x.done);
    } else if (Array.isArray(payload && payload.items)) {
      lista = payload.items.map(normalizarItemListaCompras_).filter(Boolean);
    }

    if (lista.length > 150) lista = lista.slice(0, 150);
    escribirConfigSinLock_({ listaCompras: JSON.stringify(lista) });
    return { ok: true, listaCompras: lista };
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
// 7. SETUP INICIAL
// ============================================================

function setupSheets() {
  Object.keys(SHEET_SCHEMAS).forEach(nombre => {
    asegurarCabeceras_(nombre);
  });

  const cfg = leerConfig_();
  setConfigValores_({
    homeBankingTotal: cfg.homeBankingTotal || '0',
    bolsaTotal: cfg.bolsaTotal || '0',
    lastProcessedDate: cfg.lastProcessedDate || formatearFechaISO_(new Date()),
    onesignalAppId: cfg.onesignalAppId || '',
    onesignalApiKey: cfg.onesignalApiKey || ''
  });

  limpiarConfigLegacy_();

  Logger.log('Setup completo. Pestañas creadas y aseguradas: ' + Object.keys(SHEET_SCHEMAS).join(', '));
}

function repararSheetsExistentes() {
  Object.keys(SHEET_SCHEMAS).forEach(nombre => {
    asegurarCabeceras_(nombre);
    const schema = SHEET_SCHEMAS[nombre];
    const sheet = getSheet_(nombre, true);
    schema.columns.forEach((col, idx) => {
      const tipo = schema.types[col];
      if (tipo === 'string' || tipo === 'json') {
        sheet.getRange(2, idx + 1, 998, 1).setNumberFormat('@');
      }
    });
  });
  setConfigValores_({ lastProcessedDate: formatearFechaISO_(new Date()) });
  limpiarConfigLegacy_();
  Logger.log('Formatos de texto aplicados, cabeceras aseguradas y configuración legacy depurada.');
}

function limpiarConfigLegacy_() {
  const sheet = getSheet_('Config', false);
  if (!sheet) return;
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return;
  const legacyKeys = ['accentColorBrian', 'accentColorVirginia'];
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
