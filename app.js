/**
 * ============================================================
 * MINIMAL FINANCE — FRONTEND MOTOR DIARIO (app.js)
 * ============================================================
 */

// ============================================================
// CONFIGURACIÓN DE CONEXIÓN AL BACKEND
// ============================================================
const BACKEND_URL = 'https://script.google.com/macros/s/AKfycbwHJx8AhDKR5k1eZSQ74hleTxUSy_0I_u83aOOvxIOK1IqtF_e87joQdpmDw70wSF7w/exec';

// ============================================================
// ESTADO GLOBAL Y SINCRONIZACIÓN EN SEGUNDO PLANO
// ============================================================

const appState = {
  activeUser: 'Brian',
  homeBankingTotal: 0,
  bolsaTotal: 0,
  diaCobro: null,
  diasRestantes: [],
  movimientos: [],
  lastProcessedDate: null,
  ultimaNotificacion: null,
  ultimoMensaje: null,
  onesignalAppId: ''
};

const PRESET_COUPLE_MESSAGES = [
  'Te amo mucho ❤️',
  'Ya actualicé la aplicación, te amo mucho ❤️'
];

let onesignalInitializedAppId_ = null;
let notifBannerTimer_ = null;
let notifPollTimer_ = null;

let txModalSubtype = 'single';
let editingMovimientoId = null;
let cierreDiaPendiente = null;
let limpiarColaCandidatos = [];

let pendingSyncCount = 0;

// ============================================================
// CLIENTE DE API (Apps Script) & BACKGROUND SYNC
// ============================================================

async function fetchWithRetry(url, options, maxRetries = 3, timeoutMs = 35000) {
  let attempt = 0;
  while (attempt < maxRetries) {
    attempt++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const opts = Object.assign({}, options, { signal: controller.signal });
      const res = await fetch(url, opts);
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP Error ' + res.status);
      return res;
    } catch (err) {
      clearTimeout(timer);
      if (attempt >= maxRetries) throw err;
      const delay = Math.pow(2, attempt - 1) * 600;
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

async function callBackend(action, payload) {
  const res = await fetchWithRetry(BACKEND_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: action, payload: payload || {} })
  }, 3, 35000);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || ('Error en ' + action));
  return json.data;
}

async function callBackendConSync(action, payload) {
  mostrarSyncToast_();
  try {
    return await callBackend(action, payload);
  } finally {
    ocultarSyncToast_();
  }
}

const PENDING_SYNC_QUEUE_KEY = 'pending_sync_queue';
let isProcessingSyncQueue_ = false;

function getPendingSyncQueue_() {
  try {
    const raw = localStorage.getItem(PENDING_SYNC_QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error('Error leyendo pending_sync_queue:', e);
    return [];
  }
}

function savePendingSyncQueue_(queue) {
  try {
    if (!queue || !queue.length) {
      localStorage.removeItem(PENDING_SYNC_QUEUE_KEY);
    } else {
      localStorage.setItem(PENDING_SYNC_QUEUE_KEY, JSON.stringify(queue));
    }
  } catch (e) {
    console.error('Error guardando pending_sync_queue:', e);
  }
}

function enqueuePendingSync_(action, payload) {
  const queue = getPendingSyncQueue_();
  queue.push({
    id: 'sync_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
    action: action,
    payload: payload,
    timestamp: Date.now()
  });
  savePendingSyncQueue_(queue);
}

function isNetworkOrTimeoutError_(err) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  if (!err) return true;
  if (err.name === 'AbortError') return true;
  const msg = String(err.message || err).toLowerCase();
  return msg.includes('network') ||
         msg.includes('fetch') ||
         msg.includes('failed to fetch') ||
         msg.includes('timeout') ||
         msg.includes('abort') ||
         msg.includes('offline') ||
         msg.includes('conexión') ||
         msg.includes('internet') ||
         msg.includes('load failed') ||
         msg.includes('http error 502') ||
         msg.includes('http error 503') ||
         msg.includes('http error 504');
}

async function processPendingSyncQueue_() {
  if (isProcessingSyncQueue_) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

  if (!getPendingSyncQueue_().length) return;

  isProcessingSyncQueue_ = true;
  mostrarSyncToast_();
  try {
    while (true) {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) break;
      const queue = getPendingSyncQueue_();
      if (!queue.length) break;
      const item = queue[0];
      try {
        await callBackend(item.action, item.payload);
        savePendingSyncQueue_(getPendingSyncQueue_().filter(x => x.id !== item.id));
      } catch (err) {
        console.error('Error procesando ítem de cola pendiente:', item, err);
        if (isNetworkOrTimeoutError_(err)) {
          // Conexión inestable: preservar cola y esperar al próximo reintento/online
          break;
        } else {
          // Error fatal en datos de la petición: descartar para evitar bloqueo permanente
          savePendingSyncQueue_(getPendingSyncQueue_().filter(x => x.id !== item.id));
        }
      }
    }
    if (getPendingSyncQueue_().length === 0) {
      showAppToast('Sincronización pendiente completada');
    }
  } finally {
    isProcessingSyncQueue_ = false;
    ocultarSyncToast_();
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    console.log('Conexión reestablecida. Procesando cola de sincronización pendiente...');
    processPendingSyncQueue_();
  });
}

async function callBackendBackground(action, payload) {
  const queue = getPendingSyncQueue_();
  // Si ya hay operaciones pendientes, en curso o sin conexión, encolar para garantizar orden FIFO
  if ((typeof navigator !== 'undefined' && navigator.onLine === false) || queue.length > 0 || pendingSyncCount > 0 || isProcessingSyncQueue_) {
    enqueuePendingSync_(action, payload);
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      showAppToast('Sin conexión: acción guardada para sincronizar al volver en línea');
    } else if (pendingSyncCount === 0 && !isProcessingSyncQueue_) {
      processPendingSyncQueue_();
    }
    return null;
  }

  pendingSyncCount++;
  mostrarSyncToast_();
  try {
    const res = await callBackend(action, payload);
    return res;
  } catch (err) {
    console.error('Error en sync background (' + action + '):', err);
    if (isNetworkOrTimeoutError_(err)) {
      enqueuePendingSync_(action, payload);
      showAppToast('Fallo de red: acción guardada en cola para reintentar', true);
      return null;
    }
    showAppToast('Error de sincronización: ' + (err.message || 'Fallo de red'), true);
    throw err;
  } finally {
    pendingSyncCount--;
    if (pendingSyncCount <= 0) {
      pendingSyncCount = 0;
      ocultarSyncToast_();
      if (getPendingSyncQueue_().length > 0 && !isProcessingSyncQueue_) {
        processPendingSyncQueue_();
      }
    }
  }
}

function showAppToast(message, isError = false) {
  const toast = document.getElementById('exit-toast');
  if (!toast) return;
  toast.textContent = message;
  toast.style.backgroundColor = isError ? 'rgba(185, 28, 28, 0.95)' : 'rgba(39, 39, 42, 0.95)';
  toast.classList.add('active');
  clearTimeout(toast._appTimer);
  toast._appTimer = setTimeout(() => {
    toast.classList.remove('active');
    setTimeout(() => {
      if (toast) toast.style.backgroundColor = '';
    }, 300);
  }, 3500);
}

function mostrarSyncToast_() {
  const el = document.getElementById('sync-toast');
  if (el) el.classList.add('active');
}

function ocultarSyncToast_() {
  if (pendingSyncCount > 0) return;
  const el = document.getElementById('sync-toast');
  if (el) el.classList.remove('active');
}

// ============================================================
// FORMATEADOR DE MONEDA Y MANEJO DE INPUTS
// ============================================================

const moneyStates = {};

function formatMoneyParts(rawInt, rawDec, isDec) {
  const cleanInt = (rawInt || '').replace(/\D/g, '');
  const cleanDec = (rawDec || '').replace(/\D/g, '').slice(0, 2);

  if (!cleanInt && !isDec) {
    return '';
  }

  const displayInt = cleanInt.replace(/^0+(?=\d)/, '') || '0';
  const formattedInt = displayInt.replace(/\B(?=(\d{3})+(?!\d))/g, '.');

  if (isDec) {
    return formattedInt + ',' + cleanDec;
  }
  return formattedInt;
}

function parseMoneyString(str) {
  let isDec = false;
  let intStr = '';
  let decStr = '';

  const commaIndex = str.indexOf(',');
  if (commaIndex !== -1) {
    isDec = true;
    intStr = str.slice(0, commaIndex).replace(/\D/g, '');
    decStr = str.slice(commaIndex + 1).replace(/\D/g, '').slice(0, 2);
  } else {
    intStr = str.replace(/\D/g, '');
  }

  intStr = intStr.replace(/^0+(?=\d)/, '');
  return { int: intStr, dec: decStr, isDec };
}

function countRawBeforeCursor(formattedStr, pos) {
  let intCount = 0;
  let decCount = 0;
  let passedComma = false;
  const limit = Math.min(pos, formattedStr.length);
  for (let i = 0; i < limit; i++) {
    const ch = formattedStr[i];
    if (ch === ',') {
      passedComma = true;
    } else if (ch >= '0' && ch <= '9') {
      if (!passedComma) intCount++;
      else decCount++;
    }
  }
  return { intCount, passedComma, decCount };
}

function findCursorPosInFormatted(formattedStr, { intCount, passedComma, decCount }) {
  let currentInt = 0;
  let currentDec = 0;
  let foundComma = false;

  if (intCount === 0 && !passedComma && decCount === 0) {
    return 0;
  }

  for (let i = 0; i < formattedStr.length; i++) {
    const ch = formattedStr[i];
    if (ch === ',') {
      if (!passedComma && currentInt >= intCount) {
        return i;
      }
      foundComma = true;
      if (passedComma && decCount === 0) {
        return i + 1;
      }
    } else if (ch >= '0' && ch <= '9') {
      if (!foundComma) {
        currentInt++;
        if (!passedComma && currentInt >= intCount) {
          return i + 1;
        }
      } else {
        currentDec++;
        if (currentDec >= decCount) {
          return i + 1;
        }
      }
    }
  }
  return formattedStr.length;
}

function renderMoneyInput(id, targetCursorPos) {
  const el = document.getElementById(id);
  const st = moneyStates[id];
  if (!el || !st) return;

  const formatted = formatMoneyParts(st.int, st.dec, st.isDec);
  el.value = formatted;

  if (typeof targetCursorPos === 'number') {
    try {
      el.setSelectionRange(targetCursorPos, targetCursorPos);
    } catch (e) {}
  }
}

function getMoneyValue(id) {
  const st = moneyStates[id];
  if (!st) return 0;
  const intPart = (st.int || '0').replace(/^0+/, '') || '0';
  const decPart = (st.dec || '').padEnd(2, '0').slice(0, 2);
  return parseFloat(intPart + '.' + decPart) || 0;
}

function setMoneyValue(id, num) {
  if (!moneyStates[id]) moneyStates[id] = { int: '', dec: '', isDec: false, onChange: null };
  const n = Number(num);
  if (isNaN(n) || (num === '' || num === null || num === undefined)) {
    moneyStates[id].int = '';
    moneyStates[id].dec = '';
    moneyStates[id].isDec = false;
  } else {
    const totalStr = Math.max(n || 0, 0).toFixed(2);
    const parts = totalStr.split('.');
    moneyStates[id].int = parts[0];
    moneyStates[id].dec = parts[1];
    moneyStates[id].isDec = true;
  }
  renderMoneyInput(id);
}

function applyMoneyEdit(el, id, type, inputData) {
  const st = moneyStates[id];
  if (!st) return;

  const val = el.value || '';
  const selStart = (typeof el.selectionStart === 'number') ? el.selectionStart : val.length;
  const selEnd = (typeof el.selectionEnd === 'number') ? el.selectionEnd : val.length;
  const isRange = selStart !== selEnd;
  const isAll = isRange && selStart === 0 && selEnd === val.length;

  let newInt = st.int;
  let newDec = st.dec;
  let newIsDec = st.isDec;
  let targetRawCounts = countRawBeforeCursor(val, selStart);

  if (type === 'deleteBackward') {
    if (isAll) {
      newInt = '';
      newDec = '';
      newIsDec = false;
      targetRawCounts = { intCount: 0, passedComma: false, decCount: 0 };
    } else if (isRange) {
      const beforeStr = val.slice(0, selStart);
      const afterStr = val.slice(selEnd);
      const parsed = parseMoneyString(beforeStr + afterStr);
      newInt = parsed.int;
      newDec = parsed.dec;
      newIsDec = parsed.isDec;
      targetRawCounts = countRawBeforeCursor(val, selStart);
    } else {
      if (selStart === 0) return;
      const charBefore = val[selStart - 1];

      if (charBefore === '.') {
        const delPos = selStart - 2;
        if (delPos >= 0) {
          const beforeStr = val.slice(0, delPos);
          const afterStr = val.slice(selStart);
          const parsed = parseMoneyString(beforeStr + afterStr);
          newInt = parsed.int;
          newDec = parsed.dec;
          newIsDec = parsed.isDec;
          const prev = countRawBeforeCursor(val, selStart);
          targetRawCounts = {
            intCount: Math.max(0, prev.intCount - 1),
            passedComma: prev.passedComma,
            decCount: prev.decCount
          };
        }
      } else if (charBefore === ',') {
        const beforeStr = val.slice(0, selStart - 1);
        const parsed = parseMoneyString(beforeStr);
        newInt = parsed.int;
        newDec = '';
        newIsDec = false;
        const prev = countRawBeforeCursor(val, selStart - 1);
        targetRawCounts = {
          intCount: prev.intCount,
          passedComma: false,
          decCount: 0
        };
      } else {
        const beforeStr = val.slice(0, selStart - 1);
        const afterStr = val.slice(selStart);
        const parsed = parseMoneyString(beforeStr + afterStr);
        newInt = parsed.int;
        newDec = parsed.dec;
        newIsDec = parsed.isDec;
        const prev = countRawBeforeCursor(val, selStart);
        if (prev.passedComma) {
          targetRawCounts = {
            intCount: prev.intCount,
            passedComma: true,
            decCount: Math.max(0, prev.decCount - 1)
          };
        } else {
          targetRawCounts = {
            intCount: Math.max(0, prev.intCount - 1),
            passedComma: false,
            decCount: 0
          };
        }
      }
    }
  } else if (type === 'deleteForward') {
    if (isAll) {
      newInt = '';
      newDec = '';
      newIsDec = false;
      targetRawCounts = { intCount: 0, passedComma: false, decCount: 0 };
    } else if (isRange) {
      const beforeStr = val.slice(0, selStart);
      const afterStr = val.slice(selEnd);
      const parsed = parseMoneyString(beforeStr + afterStr);
      newInt = parsed.int;
      newDec = parsed.dec;
      newIsDec = parsed.isDec;
      targetRawCounts = countRawBeforeCursor(val, selStart);
    } else {
      if (selStart >= val.length) return;
      const charAt = val[selStart];
      let delStart = selStart;
      let delEnd = selStart + 1;
      if (charAt === '.' || charAt === ',') {
        delStart = selStart;
        delEnd = Math.min(val.length, selStart + 2);
      }
      const beforeStr = val.slice(0, delStart);
      const afterStr = val.slice(delEnd);
      const parsed = parseMoneyString(beforeStr + afterStr);
      newInt = parsed.int;
      newDec = parsed.dec;
      newIsDec = parsed.isDec;
      targetRawCounts = countRawBeforeCursor(val, selStart);
    }
  } else if (type === 'insert') {
    const inputStr = String(inputData || '');
    for (const ch of inputStr) {
      if (ch === ',' || ch === '.') {
        if (isAll) {
          newInt = '0';
          newDec = '';
          newIsDec = true;
          targetRawCounts = { intCount: 1, passedComma: true, decCount: 0 };
        } else {
          const commaIdx = val.indexOf(',');
          if (commaIdx !== -1) {
            targetRawCounts = {
              intCount: countRawBeforeCursor(val, commaIdx).intCount,
              passedComma: true,
              decCount: 0
            };
          } else {
            const beforeStr = val.slice(0, selStart);
            const afterStr = val.slice(selEnd);
            const parsed = parseMoneyString(beforeStr + ',' + afterStr);
            newInt = parsed.int || '0';
            newDec = parsed.dec;
            newIsDec = true;
            const prev = countRawBeforeCursor(beforeStr, beforeStr.length);
            targetRawCounts = {
              intCount: prev.intCount || 1,
              passedComma: true,
              decCount: 0
            };
          }
        }
      } else if (/^[0-9]$/.test(ch)) {
        if (isAll) {
          newInt = ch;
          newDec = '';
          newIsDec = false;
          targetRawCounts = { intCount: 1, passedComma: false, decCount: 0 };
        } else {
          const beforeStr = val.slice(0, selStart);
          const afterStr = val.slice(selEnd);
          const commaIdx = val.indexOf(',');
          const isInsertingIntoDec = (commaIdx !== -1 && selStart > commaIdx);

          if (isInsertingIntoDec) {
            const currentDecDigits = (commaIdx !== -1 ? val.slice(commaIdx + 1) : '').replace(/\D/g, '');
            if (currentDecDigits.length >= 2 && !isRange) {
              continue;
            }
          } else {
            const currentIntDigits = (commaIdx !== -1 ? val.slice(0, commaIdx) : val).replace(/\D/g, '');
            if (currentIntDigits.length >= 11 && !isRange) {
              continue;
            }
          }

          const combined = beforeStr + ch + afterStr;
          const parsed = parseMoneyString(combined);
          newInt = parsed.int;
          newDec = parsed.dec;
          newIsDec = parsed.isDec || (commaIdx !== -1);

          const prev = countRawBeforeCursor(val, selStart);
          if (prev.passedComma || isInsertingIntoDec) {
            targetRawCounts = {
              intCount: prev.intCount,
              passedComma: true,
              decCount: prev.decCount + 1
            };
          } else {
            targetRawCounts = {
              intCount: prev.intCount + 1,
              passedComma: false,
              decCount: 0
            };
          }
        }
      }
    }
  }

  st.int = newInt;
  st.dec = newDec;
  st.isDec = newIsDec;

  const newFormatted = formatMoneyParts(st.int, st.dec, st.isDec);
  const newPos = findCursorPosInFormatted(newFormatted, targetRawCounts);

  renderMoneyInput(id, newPos);
  if (st.onChange) st.onChange(id);
}

function attachMoneyInput(id, onChange) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!moneyStates[id]) moneyStates[id] = { int: '', dec: '', isDec: false, onChange: null };
  moneyStates[id].onChange = onChange;

  if (el.dataset.moneyAttached === 'true') return;
  el.dataset.moneyAttached = 'true';

  let isFirstFocus = false;
  let focusTimestamp = 0;

  el.addEventListener('focus', () => {
    isFirstFocus = true;
    focusTimestamp = Date.now();
    setTimeout(() => {
      if (document.activeElement === el) {
        try {
          if (el.select) el.select();
          if (typeof el.setSelectionRange === 'function') {
            el.setSelectionRange(0, el.value.length);
          }
        } catch (err) {}
      }
    }, 25);
  });

  el.addEventListener('mouseup', (e) => {
    if (isFirstFocus && (Date.now() - focusTimestamp < 300)) {
      e.preventDefault();
    }
    isFirstFocus = false;
  });

  el.addEventListener('touchend', () => {
    if (isFirstFocus && (Date.now() - focusTimestamp < 300)) {
      // Retener selección inicial en móvil
    }
    setTimeout(() => {
      isFirstFocus = false;
    }, 150);
  });

  el.addEventListener('blur', () => {
    isFirstFocus = false;
    focusTimestamp = 0;
  });

  el.addEventListener('beforeinput', (e) => {
    if (e.inputType === 'deleteContentBackward') {
      e.preventDefault();
      applyMoneyEdit(el, id, 'deleteBackward');
      return;
    }
    if (e.inputType === 'deleteContentForward') {
      e.preventDefault();
      applyMoneyEdit(el, id, 'deleteForward');
      return;
    }
    if (e.inputType === 'deleteByCut') {
      e.preventDefault();
      applyMoneyEdit(el, id, 'deleteBackward');
      return;
    }
    if (e.inputType === 'insertText' || e.inputType === 'insertCompositionText') {
      if (e.data) {
        e.preventDefault();
        applyMoneyEdit(el, id, 'insert', e.data);
      }
      return;
    }
  });

  el.addEventListener('paste', (e) => {
    e.preventDefault();
    const pastedText = (e.clipboardData || window.clipboardData).getData('text') || '';
    applyMoneyEdit(el, id, 'insert', pastedText);
  });
}

// ============================================================
// UTILIDADES DE FECHA Y FORMATO
// ============================================================

function normalizarFechas_(fechas) {
  if (Array.isArray(fechas)) return fechas;
  if (typeof fechas === 'string') {
    try {
      const parsed = JSON.parse(fechas);
      if (Array.isArray(parsed)) return parsed;
    } catch (e) { }
    if (fechas.trim()) return [fechas.trim()];
  }
  return [];
}

function formatearMoneda_(n) {
  const num = Number(n) || 0;
  return '$ ' + num.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatearFechaISOLocal_(fecha) {
  const y = fecha.getFullYear();
  const m = String(fecha.getMonth() + 1).padStart(2, '0');
  const d = String(fecha.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

function hoyISO_() {
  return formatearFechaISOLocal_(new Date());
}

function sumarDiasLocal_(fecha, dias) {
  const f = new Date(fecha.getTime());
  f.setDate(f.getDate() + dias);
  return f;
}

function formatearFechaLegible_(iso) {
  if (!iso) return '--';
  const partes = iso.split('-').map(Number);
  const f = new Date(partes[0], partes[1] - 1, partes[2]);
  return f.toLocaleDateString('es-AR', { day: 'numeric', month: 'long' });
}

function capitalizeInput(el) {
  if (el.value.length === 1) el.value = el.value.toUpperCase();
}

// ============================================================
// HEADER, USUARIO ACTIVO Y PALETAS DE COLORES
// ============================================================

const PALETAS_COLORES_ = [
  { id: 'salvia', nombre: 'Salvia Original', desc: 'Minimalismo clásico', primary: '#536460', muted: '#D6E2DF', surface: '#FFFFFF', desktop: '#DCDFE5', headerSub: '#7E8F8B' },
  { id: 'bruma_aqua', nombre: 'Bruma Acuática', desc: 'Agua calma y aireada', primary: '#3D6B78', muted: '#C8E6EE', surface: '#F4FAFC', desktop: '#DCE8EC', headerSub: '#6F8E98' },
  { id: 'laguna', nombre: 'Laguna Turquesa', desc: 'Acuático suave y sereno', primary: '#2F6D6A', muted: '#C2EAE6', surface: '#F3FAF9', desktop: '#D9E8E6', headerSub: '#688E8C' },
  { id: 'azul_brisa', nombre: 'Azul Brisa', desc: 'Celeste empolvado elegante', primary: '#4A6587', muted: '#D0E1F7', surface: '#F5F9FD', desktop: '#DCE4EE', headerSub: '#748AA4' },
  { id: 'eucalipto', nombre: 'Eucalipto Pastel', desc: 'Menta botánica suave', primary: '#456B59', muted: '#CBEAD9', surface: '#F4FAF6', desktop: '#DCE7E0', headerSub: '#718D7F' },
  { id: 'lavanda', nombre: 'Lavanda Boreal', desc: 'Lila pastel equilibrado', primary: '#63597A', muted: '#E0D8F2', surface: '#F9F7FD', desktop: '#E3DFEC', headerSub: '#857C99' },
  { id: 'rosa_cuarzo', nombre: 'Rosa Cuarzo', desc: 'Rosa empolvado sutil', primary: '#7A5662', muted: '#F2D6DF', surface: '#FCF7F9', desktop: '#EBE0E4', headerSub: '#987B85' },
  { id: 'oliva_arena', nombre: 'Arena & Oliva', desc: 'Tonos cálidos naturales', primary: '#62664F', muted: '#E5E8D3', surface: '#FAFBF5', desktop: '#E6E7DC', headerSub: '#848772' },
  { id: 'coral_pastel', nombre: 'Durazno & Terracota', desc: 'Coral pastel cálido y suave', primary: '#82564B', muted: '#F5D9D0', surface: '#FDF8F6', desktop: '#EDE1DC', headerSub: '#A17A70' },
  { id: 'oceano_profundo', nombre: 'Índigo Costero', desc: 'Azul mar sereno y profundo', primary: '#3B5675', muted: '#CBDDF2', surface: '#F4F8FC', desktop: '#D8E2EE', headerSub: '#6882A1' },
  { id: 'jade_imperial', nombre: 'Agua de Jade', desc: 'Esmeralda apastelado fresco', primary: '#366B5F', muted: '#C4EAE0', surface: '#F3FAF8', desktop: '#D7E8E3', headerSub: '#649489' },
  { id: 'ciruela_suave', nombre: 'Ciruela & Malva', desc: 'Malva pastel aterciopelado', primary: '#6E4D69', muted: '#EBD4E8', surface: '#FCF7FB', desktop: '#E8DCE6', headerSub: '#93748E' },
  { id: 'cacao_lino', nombre: 'Moka & Lino', desc: 'Tierra cálida minimalista', primary: '#6B584C', muted: '#E8DDD5', surface: '#FBF9F7', desktop: '#E6DFDA', headerSub: '#8F7D72' },
  { id: 'glaciar_artico', nombre: 'Hielo Ártico', desc: 'Cian mineral limpio y fresco', primary: '#3F6870', muted: '#CAE7EC', surface: '#F5FAFB', desktop: '#DAE7E9', headerSub: '#6B9199' },
  { id: 'violeta_niebla', nombre: 'Iris de Niebla', desc: 'Azul violáceo suave y etéreo', primary: '#53587D', muted: '#D6D9F2', surface: '#F7F8FD', desktop: '#DEE0EC', headerSub: '#7B80A3' },
  { id: 'bosque_niebla', nombre: 'Pino & Niebla', desc: 'Verde nórdico reposado', primary: '#426158', muted: '#C9E2DA', surface: '#F4F9F7', desktop: '#D9E5E1', headerSub: '#6D8A81' },
  { id: 'ambar_duna', nombre: 'Duna Dorada', desc: 'Ocre arena suave y elegante', primary: '#736145', muted: '#EDE2CE', surface: '#FCF9F4', desktop: '#E8E2D8', headerSub: '#96856A' },
  { id: 'grafito_perla', nombre: 'Pizarra & Perla', desc: 'Gris azulado neutro moderno', primary: '#4F5966', muted: '#D7DFE8', surface: '#F7F9FB', desktop: '#DCE1E8', headerSub: '#78828F' },
  { id: 'mandarina_suave', nombre: 'Mandarina & Crema', desc: 'Naranja pastel cálido y luminoso', primary: '#9C5A34', muted: '#F7D9C4', surface: '#FDF8F4', desktop: '#EFE1D7', headerSub: '#B37B5B' },
  { id: 'atardecer_ambar', nombre: 'Naranja Atardecer', desc: 'Damasco suave y acogedor', primary: '#A3523B', muted: '#FAD6CC', surface: '#FDF7F5', desktop: '#F0DFDA', headerSub: '#B87663' },
  { id: 'cobre_papaya', nombre: 'Papaya & Cobre', desc: 'Naranja tostado minimalista', primary: '#8C5438', muted: '#F2DACB', surface: '#FCF8F5', desktop: '#ECE0D8', headerSub: '#A67860' },
  { id: 'miel_mostaza', nombre: 'Miel & Camomila', desc: 'Amarillo ocre suave y cálido', primary: '#7D6332', muted: '#F2E5C4', surface: '#FDFAF3', desktop: '#ECE5D5', headerSub: '#9C8659' },
  { id: 'pistacho_matcha', nombre: 'Matcha & Pistacho', desc: 'Verde lima pastel botánico', primary: '#526B44', muted: '#D6EBC9', surface: '#F6FBF4', desktop: '#DDE8D8', headerSub: '#78916A' },
  { id: 'frambuesa_pastel', nombre: 'Frambuesa Suave', desc: 'Carmesí empolvado delicado', primary: '#874856', muted: '#F5D0D8', surface: '#FDF6F8', desktop: '#EEDCE0', headerSub: '#A66D7A' },
  { id: 'cobalto_sereno', nombre: 'Azul Ultramar', desc: 'Cobalto apastelado vibrante', primary: '#3D568A', muted: '#CCD9F7', surface: '#F4F7FD', desktop: '#D9E1F0', headerSub: '#6B81B0' },
  { id: 'noche_carbon', nombre: 'Antracita & Humo', desc: 'Neutro oscuro minimalista', primary: '#3E4347', muted: '#D5D9DC', surface: '#F7F8F9', desktop: '#DCE0E3', headerSub: '#6E7478' }
];

let paletteTargetUser_ = null;

function hexToRgb_(hex) {
  const clean = String(hex || '').replace('#', '');
  if (clean.length !== 6) return { r: 83, g: 100, b: 96 };
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16)
  };
}

function mixHex_(hex, target, amount) {
  const { r, g, b } = hexToRgb_(hex);
  const mr = Math.round(r + (target - r) * amount);
  const mg = Math.round(g + (target - g) * amount);
  const mb = Math.round(b + (target - b) * amount);
  return '#' + [mr, mg, mb].map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
}

function construirVariablesPaleta_(paleta) {
  const rgb = hexToRgb_(paleta.primary);
  return {
    '--color-primary': paleta.primary,
    '--color-primary-dark': mixHex_(paleta.primary, 0, 0.22),
    '--color-primary-light': mixHex_(paleta.primary, 255, 0.16),
    '--color-primary-glow': `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.25)`,
    '--color-surface-card': paleta.primary,
    '--color-surface-header': paleta.surface,
    '--color-muted': paleta.muted,
    '--color-header-sub': paleta.headerSub,
    '--color-bg-desktop': paleta.desktop
  };
}

function obtenerPaletaUsuario_(user) {
  const targetUser = user === 'Virginia' ? 'Virginia' : 'Brian';
  const savedId = localStorage.getItem('userPalette_' + targetUser) || 'salvia';
  return PALETAS_COLORES_.find(p => p.id === savedId) || PALETAS_COLORES_[0];
}

function aplicarPaletaUsuario_(user) {
  const targetUser = user === 'Virginia' ? 'Virginia' : 'Brian';
  const paleta = obtenerPaletaUsuario_(targetUser);
  const vars = construirVariablesPaleta_(paleta);
  const root = document.documentElement;
  Object.keys(vars).forEach(key => {
    root.style.setProperty(key, vars[key]);
  });

  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) metaTheme.setAttribute('content', paleta.primary);

  try {
    localStorage.setItem('userPaletteVars_' + targetUser, JSON.stringify(vars));
  } catch (e) {}

  return paleta;
}

function renderPaletteOptions_() {
  const grid = document.getElementById('palette-options-grid');
  if (!grid) return;
  const user = paletteTargetUser_ || appState.activeUser || 'Brian';
  const activeId = obtenerPaletaUsuario_(user).id;

  grid.innerHTML = PALETAS_COLORES_.map(p => {
    const isSelected = p.id === activeId;
    return '<button type="button" onclick="seleccionarPaletaUsuario(\'' + p.id + '\')" class="palette-option-card ' + (isSelected ? 'active' : '') + '">' +
      '<div class="flex items-center gap-3 min-w-0">' +
        '<span class="palette-swatches">' +
          '<span class="palette-swatch-dot" style="background-color:' + p.primary + ';"></span>' +
          '<span class="palette-swatch-dot" style="background-color:' + p.muted + ';"></span>' +
          '<span class="palette-swatch-dot" style="background-color:' + p.surface + ';"></span>' +
        '</span>' +
        '<div class="min-w-0">' +
          '<span class="text-sm font-bold text-zinc-800 block leading-tight truncate">' + p.nombre + '</span>' +
          '<span class="text-[11px] text-zinc-500 block leading-tight truncate">' + p.desc + '</span>' +
        '</div>' +
      '</div>' +
      (isSelected
        ? '<span class="w-6 h-6 rounded-full theme-bg-primary text-white flex items-center justify-center shrink-0 text-xs font-bold">✓</span>'
        : '<span class="w-6 h-6 rounded-full border border-zinc-200 shrink-0"></span>') +
      '</button>';
  }).join('');
}

function openPaletteModal(user) {
  const targetUser = user === 'Virginia' ? 'Virginia' : 'Brian';
  if (appState.activeUser !== targetUser) {
    setActiveUser(targetUser);
  }
  paletteTargetUser_ = targetUser;

  const titleEl = document.getElementById('palette-modal-title');
  if (titleEl) titleEl.textContent = 'Paleta de ' + targetUser;

  renderPaletteOptions_();
  const modal = document.getElementById('palette-modal');
  if (modal) modal.classList.add('active');
  pushModalHistory_('palette-modal');
}

function closePaletteModal() {
  const modal = document.getElementById('palette-modal');
  if (modal) modal.classList.remove('active');
}

function seleccionarPaletaUsuario(paletteId) {
  const paleta = PALETAS_COLORES_.find(p => p.id === paletteId);
  if (!paleta) return;
  const targetUser = paletteTargetUser_ || appState.activeUser || 'Brian';
  localStorage.setItem('userPalette_' + targetUser, paleta.id);
  aplicarPaletaUsuario_(targetUser);
  renderPaletteOptions_();
}

function initAvatarLongPress_() {
  const bindAvatar = (btnId, user) => {
    const btn = document.getElementById(btnId);
    if (!btn) return;

    let timer = null;
    let longPressTriggered = false;
    let startX = 0;
    let startY = 0;

    const clearTimer = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    btn.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      longPressTriggered = false;
      startX = e.clientX;
      startY = e.clientY;
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        longPressTriggered = true;
        if (navigator.vibrate) {
          try { navigator.vibrate(15); } catch (err) {}
        }
        openPaletteModal(user);
      }, 420);
    });

    btn.addEventListener('pointermove', e => {
      if (!timer) return;
      if (Math.abs(e.clientX - startX) > 12 || Math.abs(e.clientY - startY) > 12) {
        clearTimer();
      }
    });

    btn.addEventListener('pointerup', clearTimer);
    btn.addEventListener('pointercancel', clearTimer);
    btn.addEventListener('pointerleave', clearTimer);

    btn.addEventListener('contextmenu', e => {
      e.preventDefault();
    });

    btn.addEventListener('click', e => {
      if (longPressTriggered) {
        longPressTriggered = false;
        e.preventDefault();
        return;
      }
      if (appState.activeUser === user) {
        openPaletteModal(user);
      } else {
        setActiveUser(user);
      }
    });
  };

  bindAvatar('user-btn-brian', 'Brian');
  bindAvatar('user-btn-virginia', 'Virginia');
}

function cargarUsuarioYColorLocal_() {
  appState.activeUser = localStorage.getItem('userActive') || 'Brian';
  aplicarPaletaUsuario_(appState.activeUser);
  pintarBotonesUsuario_();
}

function resolverBadgeUsuario_(usuarioMov) {
  const user = usuarioMov === 'Virginia'
    ? 'Virginia'
    : (usuarioMov === 'Brian' ? 'Brian' : (appState.activeUser || 'Brian'));
  const letter = user === 'Virginia' ? 'V' : 'B';
  const esOtroUsuario = user !== appState.activeUser;
  const color = esOtroUsuario ? '#d31818' : 'var(--color-primary)';
  return { user, letter, esOtroUsuario, color };
}

function actualizarBadgeUsuarioModal_(usuarioMov) {
  const badge = resolverBadgeUsuario_(usuarioMov);
  const label = document.getElementById('modal-user-label');
  const circle = document.getElementById('tx-user-circle');
  if (label) label.textContent = badge.letter;
  if (circle) {
    circle.style.color = badge.color;
  }
}

function pintarBotonesUsuario_() {
  const brianBtn = document.getElementById('user-btn-brian');
  const virginiaBtn = document.getElementById('user-btn-virginia');
  if (brianBtn && virginiaBtn) {
    if (appState.activeUser === 'Brian') {
      brianBtn.classList.add('active');
      virginiaBtn.classList.remove('active');
    } else {
      virginiaBtn.classList.add('active');
      brianBtn.classList.remove('active');
    }
  }

  const titleEl = document.getElementById('nav-title-text');
  if (titleEl) titleEl.textContent = 'Hola, ' + appState.activeUser;

  actualizarBadgeUsuarioModal_(appState.activeUser);
}

function setActiveUser(user) {
  resetTxForm_();
  appState.activeUser = user;
  localStorage.setItem('userActive', user);
  aplicarPaletaUsuario_(user);
  pintarBotonesUsuario_();
  renderMicroView();
  sincronizarUsuarioPush_(user);
  actualizarIndicadorMensajes_();
  chequearMensajeRecibido_(appState.ultimoMensaje);
  chequearNotificacionEntrante_(appState.ultimaNotificacion);
}


// ============================================================
// VISTA MICRO (MOTOR DIARIO)
// ============================================================

function calcularComposicion_(hbOverride, bolsaOverride) {
  const dias = appState.diasRestantes;
  const hbVal = hbOverride !== undefined ? hbOverride : appState.homeBankingTotal;
  const bolsaVal = bolsaOverride !== undefined ? bolsaOverride : appState.bolsaTotal;
  const liquidHB = hbVal - bolsaVal;
  const gastosPorFecha = {};
  dias.forEach(f => { gastosPorFecha[f] = 0; });

  let gastosEnPeriodo = 0;
  appState.movimientos.forEach(m => {
    if (m.fromBag) return;
    const fechas = normalizarFechas_(m.fechasAfectadas);
    fechas.forEach(f => {
      if (Object.prototype.hasOwnProperty.call(gastosPorFecha, f)) {
        gastosPorFecha[f] += m.montoPorFecha;
        gastosEnPeriodo += m.montoPorFecha;
      }
    });
  });

  const objetivoBase = dias.length > 0 ? (liquidHB + gastosEnPeriodo) / dias.length : 0;
  return { objetivoBase: objetivoBase, gastosPorFecha: gastosPorFecha };
}

function presupuestoParaFecha_(fechaISO) {
  const comp = calcularComposicion_();
  return comp.objetivoBase - (comp.gastosPorFecha[fechaISO] || 0);
}

function renderMicroView() {
  const hbEl = document.getElementById('hb-total-display');
  const bolsaEl = document.getElementById('savings-bag-display');
  if (hbEl) hbEl.textContent = formatearMoneda_(appState.homeBankingTotal);
  if (bolsaEl) bolsaEl.textContent = formatearMoneda_(appState.bolsaTotal);

  const hoyStr = hoyISO_();
  const mananaStr = formatearFechaISOLocal_(sumarDiasLocal_(new Date(), 1));

  const presupuestoHoy = presupuestoParaFecha_(hoyStr);
  const presupuestoManana = presupuestoParaFecha_(mananaStr);

  const hoyEl = document.getElementById('today-budget-display');
  const mananaEl = document.getElementById('tomorrow-budget-display');
  const diasLabel = document.getElementById('days-remaining-label');
  if (hoyEl) hoyEl.textContent = formatearMoneda_(presupuestoHoy);
  if (mananaEl) mananaEl.textContent = formatearMoneda_(presupuestoManana);
  if (diasLabel) {
    diasLabel.textContent = 'Quedan ' + appState.diasRestantes.length +
      ' días (cobrás el ' + formatearFechaLegible_(appState.diaCobro) + ')';
  }

  renderTransactionList_();
}

function renderTransactionList_() {
  const cont = document.getElementById('transaction-list');
  if (!cont) return;
  const hoyStr = hoyISO_();
  const diasPeriodo = appState.diasRestantes || [];

  const delPeriodo = appState.movimientos.filter(m => {
    const fechas = normalizarFechas_(m.fechasAfectadas);
    return fechas.some(f => diasPeriodo.includes(f) || f >= hoyStr);
  });

  if (!delPeriodo.length) {
    cont.innerHTML = '<p class="text-xs text-white/50 text-center py-6">Sin movimientos registrados</p>';
    return;
  }

  cont.innerHTML = delPeriodo.map(m => {
    const titulo = m.descripcion || (m.tipo === 'divisible' ? 'Gasto divisible' : 'Gasto único');
    const fechas = normalizarFechas_(m.fechasAfectadas);

    let textoFechas = '';
    if (fechas.length === 1 && fechas[0] === hoyStr) {
      textoFechas = 'Hoy';
    } else {
      textoFechas = fechas.map(f => {
        const p = f.split('-').map(Number);
        return p[2] + '/' + p[1];
      }).join(', ');
    }

    const badge = resolverBadgeUsuario_(m.usuario);

    return '<button onclick="toggleModal(true, \'' + m.id + '\')" class="w-full flex items-center justify-between text-left py-2 border-b border-white/10 hover:opacity-90 active:opacity-80 transition-opacity">' +
      '<div class="flex items-center gap-3">' +
      '<div class="w-8 h-8 rounded-full bg-white font-avatar font-bold text-sm flex items-center justify-center shrink-0" style="color: ' + badge.color + ';">' + badge.letter + '</div>' +
      '<div>' +
      '<span class="text-[11px] text-white/80 block leading-tight">' + textoFechas + '</span>' +
      '<span class="text-xs font-bold text-white block leading-snug">' + titulo + '</span>' +
      '</div></div>' +
      '<div class="flex items-center gap-4">' +
      (m.fromBag ? '<span class="text-xs text-white/80 font-normal">Ahorro</span>' : '') +
      '<span class="text-sm font-bold text-white tracking-tight">' + formatearMoneda_(m.monto) + '</span>' +
      '</div></button>';
  }).join('');
}

// ============================================================
// MODAL "ACTUALIZAR HOME BANKING Y AHORROS"
// ============================================================

function guardarCacheDiarioLocal_() {
  try {
    localStorage.setItem('cached_diario_state', JSON.stringify({
      homeBankingTotal: appState.homeBankingTotal,
      bolsaTotal: appState.bolsaTotal,
      diaCobro: appState.diaCobro,
      diasRestantes: appState.diasRestantes,
      movimientos: appState.movimientos,
      lastProcessedDate: appState.lastProcessedDate,
      ultimaNotificacion: appState.ultimaNotificacion,
      ultimoMensaje: appState.ultimoMensaje,
      onesignalAppId: appState.onesignalAppId
    }));
  } catch (e) {}
}

function cerrarSubvistasTarjetaExcepto_(keepId) {
  ['hb-modal', 'budget-audit-modal', 'future-days-modal'].forEach(id => {
    if (id === keepId) return;
    if (id === 'hb-modal') {
      setMoneyValue('hb-update-amount', '');
      setMoneyValue('hb-bolsa-input', '');
    }
    const el = document.getElementById(id);
    if (el) {
      el.classList.add('hidden');
      el.classList.remove('flex', 'active');
    }
  });
}

function toggleHbModal(show) {
  const modal = document.getElementById('hb-modal');
  const dash = document.getElementById('micro-dashboard-view');
  if (show) {
    cerrarSubvistasTarjetaExcepto_('hb-modal');
    prepararHbModal_();
    if (dash) dash.classList.add('hidden');
    if (modal) {
      modal.classList.remove('hidden');
      modal.classList.add('flex', 'active');
    }
    autoFitCircleButtons();
    pushModalHistory_('hb-modal');
  } else {
    setMoneyValue('hb-update-amount', '');
    setMoneyValue('hb-bolsa-input', '');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex', 'active');
    }
    if (dash) dash.classList.remove('hidden');
  }
}

function sincronizarPlaceholdersHbModal_() {
  const diasCount = (appState.diasRestantes || []).length;
  const diasLabel = document.getElementById('hb-days-label');
  if (diasLabel) {
    diasLabel.textContent = 'Quedan ' + diasCount + ' días hasta el cobro';
  }

  const elHb = document.getElementById('hb-update-amount');
  const elBolsa = document.getElementById('hb-bolsa-input');
  if (elHb) elHb.placeholder = formatearMoneda_(appState.homeBankingTotal);
  if (elBolsa) elBolsa.placeholder = formatearMoneda_(appState.bolsaTotal);
}

function obtenerMontoInputOActual_(inputId, fallbackVal) {
  const st = moneyStates[inputId];
  const hasEdit = st && (st.int !== '' || st.isDec);
  return hasEdit ? getMoneyValue(inputId) : fallbackVal;
}

function actualizarResumenHbModal_() {
  const hbEfectivo = obtenerMontoInputOActual_('hb-update-amount', appState.homeBankingTotal);
  const bolsaEfectiva = obtenerMontoInputOActual_('hb-bolsa-input', appState.bolsaTotal);
  const diasCount = (appState.diasRestantes || []).length;

  const disponibleLiquido = hbEfectivo - bolsaEfectiva;
  const presupuestoSimple = diasCount > 0 ? disponibleLiquido / diasCount : 0;

  const hoyStr = hoyISO_();
  const compEfectiva = calcularComposicion_(hbEfectivo, bolsaEfectiva);
  const disponibleHoy = compEfectiva.objetivoBase - (compEfectiva.gastosPorFecha[hoyStr] || 0);

  const simpleEl = document.getElementById('hb-preview-daily-simple');
  const hoyEl = document.getElementById('hb-preview-today-left');
  if (simpleEl) simpleEl.textContent = formatearMoneda_(presupuestoSimple);
  if (hoyEl) hoyEl.textContent = formatearMoneda_(disponibleHoy);
}

function refrescarVistaHbModalSiAbierto_() {
  const modal = document.getElementById('hb-modal');
  if (!modal || modal.classList.contains('hidden')) return;
  sincronizarPlaceholdersHbModal_();
  actualizarResumenHbModal_();
}

function prepararHbModal_() {
  sincronizarPlaceholdersHbModal_();
  setMoneyValue('hb-update-amount', '');
  setMoneyValue('hb-bolsa-input', '');
  actualizarResumenHbModal_();
}

attachMoneyInput('hb-update-amount', actualizarResumenHbModal_);
attachMoneyInput('hb-bolsa-input', actualizarResumenHbModal_);
attachMoneyInput('tx-amount', () => {});

function aplicarYGuardarHbYBolsa_(finalHb, finalBolsa) {
  ++diarioLoadToken_;

  appState.homeBankingTotal = finalHb;
  appState.bolsaTotal = finalBolsa;
  setMoneyValue('hb-update-amount', '');
  setMoneyValue('hb-bolsa-input', '');
  guardarCacheDiarioLocal_();
  renderMicroView();
  refrescarVistaHbModalSiAbierto_();

  callBackendBackground('actualizarHB', {
    homeBankingTotal: appState.homeBankingTotal,
    bolsaTotal: appState.bolsaTotal
  }).catch(err => console.error('Error al actualizar Home Banking:', err));
}

async function saveHbAmount() {
  const finalHb = obtenerMontoInputOActual_('hb-update-amount', appState.homeBankingTotal);
  const finalBolsa = obtenerMontoInputOActual_('hb-bolsa-input', appState.bolsaTotal);
  aplicarYGuardarHbYBolsa_(finalHb, finalBolsa);
  showAppToast('Saldo actualizado');
}

async function handleVaciarBolsaAhorro() {
  const finalHb = obtenerMontoInputOActual_('hb-update-amount', appState.homeBankingTotal);
  aplicarYGuardarHbYBolsa_(finalHb, 0);
  showAppToast('Ahorros pasados al presupuesto');
}

function initOutsideCardTapToClose_() {
  document.addEventListener('click', (e) => {
    const hbModal = document.getElementById('hb-modal');
    if (!hbModal || hbModal.classList.contains('hidden')) return;
    const target = e.target;
    if (!target || typeof target.closest !== 'function') return;
    if (target.closest('.card-dark-main')) return;
    if (target.closest('.avatar-btn') || target.closest('.modal-overlay')) return;
    toggleHbModal(false);
  });
}

// ============================================================
// "LIMPIAR MOVIMIENTOS PENDIENTES"
// ============================================================

async function handleLimpiarPendientes() {
  mostrarSyncToast_();
  try {
    const resultado = await callBackend('limpiarMovimientosPendientes', {});
    await recargarEstadoDiario_(false);
    limpiarColaCandidatos = (resultado.candidatos || []).slice();
    procesarSiguienteCandidato_();
  } catch (e) {
    alert('Error al limpiar movimientos');
  } finally {
    ocultarSyncToast_();
  }
}

function procesarSiguienteCandidato_() {
  if (!limpiarColaCandidatos.length) {
    renderMicroView();
    refrescarVistaHbModalSiAbierto_();
    showAppToast('Movimientos pendientes limpiados');
    return;
  }
  const candidato = limpiarColaCandidatos[0];
  const desc = document.getElementById('limpiar-candidato-desc');
  if (desc) {
    desc.textContent = (candidato.descripcion || 'Gasto divisible') + ' — ' +
      formatearMoneda_(candidato.monto) + ' en total';
  }
  document.getElementById('limpiar-candidato-modal').classList.add('active');
}

async function resolverCandidatoLimpiar(accion) {
  const candidato = limpiarColaCandidatos.shift();
  document.getElementById('limpiar-candidato-modal').classList.remove('active');

  mostrarSyncToast_();
  try {
    if (accion === 'borrar') {
      await callBackend('eliminarMovimiento', { id: candidato.id });
    } else if (accion === 'single') {
      await callBackend('guardarMovimiento', {
        id: candidato.id,
        tipo: 'single',
        fechasAfectadas: [hoyISO_()],
        monto: candidato.montoPorFecha,
        descripcion: candidato.descripcion,
        usuario: candidato.usuario,
        fromBag: candidato.fromBag
      });
    }
    await recargarEstadoDiario_(false);
  } catch (e) {
    alert('Error al procesar candidato');
  } finally {
    ocultarSyncToast_();
    procesarSiguienteCandidato_();
  }
}

// ============================================================
// CIERRE DE DÍA
// ============================================================

function normalizarFechaConfig_(raw, hoyStr) {
  if (raw === null || raw === undefined || raw === '') return null;
  const hoy = hoyStr || hoyISO_();
  if (raw instanceof Date && !isNaN(raw.getTime())) {
    return formatearFechaISOLocal_(raw);
  }
  const s = String(raw).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{1,2}$/.test(s)) {
    return hoy.slice(0, 7) + '-' + s.padStart(2, '0');
  }
  const ymd = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (ymd) {
    return ymd[1] + '-' + ymd[2].padStart(2, '0') + '-' + ymd[3].padStart(2, '0');
  }
  const dmy = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (dmy) {
    return dmy[3] + '-' + dmy[2].padStart(2, '0') + '-' + dmy[1].padStart(2, '0');
  }
  if (/^\d{4}-\d{2}-\d{2}T00:00:00(\.000)?Z$/i.test(s)) {
    return s.slice(0, 10);
  }
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) {
    return formatearFechaISOLocal_(parsed);
  }
  return null;
}

async function chequearCierreDia_() {
  const hoyStr = hoyISO_();
  appState.lastProcessedDate = normalizarFechaConfig_(appState.lastProcessedDate, hoyStr);

  // Si la hoja Config nunca tuvo un lastProcessedDate guardado (primera vez que
  // corre la app, o el valor se borró/nunca se seteó), no hay "día anterior" con
  // el cual comparar. Antes esto cortaba la función acá para siempre y la fecha
  // jamás quedaba guardada en Config, así que el modal nunca se disparaba en
  // ningún día futuro tampoco. Ahora sembramos hoy como línea de base (sin
  // preguntar nada, porque no hay sobrante/déficit real que resolver) para que
  // a partir de mañana el chequeo funcione con normalidad.
  if (!appState.lastProcessedDate) {
    try {
      const resultado = await callBackend('resolverCierreDia', { decision: 'redistribuir', tipo: 'sobrante', monto: 0 });
      appState.lastProcessedDate = resultado.lastProcessedDate;
    } catch (e) {
      console.error('No se pudo inicializar lastProcessedDate en Config:', e);
    }
    return;
  }

  if (appState.lastProcessedDate === hoyStr) return;
  if (appState.lastProcessedDate > hoyStr) return;

  const ventana = [appState.lastProcessedDate].concat(appState.diasRestantes);
  const liquidHB = appState.homeBankingTotal - appState.bolsaTotal;
  const gastosPorFecha = {};
  ventana.forEach(f => { gastosPorFecha[f] = 0; });

  let gastosEnVentana = 0;
  appState.movimientos.forEach(m => {
    if (m.fromBag) return;
    const fechas = normalizarFechas_(m.fechasAfectadas);
    fechas.forEach(f => {
      if (Object.prototype.hasOwnProperty.call(gastosPorFecha, f)) {
        gastosPorFecha[f] += m.montoPorFecha;
        gastosEnVentana += m.montoPorFecha;
      }
    });
  });

  const objetivoAyer = ventana.length > 0 ? (liquidHB + gastosEnVentana) / ventana.length : 0;
  const gastoAyer = gastosPorFecha[appState.lastProcessedDate] || 0;
  const diferencia = objetivoAyer - gastoAyer;

  if (Math.abs(diferencia) < 1) {
    const resultado = await callBackendConSync('resolverCierreDia', { decision: 'redistribuir', tipo: 'sobrante', monto: 0 });
    appState.lastProcessedDate = resultado.lastProcessedDate;
    return;
  }

  cierreDiaPendiente = { tipo: diferencia > 0 ? 'sobrante' : 'deficit', monto: Math.abs(diferencia) };
  mostrarModalCierreDia_(cierreDiaPendiente);
}

function mostrarModalCierreDia_(info) {
  const esDeficit = info.tipo === 'deficit';
  document.getElementById('day-change-title').textContent = esDeficit ? '📉 Ayer te pasaste' : '☀️ Cierre de ayer';
  document.getElementById('day-change-desc').innerHTML = esDeficit
    ? 'Ayer te pasaste por <strong class="text-zinc-800">' + formatearMoneda_(info.monto) + '</strong>. ¿Cómo lo cubrimos?'
    : 'Ayer te sobraron <strong class="text-zinc-800">' + formatearMoneda_(info.monto) + '</strong>. ¿Qué hacemos?';
  const btnEditHb = document.getElementById('day-change-btn-edit-hb');
  if (btnEditHb) btnEditHb.textContent = 'Actualizar saldo';
  document.getElementById('day-change-btn-bag').textContent = esDeficit ? 'Cubrir con Ahorros' : 'Guardar en Ahorros';
  document.getElementById('day-change-btn-distribute').textContent = 'Repartir en los próximos días';
  document.getElementById('day-change-modal').classList.add('active');
}

async function resolveDayChange(decision) {
  const info = cierreDiaPendiente;
  if (!info) return;
  document.getElementById('day-change-modal').classList.remove('active');

  if (decision === 'edit_hb') {
    ++diarioLoadToken_;
    appState.lastProcessedDate = hoyISO_();
    cierreDiaPendiente = null;
    guardarCacheDiarioLocal_();
    toggleHbModal(true);
    setTimeout(() => {
      const input = document.getElementById('hb-update-amount');
      if (input && typeof input.focus === 'function') input.focus();
    }, 60);
    callBackendBackground('resolverCierreDia', {
      decision: 'redistribuir',
      tipo: info.tipo,
      monto: 0
    }).catch(err => console.error('Error al actualizar fecha de cierre:', err));
    return;
  }

  mostrarSyncToast_();
  try {
    const resultado = await callBackend('resolverCierreDia', {
      decision: decision === 'bag' ? 'bolsa' : 'redistribuir',
      tipo: info.tipo,
      monto: info.monto
    });

    appState.bolsaTotal = resultado.bolsaTotal;
    appState.lastProcessedDate = normalizarFechaConfig_(resultado.lastProcessedDate, hoyISO_());
    cierreDiaPendiente = null;
    await recargarEstadoDiario_(false);
  } catch (e) {
    alert('Error al cerrar día');
  } finally {
    ocultarSyncToast_();
  }
}

// ============================================================
// MODAL "REGISTRAR MOVIMIENTO" (ÚNICO / DIVISIBLE)
// ============================================================

let isExplicitEditingTx_ = false;

function setMicroSubView(view, push = true) {
  const panelList = document.getElementById('micro-panel-list');
  const panelAdd = document.getElementById('micro-panel-add');
  const tabList = document.getElementById('tab-movs-list');
  const tabAdd = document.getElementById('tab-movs-add');
  if (!panelList || !panelAdd) return;

  if (view === 'list') {
    isExplicitEditingTx_ = false;
    resetTxForm_();
    panelList.classList.remove('hidden');
    panelAdd.classList.add('hidden');
    panelAdd.classList.remove('flex');
    if (tabList) {
      tabList.className = 'text-xs font-black tracking-wider text-white border-b-2 border-white pb-1 focus:outline-none uppercase';
    }
    if (tabAdd) {
      tabAdd.className = 'text-xs font-normal tracking-wider text-white/70 hover:text-white pb-1 focus:outline-none uppercase';
    }
  } else {
    panelAdd.classList.remove('hidden');
    panelAdd.classList.add('flex');
    panelList.classList.add('hidden');
    if (tabAdd) {
      tabAdd.className = 'text-xs font-black tracking-wider text-white border-b-2 border-white pb-1 focus:outline-none uppercase';
    }
    if (tabList) {
      tabList.className = 'text-xs font-normal tracking-wider text-white/70 hover:text-white pb-1 focus:outline-none uppercase';
    }

    // Si NO proviene explícitamente de presionar un elemento de la lista para editar (prepararTxModalEdicion_), ejecutar de forma INCONDICIONAL reseteo
    if (!isExplicitEditingTx_) {
      resetTxForm_();
      editingMovimientoId = null;
      const delBtn = document.getElementById('btn-delete-tx');
      if (delBtn) {
        delBtn.classList.add('hidden');
        delBtn.style.display = 'none';
        delBtn.setAttribute('disabled', 'true');
      }
    }
    isExplicitEditingTx_ = false;

    renderTxDaysCarousel_();
    autoFitCircleButtons();
    if (push) pushModalHistory_('micro-subview-add');
  }
}

function scrollDaysCarousel(delta) {
  const cont = document.getElementById('tx-days-carousel');
  if (cont) {
    cont.scrollBy({ left: delta * 120, behavior: 'smooth' });
  }
}

function renderTxDaysCarousel_() {
  const cont = document.getElementById('tx-days-carousel');
  if (!cont) return;

  if (!cont.dataset.touchIsolated) {
    cont.dataset.touchIsolated = 'true';
    cont.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
    cont.addEventListener('touchmove', (e) => e.stopPropagation(), { passive: true });
  }

  const hoy = hoyISO_();
  const dias = (appState.diasRestantes && appState.diasRestantes.length)
    ? appState.diasRestantes.slice(0, 15)
    : [hoy];
  if (!dias.includes(hoy)) dias.unshift(hoy);

  const assignedInput = document.getElementById('tx-assigned-date');
  const customDaysInput = document.getElementById('tx-custom-days');
  const currentAssigned = (assignedInput && assignedInput.value) || hoy;
  const customDaysStr = (customDaysInput && customDaysInput.value) ? customDaysInput.value : '';
  const customDayNums = customDaysStr.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));

  const diasNombres = ['Dom', 'Lun', 'Mar', 'Mie', 'Jue', 'Vier', 'Sab'];

  cont.innerHTML = dias.map(f => {
    const partes = f.split('-').map(Number);
    const dObj = new Date(partes[0], partes[1] - 1, partes[2]);
    const nombreDia = diasNombres[dObj.getDay()];
    const numDia = partes[2];

    let isSelected = false;
    if (txModalSubtype === 'single') {
      isSelected = (f === currentAssigned);
    } else {
      isSelected = customDayNums.includes(numDia) || (customDayNums.length === 0 && f === currentAssigned);
    }

    return '<button type="button" onclick="selectTxDay_(\'' + f + '\')" class="day-pill ' + (isSelected ? 'active' : 'inactive') + '">' +
      '<span class="text-[11px] font-bold">' + nombreDia + '</span>' +
      '<span class="text-base font-black leading-tight">' + numDia + '</span>' +
      '</button>';
  }).join('');
}

function selectTxDay_(fechaISO) {
  const assignedInput = document.getElementById('tx-assigned-date');
  const customDaysInput = document.getElementById('tx-custom-days');
  const partes = fechaISO.split('-').map(Number);
  const numDia = partes[2];

  if (txModalSubtype === 'single') {
    if (assignedInput) assignedInput.value = fechaISO;
  } else {
    let currentNums = (customDaysInput && customDaysInput.value)
      ? customDaysInput.value.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
      : [];
    if (currentNums.includes(numDia)) {
      currentNums = currentNums.filter(n => n !== numDia);
    } else {
      currentNums.push(numDia);
    }
    currentNums.sort((a, b) => a - b);
    if (customDaysInput) customDaysInput.value = currentNums.join(', ');
    if (assignedInput && currentNums.length) {
      assignedInput.value = fechaISO;
    }
  }
  renderTxDaysCarousel_();
}

function setTxSubtype(tipo) {
  txModalSubtype = tipo;

  const tabSingle = document.getElementById('tab-single');
  const tabDivisible = document.getElementById('tab-divisible');
  if (tabSingle && tabDivisible) {
    if (tipo === 'single') {
      tabSingle.className = 'text-sm font-black text-white focus:outline-none pb-1 border-b-2 border-white';
      tabDivisible.className = 'text-sm font-normal text-white/70 hover:text-white focus:outline-none pb-1';
    } else {
      tabDivisible.className = 'text-sm font-black text-white focus:outline-none pb-1 border-b-2 border-white';
      tabSingle.className = 'text-sm font-normal text-white/70 hover:text-white focus:outline-none pb-1';
    }
  }

  const assignCont = document.getElementById('tx-assigned-date-container');
  if (assignCont) assignCont.classList.toggle('hidden', tipo === 'divisible');
  const divOpts = document.getElementById('divisible-options');
  if (divOpts) divOpts.classList.toggle('hidden', tipo !== 'divisible');
  if (tipo === 'divisible') {
    const chkBag = document.getElementById('chk-from-bag');
    if (chkBag) chkBag.checked = false;
    const fechaEl = document.getElementById('tx-assigned-date');
    if (fechaEl) fechaEl.removeAttribute('disabled');
  }
  renderTxDaysCarousel_();
}

function handleBagCheckbox(el) {
  const fechaEl = document.getElementById('tx-assigned-date');
  if (el.checked && txModalSubtype === 'divisible') {
    setTxSubtype('single');
    if (fechaEl) {
      fechaEl.value = hoyISO_();
      fechaEl.setAttribute('disabled', 'true');
    }
  } else if (!el.checked && fechaEl) {
    fechaEl.removeAttribute('disabled');
  }
}

function resetTxForm_() {
  isExplicitEditingTx_ = false;
  editingMovimientoId = null;

  const descEl = document.getElementById('tx-desc');
  if (descEl) {
    descEl.value = '';
    descEl.placeholder = 'Ej: Cena, Merienda';
  }
  const fechaEl = document.getElementById('tx-assigned-date');
  if (fechaEl) {
    fechaEl.removeAttribute('disabled');
    fechaEl.value = hoyISO_();
  }
  setMoneyValue('tx-amount', '');
  const chkBag = document.getElementById('chk-from-bag');
  if (chkBag) chkBag.checked = false;
  const daysCount = document.getElementById('tx-days-count');
  if (daysCount) daysCount.value = '';
  const divStart = document.getElementById('tx-divisible-start-date');
  if (divStart) divStart.value = '';
  const customDays = document.getElementById('tx-custom-days');
  if (customDays) customDays.value = '';
  setTxSubtype('single');

  const delBtn = document.getElementById('btn-delete-tx');
  if (delBtn) {
    delBtn.classList.add('hidden');
    delBtn.style.display = 'none';
    delBtn.setAttribute('disabled', 'true');
  }
  const saveLabel = document.getElementById('btn-save-tx-label');
  if (saveLabel) saveLabel.textContent = '+';
  actualizarBadgeUsuarioModal_(appState.activeUser);
}

function resetCurrentTabOnly() {
  resetTxForm_();
}

function toggleModal(show, movimientoId) {
  if (show) {
    if (movimientoId) {
      prepararTxModalEdicion_(movimientoId);
    } else {
      isExplicitEditingTx_ = false;
      resetTxForm_();
      actualizarBadgeUsuarioModal_(appState.activeUser);
    }
    const saveLabel = document.getElementById('btn-save-tx-label');
    if (saveLabel) saveLabel.textContent = '+';
    setMicroSubView('add');
  } else {
    isExplicitEditingTx_ = false;
    setMicroSubView('list');
  }
}

function prepararTxModalEdicion_(movimientoId) {
  const m = appState.movimientos.find(x => String(x.id).trim() === String(movimientoId).trim());
  if (!m) { resetTxForm_(); return; }
  isExplicitEditingTx_ = true;
  editingMovimientoId = m.id;
  actualizarBadgeUsuarioModal_(m.usuario);
  setTxSubtype(m.tipo);
  setMoneyValue('tx-amount', m.monto);
  const descEl = document.getElementById('tx-desc');
  if (descEl) descEl.value = m.descripcion || '';

  const fechas = normalizarFechas_(m.fechasAfectadas);
  const assignEl = document.getElementById('tx-assigned-date');
  if (assignEl) assignEl.value = fechas[0] || hoyISO_();

  if (m.tipo === 'divisible') {
    const daysCountEl = document.getElementById('tx-days-count');
    if (daysCountEl) daysCountEl.value = fechas.length || '';
    const divStartEl = document.getElementById('tx-divisible-start-date');
    if (divStartEl) divStartEl.value = fechas[0] || hoyISO_();
    const customDaysStr = fechas.map(f => {
      const p = f.split('-').map(Number);
      return p[2];
    }).join(', ');
    const customDaysEl = document.getElementById('tx-custom-days');
    if (customDaysEl) customDaysEl.value = customDaysStr;
  }

  const chkBag = document.getElementById('chk-from-bag');
  if (chkBag) chkBag.checked = !!m.fromBag;
  const delBtn = document.getElementById('btn-delete-tx');
  if (delBtn) {
    delBtn.classList.remove('hidden');
    delBtn.style.display = '';
    delBtn.removeAttribute('disabled');
  }
  renderTxDaysCarousel_();
}

async function handleFormSubmit() {
  const idToSave = editingMovimientoId;
  const existingMov = idToSave
    ? appState.movimientos.find(x => String(x.id).trim() === String(idToSave).trim())
    : null;
  const userToSave = existingMov && existingMov.usuario ? existingMov.usuario : appState.activeUser;
  const subtypeToSave = txModalSubtype;

  const monto = getMoneyValue('tx-amount');
  if (!monto || monto <= 0) { alert('Ingresá un monto válido'); return; }

  const descripcion = document.getElementById('tx-desc').value.trim();
  const fromBag = document.getElementById('chk-from-bag').checked;
  let fechasAfectadas = [];

  if (subtypeToSave === 'single') {
    const fecha = document.getElementById('tx-assigned-date').value || hoyISO_();
    fechasAfectadas = [fecha];
  } else {
    const diasCount = parseInt(document.getElementById('tx-days-count').value, 10);
    const fechaInicio = document.getElementById('tx-divisible-start-date').value;
    const customDaysRaw = document.getElementById('tx-custom-days').value.trim();

    if (customDaysRaw) {
      const base = fechaInicio ? new Date(fechaInicio + 'T00:00:00') : new Date();
      let currentMonth = base.getMonth();
      let currentYear = base.getFullYear();
      let lastDay = 0;

      fechasAfectadas = customDaysRaw.split(',')
        .map(s => parseInt(s.trim(), 10))
        .filter(dia => !isNaN(dia))
        .map(dia => {
          const enDiasRestantes = (appState.diasRestantes || []).find(fStr => {
            const p = fStr.split('-').map(Number);
            return p[2] === dia;
          });
          if (enDiasRestantes) {
            const p = enDiasRestantes.split('-').map(Number);
            lastDay = p[2];
            return enDiasRestantes;
          }

          if (dia < lastDay || (lastDay === 0 && dia < base.getDate())) {
            currentMonth++;
            if (currentMonth > 11) {
              currentMonth = 0;
              currentYear++;
            }
          }
          lastDay = dia;
          return formatearFechaISOLocal_(new Date(currentYear, currentMonth, dia));
        });
    } else if (diasCount && fechaInicio) {
      const base = new Date(fechaInicio + 'T00:00:00');
      for (let i = 0; i < diasCount; i++) {
        fechasAfectadas.push(formatearFechaISOLocal_(new Date(base.getFullYear(), base.getMonth(), base.getDate() + i)));
      }
    } else {
      fechasAfectadas = appState.diasRestantes.slice();
    }
  }

  if (!fechasAfectadas.length) { alert('Faltan fechas para este gasto'); return; }

  toggleModal(false);

  // Update Optimista
  const idMov = idToSave || ('tx_' + Date.now());
  const nuevoMov = {
    id: idMov,
    tipo: subtypeToSave,
    fechasAfectadas: fechasAfectadas,
    monto: monto,
    montoPorFecha: monto / fechasAfectadas.length,
    descripcion: descripcion,
    usuario: userToSave,
    fromBag: fromBag
  };

  const idx = appState.movimientos.findIndex(x => String(x.id) === String(idMov));
  if (idx !== -1) {
    const movAnterior = appState.movimientos[idx];
    appState.homeBankingTotal += movAnterior.monto;
    if (movAnterior.fromBag) appState.bolsaTotal += movAnterior.monto;
    appState.movimientos[idx] = nuevoMov;
  } else {
    appState.movimientos.push(nuevoMov);
  }

  ++diarioLoadToken_;
  appState.homeBankingTotal -= monto;
  if (fromBag) appState.bolsaTotal -= monto;

  guardarCacheDiarioLocal_();
  renderMicroView();

  const disponibleHoyTexto = formatearMoneda_(presupuestoParaFecha_(hoyISO_()));

  callBackendBackground('guardarMovimiento', {
    id: idToSave,
    tipo: subtypeToSave,
    fechasAfectadas: fechasAfectadas,
    monto: monto,
    descripcion: descripcion,
    usuario: userToSave,
    fromBag: fromBag,
    disponibleHoyTexto: disponibleHoyTexto
  }).then(() => recargarEstadoDiario_(false));
}

async function deleteCurrentEditingTransaction() {
  const idToDelete = editingMovimientoId;
  if (!idToDelete) return;
  toggleModal(false);

  const movExistente = appState.movimientos.find(x => String(x.id) === String(idToDelete));
  if (movExistente) {
    ++diarioLoadToken_;
    appState.homeBankingTotal += movExistente.monto;
    if (movExistente.fromBag) appState.bolsaTotal += movExistente.monto;
    appState.movimientos = appState.movimientos.filter(x => String(x.id) !== String(idToDelete));
    guardarCacheDiarioLocal_();
    renderMicroView();
  }

  callBackendBackground('eliminarMovimiento', { id: idToDelete })
    .then(() => recargarEstadoDiario_(false));
}

// ============================================================
// AUDITORÍA Y FUTUROS DÍAS (DIARIO)
// ============================================================

async function triggerSyncReload() {
  mostrarSyncToast_();
  try {
    await recargarEstadoDiario_(false);
  } catch (e) {
    alert('Error de sincronización');
  } finally {
    ocultarSyncToast_();
  }
}

function openBudgetAuditModal(targetDay) {
  const fecha = targetDay === 'tomorrow' ? formatearFechaISOLocal_(sumarDiasLocal_(new Date(), 1)) : hoyISO_();
  const comp = calcularComposicion_();
  const gastoDelDia = comp.gastosPorFecha[fecha] || 0;
  const disponible = comp.objetivoBase - gastoDelDia;

  const auditTitle = document.getElementById('audit-title');
  const auditSubtitle = document.getElementById('audit-subtitle');
  if (auditTitle) auditTitle.textContent = targetDay === 'tomorrow' ? 'Detalle de Mañana' : 'Detalle de Hoy';
  if (auditSubtitle) auditSubtitle.textContent = formatearFechaLegible_(fecha);

  const movimientosDelDia = appState.movimientos.filter(m => {
    if (m.fromBag) return false;
    const fechas = normalizarFechas_(m.fechasAfectadas);
    return fechas.includes(fecha);
  });

  let html = '<div class="flex justify-between items-baseline py-2 border-b border-white/20">' +
    '<span class="text-base font-bold text-white">Presupuesto base:</span>' +
    '<span class="text-base font-bold text-white">' + formatearMoneda_(comp.objetivoBase) + '</span></div>';

  if (movimientosDelDia.length) {
    html += movimientosDelDia.map(m => {
      const badge = resolverBadgeUsuario_(m.usuario);
      return '<div class="flex justify-between items-baseline py-2.5 border-b border-white/10 cursor-pointer hover:opacity-90 transition-opacity" onclick="toggleBudgetAuditModal(false); toggleModal(true, \'' + m.id + '\')">' +
        '<div>' +
        '<p class="text-sm font-bold text-[#d31818]">' + (m.descripcion || (m.tipo === 'divisible' ? 'Gasto divisible' : 'Gasto único')) + ': -' + formatearMoneda_(m.montoPorFecha) + '</p>' +
        '<p class="text-[11px] text-white/80 mt-1 flex items-center gap-1.5">' +
        '<span class="inline-flex w-4 h-4 rounded-full bg-white font-avatar font-bold text-[10px] items-center justify-center shrink-0" style="color: ' + badge.color + ';">' + badge.letter + '</span>' +
        '<span>' + badge.user + '</span></p>' +
        '</div></div>';
    }).join('');
  } else {
    html += '<p class="text-xs text-white/60 text-center py-4">Sin gastos cargados para este día</p>';
  }

  const contentList = document.getElementById('audit-content-list');
  const totalDisplay = document.getElementById('audit-total-display');
  if (contentList) contentList.innerHTML = html;
  if (totalDisplay) totalDisplay.textContent = formatearMoneda_(disponible);

  toggleBudgetAuditModal(true);
}

function toggleBudgetAuditModal(show) {
  const modalEl = document.getElementById('budget-audit-modal');
  const dash = document.getElementById('micro-dashboard-view');
  if (show) {
    cerrarSubvistasTarjetaExcepto_('budget-audit-modal');
    if (dash) dash.classList.add('hidden');
    if (modalEl) {
      modalEl.classList.remove('hidden');
      modalEl.classList.add('flex', 'active');
    }
    autoFitCircleButtons();
    pushModalHistory_('budget-audit-modal');
  } else {
    if (modalEl) {
      modalEl.classList.add('hidden');
      modalEl.classList.remove('flex', 'active');
    }
    if (dash) dash.classList.remove('hidden');
  }
}

function toggleFutureDaysModal(show) {
  const modalEl = document.getElementById('future-days-modal');
  const dash = document.getElementById('micro-dashboard-view');
  if (show) {
    cerrarSubvistasTarjetaExcepto_('future-days-modal');
    renderFutureDaysList_();
    if (dash) dash.classList.add('hidden');
    if (modalEl) {
      modalEl.classList.remove('hidden');
      modalEl.classList.add('flex', 'active');
    }
    autoFitCircleButtons();
    pushModalHistory_('future-days-modal');
  } else {
    if (modalEl) {
      modalEl.classList.add('hidden');
      modalEl.classList.remove('flex', 'active');
    }
    if (dash) dash.classList.remove('hidden');
  }
}

function renderFutureDaysList_() {
  const cont = document.getElementById('future-days-list');
  if (!cont) return;
  const comp = calcularComposicion_();
  const hoyStr = hoyISO_();
  const futuros = appState.diasRestantes.filter(f => f > hoyStr);

  if (!futuros.length) {
    cont.innerHTML = '<p class="text-xs text-white/60 text-center py-4">No quedan más días en este período</p>';
    return;
  }

  cont.innerHTML = futuros.map(fecha => {
    const gasto = comp.gastosPorFecha[fecha] || 0;
    const disponible = comp.objetivoBase - gasto;
    const movs = appState.movimientos.filter(m => {
      if (m.fromBag) return false;
      const fechas = normalizarFechas_(m.fechasAfectadas);
      return fechas.includes(fecha);
    });

    let detalle = '';
    if (movs.length) {
      detalle = '<div class="mt-1 space-y-1">' +
        movs.map(m => '<button onclick="event.stopPropagation(); toggleFutureDaysModal(false); toggleModal(true, \'' + m.id + '\')" class="w-full flex justify-between text-xs text-white/80 hover:text-white p-1 rounded transition-colors text-left">' +
          '<span>• ' + (m.descripcion || 'Gasto') + '</span><span class="font-bold text-[#d31818]">-' + formatearMoneda_(m.montoPorFecha) + '</span></button>').join('') +
        '</div>';
    }

    return '<div class="py-2.5 border-b border-white/15">' +
      '<div class="flex justify-between items-baseline">' +
      '<div><span class="font-bold text-white text-sm block capitalize">' + formatearFechaLegible_(fecha) + '</span>' +
      '<span class="text-[11px] text-white/70">' + (gasto > 0 ? ('Gastados: ' + formatearMoneda_(gasto)) : 'Sin consumos asignados') + '</span></div>' +
      '<span class="font-bold text-base text-white">' + formatearMoneda_(disponible) + '</span></div>' + detalle + '</div>';
  }).join('');
}

// ============================================================
// NAVEGACIÓN ANCLADA A ESTADOS DE PANTALLA (DEFINITIVA)
// ============================================================

let exitToastTimeout = null;
let lastBackPressTime = 0;

function showExitToast_() {
  const toast = document.getElementById('exit-toast');
  if (!toast) return;
  toast.textContent = 'Presioná dos veces seguidas para salir';
  toast.style.backgroundColor = 'rgba(39, 39, 42, 0.95)';
  toast.classList.add('active');
  if (exitToastTimeout) clearTimeout(exitToastTimeout);
  exitToastTimeout = setTimeout(() => {
    toast.classList.remove('active');
  }, 2000);
}

function closeAllActiveModalsWithoutSaving_() {
  toggleHbModal(false);
  toggleBudgetAuditModal(false);
  toggleFutureDaysModal(false);
  setMicroSubView('list', false);

  // Destrucción obligatoria de estado en formularios (Zero-Draft Persistence)
  resetTxForm_();

  const activeModals = document.querySelectorAll('.modal-overlay.active, .modal.active');
  activeModals.forEach(m => m.classList.remove('active'));

  const microDash = document.getElementById('micro-dashboard-view');
  if (microDash) microDash.classList.remove('hidden');
}

function closeAllActiveModals_() {
  closeAllActiveModalsWithoutSaving_();
}

function pushModalHistory_(modalId) {
  try {
    history.pushState({ subview: modalId || 'subview' }, '');
  } catch (e) {}
}

// Helper: Determina el identificador de la pantalla visible ACTUAL
function getCurrentScreenState() {
  const activeModal = document.querySelector('.modal-overlay.active, .modal.active');
  if (activeModal) return 'MODAL';

  const hbModal = document.getElementById('hb-modal');
  if (hbModal && !hbModal.classList.contains('hidden')) return 'MICRO_HB';

  const auditModal = document.getElementById('budget-audit-modal');
  if (auditModal && !auditModal.classList.contains('hidden')) return 'MICRO_AUDIT';

  const futureModal = document.getElementById('future-days-modal');
  if (futureModal && !futureModal.classList.contains('hidden')) return 'MICRO_FUTURE_DAYS';

  const panelAdd = document.getElementById('micro-panel-add');
  if (panelAdd && !panelAdd.classList.contains('hidden')) return 'MICRO_REGISTER';

  return 'MICRO_HOME';
}

function initAndroidBackHistory_() {
  // Sombra doble de protección inicial al abrir la app desde cero
  try {
    history.pushState({ page: 'home_root' }, '');
    history.pushState({ page: 'home_guard' }, '');
  } catch (e) {}

  window.addEventListener('popstate', (e) => {
    const current = getCurrentScreenState();

    if (current === 'MICRO_HOME') {
      const now = Date.now();
      // Si el usuario presiona Back dos veces seguidas en menos de 2000 ms en la Home
      if (lastBackPressTime > 0 && (now - lastBackPressTime < 2000)) {
        lastBackPressTime = 0;
        if (navigator.app && navigator.app.exitApp) {
          navigator.app.exitApp();
        } else if (window.App && window.App.exitApp) {
          window.App.exitApp();
        } else if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
          window.Capacitor.Plugins.App.exitApp();
        } else {
          history.back();
        }
        return;
      }
      
      // Primer toque en Home
      lastBackPressTime = now;
      showExitToast_();
      
      // Mantiene sembrado el freno de mano
      try {
        history.pushState({ page: 'home_guard' }, '');
      } catch (err) {}
    } else {
      // Si estaba en una subvista o modal, se cierra limpiamente la subvista
      lastBackPressTime = 0;
      closeAllActiveModalsWithoutSaving_();
    }
  });

  // Escucha de Evento backbutton de Hardware (Android / Cordova / APK / Capacitor)
  document.addEventListener('backbutton', (e) => {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    const current = getCurrentScreenState();
    if (current === 'MICRO_HOME') {
      const now = Date.now();
      if (lastBackPressTime > 0 && (now - lastBackPressTime < 2000)) {
        lastBackPressTime = 0;
        if (navigator.app && navigator.app.exitApp) {
          navigator.app.exitApp();
        } else if (window.App && window.App.exitApp) {
          window.App.exitApp();
        } else if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
          window.Capacitor.Plugins.App.exitApp();
        } else {
          history.back();
        }
        return;
      }
      lastBackPressTime = now;
      showExitToast_();
    } else {
      lastBackPressTime = 0;
      closeAllActiveModalsWithoutSaving_();
    }
  }, false);

  // Compatibilidad con Capacitor App Plugin
  if (typeof window !== 'undefined' && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
    try {
      window.Capacitor.Plugins.App.addListener('backButton', () => {
        const current = getCurrentScreenState();
        if (current === 'MICRO_HOME') {
          const now = Date.now();
          if (lastBackPressTime > 0 && (now - lastBackPressTime < 2000)) {
            if (window.Capacitor.Plugins.App.exitApp) {
              window.Capacitor.Plugins.App.exitApp();
            }
            return;
          }
          lastBackPressTime = now;
          showExitToast_();
        } else {
          lastBackPressTime = 0;
          closeAllActiveModalsWithoutSaving_();
        }
      });
    } catch (err) {
      console.warn('Error inicializando Capacitor backButton listener:', err);
    }
  }
}

function isAnyCardSubviewOrModalActive_() {
  if (document.querySelector('.modal-overlay.active, .modal.active')) return true;

  const hb = document.getElementById('hb-modal');
  if (hb && !hb.classList.contains('hidden')) return true;
  const audit = document.getElementById('budget-audit-modal');
  if (audit && !audit.classList.contains('hidden')) return true;
  const fut = document.getElementById('future-days-modal');
  if (fut && !fut.classList.contains('hidden')) return true;

  return false;
}

function initHorizontalSwipeGesture_() {
  const viewport = document.getElementById('app-viewport') || document.body;
  let touchStartX = 0;
  let touchStartY = 0;
  let touchStartTime = 0;
  let isValidSwipeStart = false;

  viewport.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) {
      isValidSwipeStart = false;
      return;
    }
    const t = e.touches[0];
    const clientX = t.clientX;
    const clientY = t.clientY;

    // Margen de seguridad: ignorar toques menores a 30px del borde
    if (clientX < 30 || clientX > window.innerWidth - 30) {
      isValidSwipeStart = false;
      return;
    }

    // Si hay un modal o subvista activa, ignorar swipe
    if (isAnyCardSubviewOrModalActive_()) {
      isValidSwipeStart = false;
      return;
    }

    // Ignorar si el toque inició en inputs, select, botones, o carruseles horizontales
    const target = document.elementFromPoint(clientX, clientY);
    if (target && target.closest('#tx-days-carousel, input, select, textarea, button')) {
      isValidSwipeStart = false;
      return;
    }

    touchStartX = clientX;
    touchStartY = clientY;
    touchStartTime = Date.now();
    isValidSwipeStart = true;
  }, { passive: true });

  viewport.addEventListener('touchend', (e) => {
    if (!isValidSwipeStart || e.changedTouches.length !== 1) return;
    isValidSwipeStart = false;

    if (isAnyCardSubviewOrModalActive_()) return;

    const t = e.changedTouches[0];
    const deltaX = t.clientX - touchStartX;
    const deltaY = t.clientY - touchStartY;
    const time = Date.now() - touchStartTime;

    // Umbral mínimo y predominancia horizontal
    if (time > 600) return;
    if (Math.abs(deltaX) < 60) return;
    if (Math.abs(deltaX) <= Math.abs(deltaY) * 1.5) return;

    const panelAdd = document.getElementById('micro-panel-add');
    const isAddOpen = panelAdd && !panelAdd.classList.contains('hidden');

    if (!isAddOpen) {
      if (deltaX < -60) {
        setMicroSubView('add', true);
        setTxSubtype('single');
      }
    } else if (txModalSubtype === 'single') {
      if (deltaX > 60) {
        setMicroSubView('list', true);
      } else if (deltaX < -60) {
        setTxSubtype('divisible');
      }
    } else if (txModalSubtype === 'divisible') {
      if (deltaX > 60) {
        setTxSubtype('single');
      }
    }
  }, { passive: true });
}

/** Mantiene la barra de botones circulares flotantes visible dentro del viewport activo (scroll, marco desktop o teclado móvil). */
function updateFloatingCircleButtonsPosition() {
  const bars = document.querySelectorAll('.floating-actions-bar');
  if (!bars.length) return;

  const vv = window.visualViewport;
  const vvBottom = vv ? (vv.offsetTop + vv.height) : window.innerHeight;
  const appViewport = document.getElementById('app-viewport');
  const appRect = appViewport ? appViewport.getBoundingClientRect() : null;

  let visibleBottom = Math.min(window.innerHeight, vvBottom);
  if (appRect) {
    visibleBottom = Math.min(visibleBottom, appRect.bottom);
    visibleBottom = Math.max(visibleBottom, appRect.top + 88);
  }

  const bottomOffset = Math.max(20, Math.round(window.innerHeight - visibleBottom + 20));
  const bottomValue = bottomOffset <= 20
    ? 'calc(20px + env(safe-area-inset-bottom, 0px))'
    : `${bottomOffset}px`;

  bars.forEach(bar => {
    bar.style.bottom = bottomValue;
  });
}

function autoFitCircleButtons() {
  updateFloatingCircleButtonsPosition();
  setTimeout(() => {
    requestAnimationFrame(() => {
      updateFloatingCircleButtonsPosition();
      document.querySelectorAll('.btn-circle').forEach(btn => {
        if (btn.classList.contains('hidden') || btn.style.display === 'none' || btn.getClientRects().length === 0) {
          return;
        }
        // Ignorar íconos SVG o botones con signo '+' (ej: agregar movimiento, FAB, etc.)
        if (btn.querySelector('svg')) return;
        const text = btn.innerText ? btn.innerText.trim() : '';
        if (!text || text === '+' || text === '×' || text === '<' || text === '>' || text.includes('+')) {
          return;
        }

        btn.style.padding = '2px';
        btn.style.whiteSpace = 'nowrap';
        btn.style.overflow = 'hidden';
        btn.style.display = 'inline-flex';
        btn.style.alignItems = 'center';
        btn.style.justifyContent = 'center';
        btn.style.lineHeight = '1.1';
        btn.style.fontWeight = '700';
        btn.style.boxSizing = 'border-box';

        const isSm = btn.classList.contains('btn-circle-sm');
        const diameter = btn.clientWidth || (isSm ? 50 : 58);

        // Ancho y alto seguro dentro de la circunferencia para máxima legibilidad
        const safeWidth = Math.floor(diameter * 0.86);
        const safeHeight = Math.floor(diameter * 0.76);

        // Para botones pequeños (.btn-circle-sm), inicia en 11.5px y desciende hasta un mínimo de 8.5px
        // Para botones estándar (.btn-circle), inicia en 13px y desciende hasta un mínimo de 9.5px
        let size = isSm ? 11.5 : 13;
        const minSize = isSm ? 8.5 : 9.5;
        btn.style.fontSize = size + 'px';

        while ((btn.scrollWidth > safeWidth || btn.scrollHeight > safeHeight) && size > minSize) {
          size -= 0.5;
          btn.style.fontSize = size + 'px';
        }
      });
    });
  }, 40);
}

// ============================================================
// CARGA DE ESTADO Y BOOTSTRAP
// ============================================================

let diarioLoadToken_ = 0;

function cargarCacheDiarioLocal_() {
  const cached = localStorage.getItem('cached_diario_state');
  if (!cached) return false;
  const parsed = JSON.parse(cached);
  if (!parsed || typeof parsed !== 'object') return false;
  if (parsed.homeBankingTotal !== undefined) appState.homeBankingTotal = parsed.homeBankingTotal;
  if (parsed.bolsaTotal !== undefined) appState.bolsaTotal = parsed.bolsaTotal;
  if (parsed.diaCobro !== undefined) appState.diaCobro = parsed.diaCobro;
  if (Array.isArray(parsed.diasRestantes)) appState.diasRestantes = parsed.diasRestantes;
  if (Array.isArray(parsed.movimientos)) appState.movimientos = parsed.movimientos;
  if (parsed.lastProcessedDate !== undefined) appState.lastProcessedDate = parsed.lastProcessedDate;
  if (parsed.ultimaNotificacion !== undefined) appState.ultimaNotificacion = parsed.ultimaNotificacion;
  if (parsed.ultimoMensaje !== undefined) appState.ultimoMensaje = parsed.ultimoMensaje;
  if (parsed.onesignalAppId !== undefined) appState.onesignalAppId = parsed.onesignalAppId;
  return true;
}

function aplicarEstadoDiario_(data) {
  if (!data) return;
  appState.homeBankingTotal = data.homeBankingTotal;
  appState.bolsaTotal = data.bolsaTotal;
  appState.diaCobro = data.diaCobro;
  appState.diasRestantes = data.diasRestantes;
  appState.movimientos = (data.movimientos || []).map(m => {
    m.fechasAfectadas = normalizarFechas_(m.fechasAfectadas);
    return m;
  });
  appState.lastProcessedDate = normalizarFechaConfig_(data.lastProcessedDate, hoyISO_());
  appState.ultimaNotificacion = data.ultimaNotificacion || null;
  appState.ultimoMensaje = data.ultimoMensaje || null;
  appState.onesignalAppId = String(data.onesignalAppId || '').trim();
  guardarCacheDiarioLocal_();
  renderMicroView();
  refrescarVistaHbModalSiAbierto_();
  if (appState.onesignalAppId) initOneSignalPush_(appState.onesignalAppId);
  chequearMensajeRecibido_(appState.ultimoMensaje);
  chequearNotificacionEntrante_(appState.ultimaNotificacion);
  actualizarIndicadorMensajes_();
}

async function recargarEstadoDiario_(conToast) {
  if (pendingSyncCount > 0 || getPendingSyncQueue_().length > 0) return;
  const miToken = ++diarioLoadToken_;
  try {
    if (!appState.lastProcessedDate && miToken === diarioLoadToken_ && cargarCacheDiarioLocal_()) {
      renderMicroView();
    }
  } catch (e) {}

  try {
    const data = conToast === false ? await callBackend('getEstadoDiario', {}) : await callBackendConSync('getEstadoDiario', {});
    if (miToken !== diarioLoadToken_ || pendingSyncCount > 0 || getPendingSyncQueue_().length > 0) return;
    aplicarEstadoDiario_(data);
  } catch (err) {
    if (miToken === diarioLoadToken_) {
      console.error('Error al recargar estado diario:', err);
    }
  }
}

async function bootstrapEstado_() {
  const miToken = ++diarioLoadToken_;
  try {
    if (miToken === diarioLoadToken_ && cargarCacheDiarioLocal_()) {
      renderMicroView();
    }
  } catch (e) {}

  try {
    const data = await callBackendConSync('getEstadoDiario', {});
    if (miToken !== diarioLoadToken_) return;
    aplicarEstadoDiario_(data);

    try {
      await chequearCierreDia_();
    } catch (e) {
      console.error('Error al chequear el cierre de día:', e);
    }
  } catch (err) {
    if (miToken === diarioLoadToken_) {
      console.error('Error en bootstrapEstado_:', err);
    }
  }

  // Procesar cualquier sincronización pendiente almacenada en cola
  processPendingSyncQueue_();
}

window.diagnosticarBackend = async function() {
  console.log('--- DIAGNÓSTICO DE CONEXIÓN CON GOOGLE APPS SCRIPT ---');
  try {
    const diario = await callBackendConSync('getEstadoDiario', {});
    console.log('✅ getEstadoDiario OK:', diario);
    showAppToast('Conexión con la base de datos OK ✅');
    return { ok: true, diario };
  } catch (err) {
    console.error('❌ Error en diagnóstico:', err);
    showAppToast('Error de conexión: ' + err.message, true);
    return { ok: false, error: err.message };
  }
};

// ============================================================
// FUNCIÓN DE RESPALDO Y EXPORTACIÓN DE ESTADO
// ============================================================
window.exportarRespaldoEstado = function() {
  const respaldo = {
    version: 'multimillonarios-diario',
    exportDate: new Date().toISOString(),
    appState: appState,
    cachedDiarioState: null,
    configLocal: {
      activeUser: appState.activeUser
    },
    localStorage: {}
  };

  try {
    const cachedDiario = localStorage.getItem('cached_diario_state');
    if (cachedDiario) {
      respaldo.cachedDiarioState = JSON.parse(cachedDiario);
    }
  } catch (e) {
    respaldo.cachedDiarioState = localStorage.getItem('cached_diario_state');
  }

  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key) {
        try {
          respaldo.localStorage[key] = JSON.parse(localStorage.getItem(key));
        } catch (e) {
          respaldo.localStorage[key] = localStorage.getItem(key);
        }
      }
    }
  } catch (e) {
    console.warn('Error al recolectar localStorage para respaldo:', e);
  }

  try {
    const jsonStr = JSON.stringify(respaldo, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const fechaStr = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `multimillonarios_backup_${fechaStr}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 500);
  } catch (err) {
    console.error('Error al generar archivo descargable de respaldo:', err);
  }

  return respaldo;
};

// ============================================================
// MENSAJES Y NOTIFICACIONES DE PAREJA
// ============================================================

function getOtroUsuario_(usuario) {
  return usuario === 'Virginia' ? 'Brian' : 'Virginia';
}

function getLastReceivedMsgStorageKey_(usuario) {
  return 'lastMsgPara_' + usuario;
}

function getLastOpenedMsgStorageKey_(usuario) {
  return 'lastOpenedMsgId_' + usuario;
}

function getLastSeenNotifStorageKey_(usuario) {
  return 'lastSeenNotifId_' + usuario;
}

function leerMensajeGuardadoParaUsuario_(usuario) {
  const ultimo = appState.ultimoMensaje;
  if (ultimo && ultimo.id && (!ultimo.para || ultimo.para === usuario) && ultimo.de !== usuario) {
    return ultimo;
  }
  try {
    const raw = localStorage.getItem(getLastReceivedMsgStorageKey_(usuario));
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function chequearMensajeRecibido_(msg) {
  if (!msg || !msg.id) return;
  if (msg.para && msg.para !== appState.activeUser) return;
  if (msg.de === appState.activeUser) return;
  try {
    localStorage.setItem(getLastReceivedMsgStorageKey_(appState.activeUser), JSON.stringify(msg));
  } catch (e) {}
  const modal = document.getElementById('message-modal');
  if (modal && modal.classList.contains('active')) {
    renderReceivedMessageBox_();
    try {
      localStorage.setItem(getLastOpenedMsgStorageKey_(appState.activeUser), msg.id);
    } catch (e) {}
  }
}

function actualizarIndicadorMensajes_() {
  const dot = document.getElementById('msg-unread-dot');
  if (!dot) return;
  const msg = leerMensajeGuardadoParaUsuario_(appState.activeUser);
  const openedId = localStorage.getItem(getLastOpenedMsgStorageKey_(appState.activeUser)) || '';
  const modal = document.getElementById('message-modal');
  const modalAbierto = !!(modal && modal.classList.contains('active'));
  if (!modalAbierto && msg && msg.id && msg.id !== openedId) {
    dot.classList.remove('hidden');
  } else {
    dot.classList.add('hidden');
  }
}

function formatearHoraCorta_(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    return '';
  }
}

function renderReceivedMessageBox_() {
  const box = document.getElementById('msg-received-box');
  if (!box) return;
  const msg = leerMensajeGuardadoParaUsuario_(appState.activeUser);
  if (!msg || !msg.cuerpo) {
    box.classList.add('hidden');
    return;
  }
  const fromEl = document.getElementById('msg-received-from');
  const timeEl = document.getElementById('msg-received-time');
  const textEl = document.getElementById('msg-received-text');
  if (fromEl) fromEl.textContent = 'Último mensaje de ' + (msg.de || getOtroUsuario_(appState.activeUser));
  if (timeEl) timeEl.textContent = formatearHoraCorta_(msg.creadoEn);
  if (textEl) textEl.textContent = msg.cuerpo;
  box.classList.remove('hidden');
}

function openMessageModal() {
  const modal = document.getElementById('message-modal');
  if (!modal) return;
  const titleEl = document.getElementById('msg-modal-title');
  const para = getOtroUsuario_(appState.activeUser);
  if (titleEl) titleEl.textContent = '💌 Mensajito para ' + para;

  renderReceivedMessageBox_();
  const msg = leerMensajeGuardadoParaUsuario_(appState.activeUser);
  if (msg && msg.id) {
    try {
      localStorage.setItem(getLastOpenedMsgStorageKey_(appState.activeUser), msg.id);
    } catch (e) {}
  }

  actualizarIndicadorMensajes_();
  actualizarEstadoPermisoNotificaciones_();
  cerrarBannerNotificacion();

  modal.classList.add('active');
  pushModalHistory_('message-modal');
}

function closeMessageModal() {
  const modal = document.getElementById('message-modal');
  if (modal) modal.classList.remove('active');
}

function seleccionarMensajeRapido(idx) {
  const texto = PRESET_COUPLE_MESSAGES[idx];
  const input = document.getElementById('msg-custom-input');
  if (!texto || !input) return;
  input.value = texto;
  input.focus();
}

function enviarMensajeRapido(idx) {
  seleccionarMensajeRapido(idx);
  return enviarMensajePareja();
}

function insertEmoji(emoji) {
  const input = document.getElementById('msg-custom-input');
  if (!input || !emoji) return;
  const start = typeof input.selectionStart === 'number' ? input.selectionStart : input.value.length;
  const end = typeof input.selectionEnd === 'number' ? input.selectionEnd : input.value.length;
  const before = input.value.slice(0, start);
  const after = input.value.slice(end);
  input.value = before + emoji + after;
  const nextPos = start + emoji.length;
  input.focus();
  if (typeof input.setSelectionRange === 'function') {
    input.setSelectionRange(nextPos, nextPos);
  }
}

async function enviarMensajePareja() {
  const input = document.getElementById('msg-custom-input');
  const btn = document.getElementById('btn-send-msg');
  const texto = input ? input.value.trim() : '';
  if (!texto) {
    if (input) input.focus();
    showAppToast('Escribí o elegí un mensajito primero', true);
    return;
  }

  const de = appState.activeUser;
  const para = getOtroUsuario_(de);
  const payload = { texto: texto, de: de, para: para };

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    callBackendBackground('enviarMensaje', payload);
    if (input) input.value = '';
    closeMessageModal();
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Enviando...';
  }

  try {
    const res = await callBackend('enviarMensaje', payload);
    if (res && res.notif) {
      appState.ultimaNotificacion = res.notif;
      appState.ultimoMensaje = res.notif;
      try {
        localStorage.setItem(getLastSeenNotifStorageKey_(de), res.notif.id);
      } catch (e) {}
      guardarCacheDiarioLocal_();
    }
    if (input) input.value = '';
    closeMessageModal();
    showAppToast('💌 Mensajito enviado a ' + para);
  } catch (err) {
    if (isNetworkOrTimeoutError_(err)) {
      callBackendBackground('enviarMensaje', payload);
      if (input) input.value = '';
      closeMessageModal();
    } else {
      showAppToast(err && err.message ? err.message : 'No se pudo enviar el mensaje', true);
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Enviar mensaje 💌';
    }
  }
}

function actualizarEstadoPermisoNotificaciones_() {
  const statusEl = document.getElementById('msg-notif-status');
  const btnEl = document.getElementById('btn-enable-notifications');
  if (!statusEl || !btnEl) return;

  if (typeof Notification === 'undefined') {
    statusEl.textContent = 'ℹ️ Abrí la app desde Chrome o instálala en el teléfono para recibir avisos.';
    btnEl.textContent = '🔔 Probar aviso visual';
    return;
  }

  const perm = Notification.permission;
  if (perm === 'granted') {
    statusEl.textContent = appState.onesignalAppId
      ? '✅ Notificaciones y push en segundo plano activos.'
      : '✅ Notificaciones del sistema activas en este teléfono.';
    btnEl.textContent = '🔔 Probar notificación en este teléfono';
  } else if (perm === 'denied') {
    statusEl.textContent = '⚠️ Permiso bloqueado: habilitá notificaciones en la configuración del navegador.';
    btnEl.textContent = '🔔 Reintentar permiso de notificaciones';
  } else {
    statusEl.textContent = '🔕 Tocá el botón para activar sonido, vibración y notificaciones.';
    btnEl.textContent = '🔔 Activar notificaciones en este teléfono';
  }
}

async function activarNotificacionesDispositivo() {
  if (typeof Notification === 'undefined') {
    reproducirSonidoNotificacion_();
    mostrarBannerNotificacion_({
      tipo: 'mensaje',
      titulo: '💌 Avisos dentro de la app activos',
      cuerpo: 'Este navegador no soporta notificaciones nativas fuera de la app.'
    });
    return;
  }

  let perm = Notification.permission;
  if (perm === 'denied') {
    actualizarEstadoPermisoNotificaciones_();
    showAppToast('Habilitá las notificaciones en Ajustes del navegador', true);
    return;
  }

  if (perm !== 'granted') {
    perm = await Notification.requestPermission();
  }

  actualizarEstadoPermisoNotificaciones_();

  if (perm === 'granted') {
    sincronizarUsuarioPush_(appState.activeUser, true);
    reproducirSonidoNotificacion_();
    await mostrarNotificacionNativa_(
      '🔔 Notificaciones activadas',
      'Ya vas a recibir mensajitos y gastos de ' + getOtroUsuario_(appState.activeUser),
      'notif-test'
    );
    showAppToast('🔔 Notificaciones activadas');
  } else {
    showAppToast('No se activaron las notificaciones', true);
  }
}

function initOneSignalPush_(appId) {
  if (!appId || onesignalInitializedAppId_ === appId || typeof window === 'undefined') return;
  onesignalInitializedAppId_ = appId;
  let workerScope = './push/onesignal/';
  try {
    workerScope = new URL('push/onesignal/', window.location.href).pathname;
  } catch (e) {}

  window.OneSignalDeferred = window.OneSignalDeferred || [];
  window.OneSignalDeferred.push(async function(OneSignal) {
    try {
      await OneSignal.init({
        appId: appId,
        allowLocalhostAsSecureOrigin: true,
        serviceWorkerPath: 'push/onesignal/OneSignalSDKWorker.js',
        serviceWorkerParam: { scope: workerScope }
      });
      if (OneSignal.User && OneSignal.User.PushSubscription && typeof OneSignal.User.PushSubscription.addEventListener === 'function') {
        OneSignal.User.PushSubscription.addEventListener('change', () => {
          guardarPushSubscriptionBackend_(appState.activeUser, OneSignal);
        });
      }
      await sincronizarUsuarioPush_(appState.activeUser, false);
    } catch (err) {
      console.warn('Error inicializando OneSignal:', err);
    }
  });
}

function sincronizarUsuarioPush_(user, optInIfNeeded) {
  if (!appState.onesignalAppId || typeof window === 'undefined' || !window.OneSignalDeferred) return;
  window.OneSignalDeferred.push(async function(OneSignal) {
    try {
      if (typeof OneSignal.login === 'function') {
        await OneSignal.login(user);
      }
      if (optInIfNeeded && OneSignal.User && OneSignal.User.PushSubscription && typeof OneSignal.User.PushSubscription.optIn === 'function') {
        await OneSignal.User.PushSubscription.optIn();
      }
      await guardarPushSubscriptionBackend_(user, OneSignal);
    } catch (e) {}
  });
}

async function guardarPushSubscriptionBackend_(user, OneSignal) {
  try {
    const subId = OneSignal && OneSignal.User && OneSignal.User.PushSubscription
      ? String(OneSignal.User.PushSubscription.id || '').trim()
      : '';
    if (!subId) return;
    const sentKey = 'pushSubSent_' + user;
    if (localStorage.getItem(sentKey) === subId) return;
    await callBackend('registrarPushSub', { usuario: user, subscriptionId: subId });
    localStorage.setItem(sentKey, subId);
  } catch (e) {}
}

function reproducirSonidoNotificacion_() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const ahora = ctx.currentTime;
    const notas = [659.25, 880];
    notas.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, ahora + i * 0.14);
      gain.gain.setValueAtTime(0.001, ahora + i * 0.14);
      gain.gain.exponentialRampToValueAtTime(0.14, ahora + i * 0.14 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, ahora + i * 0.14 + 0.28);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ahora + i * 0.14);
      osc.stop(ahora + i * 0.14 + 0.3);
    });
    setTimeout(() => { try { ctx.close(); } catch (e) {} }, 800);
  } catch (e) {}
}

async function mostrarNotificacionNativa_(titulo, cuerpo, tag) {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate([200, 100, 200, 100, 300]);
    }
  } catch (e) {}

  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;

  const opts = {
    body: cuerpo || '',
    icon: './icon-192.png',
    badge: './icon-192.png',
    vibrate: [200, 100, 200, 100, 300],
    tag: tag || 'multimillonarios-msg',
    renotify: true
  };

  try {
    if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
      const reg = (await navigator.serviceWorker.getRegistration()) || (await navigator.serviceWorker.ready);
      if (reg && typeof reg.showNotification === 'function') {
        await reg.showNotification(titulo, opts);
        return true;
      }
    }
  } catch (e) {}

  try {
    new Notification(titulo, opts);
    return true;
  } catch (e) {
    return false;
  }
}

function cerrarBannerNotificacion() {
  if (notifBannerTimer_) {
    clearTimeout(notifBannerTimer_);
    notifBannerTimer_ = null;
  }
  const banner = document.getElementById('incoming-notif-banner');
  if (banner) banner.classList.add('hidden');
}

function mostrarBannerNotificacion_(notif) {
  const banner = document.getElementById('incoming-notif-banner');
  if (!banner || !notif) return;
  const iconEl = document.getElementById('incoming-notif-icon');
  const titleEl = document.getElementById('incoming-notif-title');
  const bodyEl = document.getElementById('incoming-notif-body');
  if (iconEl) iconEl.textContent = notif.tipo === 'gasto' ? '💸' : '💌';
  if (titleEl) titleEl.textContent = notif.titulo || 'Novedad en la app';
  if (bodyEl) bodyEl.textContent = notif.cuerpo || '';
  banner.classList.remove('hidden');

  if (notifBannerTimer_) clearTimeout(notifBannerTimer_);
  notifBannerTimer_ = setTimeout(() => {
    cerrarBannerNotificacion();
  }, 7500);
}

function chequearNotificacionEntrante_(notif) {
  if (!notif || !notif.id) return;
  if (notif.para && notif.para !== appState.activeUser) return;
  if (notif.de && notif.de === appState.activeUser) return;

  const seenKey = getLastSeenNotifStorageKey_(appState.activeUser);
  if (localStorage.getItem(seenKey) === notif.id) return;

  try {
    localStorage.setItem(seenKey, notif.id);
  } catch (e) {}

  reproducirSonidoNotificacion_();
  mostrarBannerNotificacion_(notif);
  mostrarNotificacionNativa_(notif.titulo, notif.cuerpo, notif.id);
}

function initNotificacionPolling_() {
  if (notifPollTimer_) clearInterval(notifPollTimer_);
  notifPollTimer_ = setInterval(() => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    if (pendingSyncCount > 0 || getPendingSyncQueue_().length > 0) return;
    recargarEstadoDiario_(false);
  }, 25000);

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      if (pendingSyncCount > 0 || getPendingSyncQueue_().length > 0) return;
      recargarEstadoDiario_(false);
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  cargarUsuarioYColorLocal_();
  initAvatarLongPress_();
  initOutsideCardTapToClose_();
  initHorizontalSwipeGesture_();
  initAndroidBackHistory_();
  autoFitCircleButtons();
  actualizarIndicadorMensajes_();
  initNotificacionPolling_();
  const msgInput = document.getElementById('msg-custom-input');
  if (msgInput) {
    msgInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        enviarMensajePareja();
      }
    });
  }
  window.addEventListener('resize', autoFitCircleButtons);
  window.addEventListener('scroll', updateFloatingCircleButtonsPosition, { passive: true });
  const appViewport = document.getElementById('app-viewport');
  if (appViewport) {
    appViewport.addEventListener('scroll', updateFloatingCircleButtonsPosition, { passive: true });
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', updateFloatingCircleButtonsPosition);
    window.visualViewport.addEventListener('scroll', updateFloatingCircleButtonsPosition, { passive: true });
  }
  bootstrapEstado_();
});


