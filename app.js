/**
 * ============================================================
 * DIA A DIA MULTIMILLONARIOS — FRONTEND MOTOR DIARIO (app.js)
 * ============================================================
 */

// ============================================================
// CONFIGURACIÓN DE CONEXIÓN AL BACKEND
// ============================================================
const BACKEND_URL = 'https://script.google.com/macros/s/AKfycbwHJx8AhDKR5k1eZSQ74hleTxUSy_0I_u83aOOvxIOK1IqtF_e87joQdpmDw70wSF7w/exec';
const ACCESS_KEY_STORAGE_KEY = 'app_access_key';
const ALLOWED_USERS_ = ['Brian', 'Virginia'];

function normalizarUsuarioLocal_(usuario, fallback) {
  if (ALLOWED_USERS_.includes(usuario)) return usuario;
  if (ALLOWED_USERS_.includes(fallback)) return fallback;
  return 'Brian';
}

// ============================================================
// ESTADO GLOBAL Y SINCRONIZACIÓN EN SEGUNDO PLANO
// ============================================================

const appState = {
  activeUser: 'Brian',
  homeBankingTotal: 0,
  bolsaTotal: 0,
  diaCobro: null,
  diasRestantes: [],
  diasExcluidos: [],
  movimientos: [],
  listaCompras: [],
  lastProcessedDate: null,
  whatsappConfigured: false
};

const PRESET_COUPLE_MESSAGES = [
  'Te amo mucho ❤️',
  'Ya actualicé la aplicación, te amo mucho ❤️'
];

let autoSyncTimer_ = null;
let wasKeyboardOpen_ = false;
let hbDraftDiasExcluidos_ = [];
let hbExcludedDirty_ = false;
let isExitingApp_ = false;
let lastAutoReloadTs_ = 0;
let isReloadingDiario_ = false;
const modalOpenStack_ = [];
const DIAS_SEMANA_CORTOS_ = ['Dom', 'Lun', 'Mar', 'Mie', 'Jue', 'Vier', 'Sab'];

let txModalSubtype = 'single';
let editingMovimientoId = null;
let cierreDiaPendiente = null;

let pendingSyncCount = 0;
let authPaused_ = false;
let clearPendingArmedUntil_ = 0;
let clearPendingTimer_ = null;
let vaciarBolsaArmedUntil_ = 0;
let vaciarBolsaTimer_ = null;

function isAppFramed_() {
  try {
    if (typeof window !== 'undefined' && window.__appFramedBlocked) return true;
    return typeof window !== 'undefined' && window.self !== window.top;
  } catch (e) {
    return true;
  }
}

// ============================================================
// CLAVE DE ACCESO Y CLIENTE DE API (Apps Script)
// ============================================================

function getStoredAccessKey_() {
  try {
    return String(localStorage.getItem(ACCESS_KEY_STORAGE_KEY) || '').trim();
  } catch (e) {
    return '';
  }
}

function setStoredAccessKey_(key) {
  try {
    const clean = String(key || '').trim();
    if (!clean) {
      localStorage.removeItem(ACCESS_KEY_STORAGE_KEY);
    } else {
      localStorage.setItem(ACCESS_KEY_STORAGE_KEY, clean);
    }
  } catch (e) {}
}

function createApiError_(json, fallbackMsg) {
  const err = new Error((json && json.error) || fallbackMsg || 'Error de comunicación');
  if (json && json.code) err.code = json.code;
  if (json && json.status) err.status = json.status;
  return err;
}

function isAuthError_(err) {
  const code = err && err.code ? String(err.code) : '';
  return code === 'UNAUTHORIZED' || code === 'AUTH_NOT_CONFIGURED';
}

function isRetryableBackendError_(err) {
  if (isAuthError_(err)) return false;
  const code = err && err.code ? String(err.code) : '';
  if (code === 'LOCK_TIMEOUT' || code === 'SERVICE_UNAVAILABLE') return true;
  return isNetworkOrTimeoutError_(err);
}

function setLockedBackgroundInert_(locked) {
  if (typeof document === 'undefined') return;
  const ids = ['app-viewport', 'day-change-modal', 'palette-modal', 'message-modal', 'shopping-modal'];
  const activeEl = document.activeElement;
  if (locked && activeEl && typeof activeEl.blur === 'function') {
    const keyModal = document.getElementById('access-key-modal');
    if (!keyModal || !keyModal.contains(activeEl)) {
      try { activeEl.blur(); } catch (e) {}
    }
  }
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (locked) {
      el.inert = true;
      el.setAttribute('inert', '');
      el.setAttribute('aria-hidden', 'true');
    } else {
      el.inert = false;
      el.removeAttribute('inert');
      el.removeAttribute('aria-hidden');
    }
  });
}

function purgarCacheLecturaYEstadoMemoria_() {
  try {
    localStorage.removeItem('cached_diario_state');
  } catch (e) {}
  appState.homeBankingTotal = 0;
  appState.bolsaTotal = 0;
  appState.diaCobro = null;
  appState.diasRestantes = [];
  appState.diasExcluidos = [];
  appState.movimientos = [];
  appState.listaCompras = [];
  appState.lastProcessedDate = null;
  appState.whatsappConfigured = false;
  cierreDiaPendiente = null;
  if (typeof renderMicroView === 'function') renderMicroView();
  if (typeof renderShoppingList_ === 'function') renderShoppingList_();
  if (typeof actualizarBadgeListaCompras_ === 'function') actualizarBadgeListaCompras_();
}

function resetClearPendingLocalBtn_() {
  clearPendingArmedUntil_ = 0;
  if (clearPendingTimer_) {
    clearTimeout(clearPendingTimer_);
    clearPendingTimer_ = null;
  }
  const btn = document.getElementById('btn-clear-pending-local');
  if (btn) {
    btn.textContent = 'Borrar cambios pendientes locales';
    btn.classList.remove('text-[#d31818]', 'font-bold');
    btn.classList.add('text-zinc-400', 'font-medium');
  }
}

function handleClearPendingLocalClick_() {
  const hasQueued = getPendingSyncQueue_().length > 0;
  const hasDraft = typeof hasPendingShoppingBatch_ === 'function' && hasPendingShoppingBatch_();
  let hasCached = false;
  try { hasCached = Boolean(localStorage.getItem('cached_diario_state')); } catch (e) {}

  if (!hasQueued && !hasDraft && !hasCached) {
    resetClearPendingLocalBtn_();
    showAppToast('No hay cambios pendientes locales en este teléfono');
    return;
  }

  const now = Date.now();
  if (now >= clearPendingArmedUntil_) {
    clearPendingArmedUntil_ = now + 3500;
    const btn = document.getElementById('btn-clear-pending-local');
    if (btn) {
      btn.textContent = '¿Confirmar borrar cambios pendientes?';
      btn.classList.remove('text-zinc-400', 'font-medium');
      btn.classList.add('text-[#d31818]', 'font-bold');
    }
    if (clearPendingTimer_) clearTimeout(clearPendingTimer_);
    clearPendingTimer_ = setTimeout(() => {
      resetClearPendingLocalBtn_();
    }, 3500);
    return;
  }

  savePendingSyncQueue_([]);
  if (typeof clearShoppingDraft_ === 'function') clearShoppingDraft_();
  purgarCacheLecturaYEstadoMemoria_();
  resetClearPendingLocalBtn_();
  showAppToast('Cambios locales pendientes eliminados');
}

function openAccessKeyModal_(errorMsg) {
  if (isAppFramed_()) return;
  const splashEl = document.getElementById('app-splash-screen');
  if (splashEl) {
    splashEl.classList.add('splash-hidden', 'hidden');
  }
  const modal = document.getElementById('access-key-modal');
  const errEl = document.getElementById('access-key-error');
  const inputEl = document.getElementById('access-key-input');
  if (modal && !modal.classList.contains('active')) {
    modal.classList.add('active');
    const hasOtherOpen = document.querySelector('#hb-modal.active, #budget-audit-modal.active, #future-days-modal.active, #message-modal.active, #shopping-modal.active, #palette-modal.active, #day-change-modal.active');
    if (hasOtherOpen && typeof closeAllActiveModalsWithoutSaving_ === 'function') {
      closeAllActiveModalsWithoutSaving_();
    }
    const dayModal = document.getElementById('day-change-modal');
    if (dayModal) dayModal.classList.remove('active');
  }
  resetClearPendingLocalBtn_();
  setLockedBackgroundInert_(true);
  if (errEl) {
    if (errorMsg) {
      errEl.textContent = errorMsg;
      errEl.classList.remove('hidden');
    } else {
      errEl.textContent = '';
      errEl.classList.add('hidden');
    }
  }
  if (inputEl && typeof inputEl.focus === 'function' && document.activeElement !== inputEl) {
    setTimeout(() => {
      try {
        if (modal && modal.classList.contains('active')) inputEl.focus();
      } catch (e) {}
    }, 60);
  }
}

function closeAccessKeyModal_(skipSwReload) {
  const modal = document.getElementById('access-key-modal');
  const errEl = document.getElementById('access-key-error');
  const inputEl = document.getElementById('access-key-input');
  resetClearPendingLocalBtn_();
  if (errEl) {
    errEl.textContent = '';
    errEl.classList.add('hidden');
  }
  if (inputEl) inputEl.value = '';
  if (modal) modal.classList.remove('active');
  setLockedBackgroundInert_(false);
  resetAppScrollToTop_();
  if (!skipSwReload) {
    maybeApplyPendingSwReload_();
  }
}

function handleAuthFailure_(err) {
  authPaused_ = true;
  const code = err && err.code ? String(err.code) : 'UNAUTHORIZED';
  if (code === 'UNAUTHORIZED') {
    if (getStoredAccessKey_()) setStoredAccessKey_('');
    purgarCacheLecturaYEstadoMemoria_();
  }
  const msg = code === 'AUTH_NOT_CONFIGURED'
    ? 'Falta configurar APP_ACCESS_KEY en Google Apps Script (ejecutá generarClaveAcceso).'
    : ((err && err.message) || 'Ingresá la clave de acceso para sincronizar.');
  openAccessKeyModal_(msg);
}

async function submitAccessKeyForm_() {
  if (isAppFramed_()) return;
  const inputEl = document.getElementById('access-key-input');
  const errEl = document.getElementById('access-key-error');
  const btnEl = document.getElementById('btn-submit-access-key');
  const candidate = String(inputEl ? inputEl.value : '').trim();

  if (!candidate) {
    openAccessKeyModal_('Ingresá una clave válida.');
    return;
  }
  if (errEl) {
    errEl.textContent = '';
    errEl.classList.add('hidden');
  }

  const prevLabel = btnEl ? btnEl.textContent : '';
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.textContent = 'Verificando...';
  }

  try {
    const res = await fetchWithRetry(BACKEND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'getEstadoDiario', payload: {}, accessKey: candidate })
    }, 2, 25000);
    const json = await res.json();
    if (!json || !json.ok) {
      throw createApiError_(json, 'Clave de acceso incorrecta');
    }

    setStoredAccessKey_(candidate);
    authPaused_ = false;
    closeAccessKeyModal_(true);
    enqueuePendingShoppingDraftForRecovery_();

    if (getPendingSyncQueue_().length > 0) {
      await processPendingSyncQueue_();
      if (!authPaused_) {
        if (getPendingSyncQueue_().length === 0) {
          await recargarEstadoDiario_(false);
          try { await chequearCierreDia_(); } catch (e) {}
        } else if (!localStorage.getItem('cached_diario_state')) {
          aplicarEstadoDiario_(json.data);
          try { await chequearCierreDia_(); } catch (e) {}
        }
      }
    } else {
      aplicarEstadoDiario_(json.data);
      try { await chequearCierreDia_(); } catch (e) {}
    }
    maybeApplyPendingSwReload_();
    showAppToast('Acceso desbloqueado');
  } catch (err) {
    const code = err && err.code ? String(err.code) : '';
    const msg = code === 'AUTH_NOT_CONFIGURED'
      ? 'Falta configurar APP_ACCESS_KEY en Apps Script (ejecutá generarClaveAcceso).'
      : ((err && err.message) || 'No se pudo validar la clave. Verificá tu conexión e intentá de nuevo.');
    openAccessKeyModal_(msg);
  } finally {
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.textContent = prevLabel;
    }
  }
}

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
      if (!res.ok) {
        const httpErr = new Error('HTTP Error ' + res.status);
        httpErr.status = res.status;
        throw httpErr;
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      if (err && typeof err.status === 'number' && err.status >= 400 && err.status < 500) {
        throw err;
      }
      if (attempt >= maxRetries) throw err;
      const delay = Math.pow(2, attempt - 1) * 600;
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

async function callBackend(action, payload, opts) {
  if (isAppFramed_()) {
    throw createApiError_({ ok: false, code: 'FORBIDDEN_FRAME', error: 'Ejecución embebida bloqueada' });
  }
  const accessKey = getStoredAccessKey_();
  if (!accessKey) {
    const authErr = createApiError_({ ok: false, code: 'UNAUTHORIZED', error: 'Ingresá tu clave de acceso para continuar.' });
    handleAuthFailure_(authErr);
    throw authErr;
  }

  const maxRetries = (opts && typeof opts.maxRetries === 'number') ? opts.maxRetries : 3;
  const timeoutMs = (opts && typeof opts.timeoutMs === 'number') ? opts.timeoutMs : 35000;

  const res = await fetchWithRetry(BACKEND_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: action, payload: payload || {}, accessKey: accessKey })
  }, maxRetries, timeoutMs);
  const json = await res.json();
  if (!json.ok) {
    const apiErr = createApiError_(json, 'Error en ' + action);
    if (isAuthError_(apiErr) && accessKey === getStoredAccessKey_()) {
      handleAuthFailure_(apiErr);
    }
    throw apiErr;
  }
  return json.data;
}

async function callBackendConSync(action, payload, opts) {
  mostrarSyncToast_();
  try {
    return await callBackend(action, payload, opts);
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
  const idSuffix = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    ? crypto.randomUUID()
    : (Date.now() + '_' + Math.random().toString(36).slice(2, 8));
  const syncId = 'sync_' + idSuffix;
  queue.push({
    id: syncId,
    action: action,
    payload: payload,
    timestamp: Date.now()
  });
  savePendingSyncQueue_(queue);
  return syncId;
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
  if (authPaused_ || !getStoredAccessKey_()) {
    if (!getStoredAccessKey_()) {
      const keyModal = document.getElementById('access-key-modal');
      if (!keyModal || !keyModal.classList.contains('active')) {
        openAccessKeyModal_('Ingresá tu clave de acceso para sincronizar los cambios pendientes.');
      }
    }
    return;
  }

  isProcessingSyncQueue_ = true;
  mostrarSyncToast_();
  try {
    while (true) {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) break;
      if (authPaused_ || !getStoredAccessKey_()) break;
      const queue = getPendingSyncQueue_();
      if (!queue.length) break;
      const item = queue[0];
      try {
        const itemRes = await callBackend(item.action, item.payload);
        savePendingSyncQueue_(getPendingSyncQueue_().filter(x => x.id !== item.id));
        if (
          item.action === 'guardarListaCompras' &&
          itemRes &&
          Array.isArray(itemRes.listaCompras) &&
          !hasPendingShoppingBatch_() &&
          !hasQueuedShoppingSync_()
        ) {
          appState.listaCompras = normalizarListaCompras_(itemRes.listaCompras);
          guardarCacheDiarioLocal_();
          actualizarBadgeListaCompras_();
          const shopModal = document.getElementById('shopping-modal');
          if (shopModal && shopModal.classList.contains('active')) renderShoppingList_();
        }
      } catch (err) {
        console.error('Error procesando ítem de cola pendiente:', item, err);
        if (isAuthError_(err)) {
          // Preservar cola y pausar hasta que el usuario re-ingrese clave
          authPaused_ = true;
          handleAuthFailure_(err);
          break;
        } else if (isRetryableBackendError_(err)) {
          // Conexión inestable o LOCK_TIMEOUT: preservar cola y esperar al próximo reintento
          break;
        } else {
          // Error fatal en datos de la petición (ej. VALIDATION_ERROR): descartar para evitar bloqueo permanente
          savePendingSyncQueue_(getPendingSyncQueue_().filter(x => x.id !== item.id));
        }
      }
    }
    if (!authPaused_ && getPendingSyncQueue_().length === 0) {
      showAppToast('Sincronización pendiente completada');
    }
  } finally {
    isProcessingSyncQueue_ = false;
    ocultarSyncToast_();
    maybeApplyPendingSwReload_();
  }
}

if (typeof window !== 'undefined' && !isAppFramed_()) {
  window.addEventListener('online', () => {
    console.log('Conexión reestablecida. Procesando cola de sincronización pendiente...');
    if (authPaused_ || !getStoredAccessKey_()) return;
    if (getPendingSyncQueue_().length > 0) {
      processPendingSyncQueue_();
    } else {
      solicitarRecargaSuave_();
    }
  });
}

async function callBackendBackground(action, payload) {
  const queue = getPendingSyncQueue_();
  const missingKey = !getStoredAccessKey_();
  // Si hay bloqueo de auth, sin conexión u operaciones pendientes, encolar para garantizar orden FIFO
  if (
    (typeof navigator !== 'undefined' && navigator.onLine === false) ||
    authPaused_ ||
    missingKey ||
    queue.length > 0 ||
    pendingSyncCount > 0 ||
    isProcessingSyncQueue_
  ) {
    enqueuePendingSync_(action, payload);
    if (missingKey || authPaused_) {
      const keyModal = document.getElementById('access-key-modal');
      if (!keyModal || !keyModal.classList.contains('active')) {
        openAccessKeyModal_('Ingresá tu clave de acceso para sincronizar tus movimientos guardados.');
      }
    } else if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      showAppToast('Sin conexión: acción guardada para sincronizar al volver en línea');
    } else if (pendingSyncCount === 0 && !isProcessingSyncQueue_) {
      processPendingSyncQueue_();
    }
    return null;
  }

  let failedRetryable = false;
  pendingSyncCount++;
  mostrarSyncToast_();
  try {
    const res = await callBackend(action, payload);
    return res;
  } catch (err) {
    console.error('Error en sync background (' + action + '):', err);
    if (isAuthError_(err)) {
      failedRetryable = true;
      enqueuePendingSync_(action, payload);
      if (!authPaused_) handleAuthFailure_(err);
      return null;
    }
    if (isRetryableBackendError_(err)) {
      failedRetryable = true;
      enqueuePendingSync_(action, payload);
      showAppToast('Fallo de red o servidor ocupado: acción guardada en cola para reintentar', true);
      return null;
    }
    showAppToast('Error de sincronización: ' + (err.message || 'Fallo de red'), true);
    throw err;
  } finally {
    pendingSyncCount--;
    if (pendingSyncCount <= 0) {
      pendingSyncCount = 0;
      ocultarSyncToast_();
      if (!failedRetryable && !authPaused_ && getStoredAccessKey_() && getPendingSyncQueue_().length > 0 && !isProcessingSyncQueue_) {
        processPendingSyncQueue_();
      } else {
        maybeApplyPendingSwReload_();
      }
    }
  }
}

function showAppToast(message, isError = false, durationMs = 3500) {
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
  }, durationMs);
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

  const metaThemes = document.querySelectorAll('meta[name="theme-color"]');
  metaThemes.forEach(meta => meta.setAttribute('content', paleta.primary));

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
    return '<button type="button" data-palette-id="' + escapeHtml_(p.id) + '" class="palette-option-card ' + (isSelected ? 'active' : '') + '">' +
      '<div class="flex items-center gap-3 min-w-0">' +
        '<span class="palette-swatches">' +
          '<span class="palette-swatch-dot" style="background-color:' + p.primary + ';"></span>' +
          '<span class="palette-swatch-dot" style="background-color:' + p.muted + ';"></span>' +
          '<span class="palette-swatch-dot" style="background-color:' + p.surface + ';"></span>' +
        '</span>' +
        '<div class="min-w-0">' +
          '<span class="text-sm font-bold text-zinc-800 block leading-tight truncate">' + escapeHtml_(p.nombre) + '</span>' +
          '<span class="text-[11px] text-zinc-500 block leading-tight truncate">' + escapeHtml_(p.desc) + '</span>' +
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
  pushOverlayStack_('palette-modal');
  pushModalHistory_('palette-modal');
}

function closePaletteModal() {
  popOverlayStack_('palette-modal');
  const modal = document.getElementById('palette-modal');
  if (modal) modal.classList.remove('active');
  resetAppScrollToTop_();
  maybeApplyPendingSwReload_();
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
      if (authPaused_ || !getStoredAccessKey_()) return;
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
      if (authPaused_ || !getStoredAccessKey_()) {
        e.preventDefault();
        return;
      }
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
  appState.activeUser = normalizarUsuarioLocal_(localStorage.getItem('userActive'), 'Brian');
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
  const validUser = normalizarUsuarioLocal_(user, 'Brian');
  const draft = loadShoppingDraft_();
  if (draft && draft.ops && draft.ops.length && draft.usuario && draft.usuario !== validUser) {
    flushShoppingBatch_('user_switch');
  }
  resetTxForm_();
  appState.activeUser = validUser;
  localStorage.setItem('userActive', validUser);
  aplicarPaletaUsuario_(validUser);
  pintarBotonesUsuario_();
  renderMicroView();
}


// ============================================================
// VISTA MICRO (MOTOR DIARIO)
// ============================================================

function esFechaCalendarioValidaLocal_(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === (mo - 1) && dt.getDate() === d;
}

function normalizarDiasExcluidosLocal_(raw) {
  let lista = raw;
  if (typeof lista === 'string') {
    try { lista = JSON.parse(lista); } catch (e) { lista = []; }
  }
  if (!Array.isArray(lista)) return [];
  const seen = new Set();
  return lista
    .map(f => String(f || '').trim())
    .filter(esFechaCalendarioValidaLocal_)
    .filter(f => {
      if (seen.has(f)) return false;
      seen.add(f);
      return true;
    })
    .sort();
}

function getDiasElegiblesExclusion_() {
  const dias = appState.diasRestantes || [];
  if (!dias.length) return [];
  const cobroYM = appState.diaCobro ? String(appState.diaCobro).slice(0, 7) : '';
  return dias.filter(f => {
    const dayNum = Number(String(f).slice(8, 10));
    const ym = String(f).slice(0, 7);
    return dayNum >= 28 || (cobroYM && ym === cobroYM);
  });
}

function getDiasExcluidosEnPeriodo_(excluidosOverride) {
  const diasSet = new Set(appState.diasRestantes || []);
  const fuente = excluidosOverride !== undefined
    ? (Array.isArray(excluidosOverride) ? excluidosOverride : normalizarDiasExcluidosLocal_(excluidosOverride))
    : (appState.diasExcluidos || []);
  return fuente.filter(f => diasSet.has(f));
}

function getDiasActivos_(excluidosOverride) {
  const exclSet = new Set(getDiasExcluidosEnPeriodo_(excluidosOverride));
  return (appState.diasRestantes || []).filter(f => !exclSet.has(f));
}

function esDiaExcluido_(fechaISO, excluidosOverride) {
  const fuente = excluidosOverride !== undefined
    ? (Array.isArray(excluidosOverride) ? excluidosOverride : normalizarDiasExcluidosLocal_(excluidosOverride))
    : (appState.diasExcluidos || []);
  return fuente.includes(fechaISO);
}

function calcularComposicion_(hbOverride, bolsaOverride, excluidosOverride) {
  const dias = getDiasActivos_(excluidosOverride);
  const activeSet = new Set(dias);
  const hbVal = hbOverride !== undefined ? hbOverride : appState.homeBankingTotal;
  const bolsaVal = bolsaOverride !== undefined ? bolsaOverride : appState.bolsaTotal;
  const liquidHB = hbVal - bolsaVal;
  const gastosPorFecha = {};
  (appState.diasRestantes || []).forEach(f => { gastosPorFecha[f] = 0; });

  let gastosEnPeriodo = 0;
  appState.movimientos.forEach(m => {
    if (m.fromBag) return;
    const fechas = normalizarFechas_(m.fechasAfectadas);
    fechas.forEach(f => {
      if (Object.prototype.hasOwnProperty.call(gastosPorFecha, f)) {
        gastosPorFecha[f] += m.montoPorFecha;
      }
      if (activeSet.has(f)) {
        gastosEnPeriodo += m.montoPorFecha;
      }
    });
  });

  const objetivoBase = dias.length > 0 ? (liquidHB + gastosEnPeriodo) / dias.length : 0;
  return { objetivoBase: objetivoBase, gastosPorFecha: gastosPorFecha };
}

function presupuestoParaFecha_(fechaISO, compPrevia) {
  if (esDiaExcluido_(fechaISO)) return 0;
  const comp = compPrevia || calcularComposicion_();
  return comp.objetivoBase - (comp.gastosPorFecha[fechaISO] || 0);
}

function renderMicroView() {
  const hbEl = document.getElementById('hb-total-display');
  const bolsaEl = document.getElementById('savings-bag-display');
  if (hbEl) hbEl.textContent = formatearMoneda_(appState.homeBankingTotal);
  if (bolsaEl) bolsaEl.textContent = formatearMoneda_(appState.bolsaTotal);

  const hoyStr = hoyISO_();
  const mananaStr = formatearFechaISOLocal_(sumarDiasLocal_(new Date(), 1));

  const comp = calcularComposicion_();
  const presupuestoHoy = presupuestoParaFecha_(hoyStr, comp);
  const presupuestoManana = presupuestoParaFecha_(mananaStr, comp);

  const hoyEl = document.getElementById('today-budget-display');
  const mananaEl = document.getElementById('tomorrow-budget-display');
  const diasLabel = document.getElementById('days-remaining-label');
  if (hoyEl) hoyEl.textContent = formatearMoneda_(presupuestoHoy);
  if (mananaEl) mananaEl.textContent = formatearMoneda_(presupuestoManana);
  if (diasLabel) {
    const diasActivos = getDiasActivos_();
    const excluidosPeriodo = getDiasExcluidosEnPeriodo_();
    if (excluidosPeriodo.length > 0) {
      diasLabel.textContent = 'Quedan ' + diasActivos.length + (diasActivos.length === 1 ? ' día activo' : ' días activos') +
        ' (' + excluidosPeriodo.length + (excluidosPeriodo.length === 1 ? ' exceptuado' : ' exceptuados') +
        ' · cobrás el ' + formatearFechaLegible_(appState.diaCobro) + ')';
    } else {
      const totalDias = appState.diasRestantes.length;
      diasLabel.textContent = 'Quedan ' + totalDias + (totalDias === 1 ? ' día' : ' días') +
        ' (cobrás el ' + formatearFechaLegible_(appState.diaCobro) + ')';
    }
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
    const titulo = escapeHtml_(m.descripcion || (m.tipo === 'divisible' ? 'Gasto divisible' : 'Gasto único'));
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
    const safeId = escapeHtml_(m.id);

    return '<button type="button" data-tx-id="' + safeId + '" class="w-full flex items-center justify-between text-left py-2 border-b border-white/10 hover:opacity-90 active:opacity-80 transition-opacity">' +
      '<div class="flex items-center gap-3">' +
      '<div class="w-8 h-8 rounded-full bg-white font-avatar font-bold text-sm flex items-center justify-center shrink-0" style="color: ' + badge.color + ';">' + badge.letter + '</div>' +
      '<div>' +
      '<span class="text-[11px] text-white/80 block leading-tight">' + escapeHtml_(textoFechas) + '</span>' +
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
      diasExcluidos: appState.diasExcluidos,
      movimientos: appState.movimientos,
      listaCompras: appState.listaCompras,
      lastProcessedDate: appState.lastProcessedDate,
      whatsappConfigured: appState.whatsappConfigured
    }));
  } catch (e) {}
}

function ensureCarouselTouchIsolation_(cont) {
  if (!cont || !cont.dataset || cont.dataset.touchIsolated) return;
  cont.dataset.touchIsolated = 'true';
  cont.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
  cont.addEventListener('touchmove', (e) => e.stopPropagation(), { passive: true });
}

function scrollDaysCarousel(delta, containerId = 'tx-days-carousel') {
  const cont = document.getElementById(containerId || 'tx-days-carousel');
  if (cont) {
    cont.scrollBy({ left: delta * 120, behavior: 'smooth' });
  }
}

function renderDayPillHtml_(fechaISO, isActive, extraAttrs = '', extraClasses = '', strikeDay = false) {
  const partes = String(fechaISO).split('-').map(Number);
  const dObj = new Date(partes[0], partes[1] - 1, partes[2]);
  const nombreDia = DIAS_SEMANA_CORTOS_[dObj.getDay()];
  const numDia = partes[2];
  const cls = 'day-pill ' + (isActive ? 'active' : 'inactive') + (extraClasses ? ' ' + extraClasses : '');
  const attrs = extraAttrs ? (' ' + extraAttrs) : '';
  return '<button type="button"' + attrs + ' aria-pressed="' + (isActive ? 'true' : 'false') + '" class="' + cls + '">' +
    '<span class="text-[11px] font-bold">' + nombreDia + '</span>' +
    '<span class="text-base font-black leading-tight' + (strikeDay ? ' line-through' : '') + '">' + numDia + '</span>' +
    '</button>';
}

function cerrarSubvistasTarjetaExcepto_(keepId) {
  ['hb-modal', 'budget-audit-modal', 'future-days-modal'].forEach(id => {
    if (id === keepId) return;
    if (id === 'hb-modal') {
      resetVaciarBolsaConfirm_();
      hbExcludedDirty_ = false;
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
    resetAppScrollToTop_();
  } else {
    resetVaciarBolsaConfirm_();
    hbExcludedDirty_ = false;
    setMoneyValue('hb-update-amount', '');
    setMoneyValue('hb-bolsa-input', '');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex', 'active');
    }
    if (dash) dash.classList.remove('hidden');
    resetAppScrollToTop_();
    maybeApplyPendingSwReload_();
  }
}

function renderHbExcludedDaysSelector_() {
  const section = document.getElementById('hb-excluded-days-section');
  const listEl = document.getElementById('hb-excluded-days-list');
  const countEl = document.getElementById('hb-excluded-count-label');
  if (!section || !listEl) return;

  ensureCarouselTouchIsolation_(listEl);

  const elegibles = getDiasElegiblesExclusion_();
  if (!elegibles.length) {
    section.classList.add('hidden');
    listEl.innerHTML = '';
    if (countEl) countEl.textContent = '';
    return;
  }

  section.classList.remove('hidden');
  const exclSet = new Set(getDiasExcluidosEnPeriodo_(hbDraftDiasExcluidos_));
  const exclCount = exclSet.size;
  if (countEl) {
    countEl.textContent = exclCount > 0
      ? (exclCount + (exclCount === 1 ? ' exceptuado' : ' exceptuados'))
      : 'Ninguno';
  }

  const prevScroll = listEl.scrollLeft || 0;
  listEl.innerHTML = elegibles.map(f => {
    const isExcluded = exclSet.has(f);
    return renderDayPillHtml_(f, isExcluded, 'data-hb-day="' + escapeHtml_(f) + '"', '', isExcluded);
  }).join('');
  listEl.scrollLeft = prevScroll;
}

function toggleHbExcludedDay_(fechaISO) {
  const fecha = String(fechaISO || '').trim();
  if (!fecha) return;
  const actual = new Set(getDiasExcluidosEnPeriodo_(hbDraftDiasExcluidos_));
  if (actual.has(fecha)) {
    actual.delete(fecha);
  } else {
    actual.add(fecha);
    if (getDiasActivos_(Array.from(actual)).length < 1) {
      showAppToast('Tenés que dejar al menos 1 día activo', true);
      return;
    }
  }
  hbExcludedDirty_ = true;
  hbDraftDiasExcluidos_ = normalizarDiasExcluidosLocal_(Array.from(actual));
  renderHbExcludedDaysSelector_();
  sincronizarPlaceholdersHbModal_();
  actualizarResumenHbModal_();
}

function sincronizarPlaceholdersHbModal_() {
  const modal = document.getElementById('hb-modal');
  const modalAbierto = !!(modal && !modal.classList.contains('hidden'));
  const exclFuente = modalAbierto ? hbDraftDiasExcluidos_ : appState.diasExcluidos;
  const diasCount = getDiasActivos_(exclFuente).length;
  const exclCount = getDiasExcluidosEnPeriodo_(exclFuente).length;
  const diasLabel = document.getElementById('hb-days-label');
  if (diasLabel) {
    diasLabel.textContent = exclCount > 0
      ? ('Quedan ' + diasCount + (diasCount === 1 ? ' día activo' : ' días activos') + ' (' + exclCount + (exclCount === 1 ? ' exceptuado' : ' exceptuados') + ' hasta el cobro)')
      : ('Quedan ' + diasCount + (diasCount === 1 ? ' día' : ' días') + ' hasta el cobro');
  }

  const elHb = document.getElementById('hb-update-amount');
  const elBolsa = document.getElementById('hb-bolsa-input');
  if (elHb) elHb.placeholder = formatearMoneda_(appState.homeBankingTotal);
  if (elBolsa) elBolsa.placeholder = formatearMoneda_(appState.bolsaTotal);
}

function tieneEdicionMonto_(inputId) {
  const st = moneyStates[inputId];
  return Boolean(st && (st.int !== '' || st.isDec));
}

function obtenerMontoInputOActual_(inputId, fallbackVal) {
  return tieneEdicionMonto_(inputId) ? getMoneyValue(inputId) : fallbackVal;
}

function actualizarResumenHbModal_() {
  const hbEfectivo = obtenerMontoInputOActual_('hb-update-amount', appState.homeBankingTotal);
  const bolsaEfectiva = obtenerMontoInputOActual_('hb-bolsa-input', appState.bolsaTotal);

  const hoyStr = hoyISO_();
  const compEfectiva = calcularComposicion_(hbEfectivo, bolsaEfectiva, hbDraftDiasExcluidos_);
  const disponibleHoy = esDiaExcluido_(hoyStr, hbDraftDiasExcluidos_)
    ? 0
    : (compEfectiva.objetivoBase - (compEfectiva.gastosPorFecha[hoyStr] || 0));

  const simpleEl = document.getElementById('hb-preview-daily-simple');
  const hoyEl = document.getElementById('hb-preview-today-left');
  if (simpleEl) simpleEl.textContent = formatearMoneda_(compEfectiva.objetivoBase);
  if (hoyEl) hoyEl.textContent = formatearMoneda_(disponibleHoy);
}

function refrescarVistaHbModalSiAbierto_() {
  const modal = document.getElementById('hb-modal');
  if (!modal || modal.classList.contains('hidden')) return;
  if (!hbExcludedDirty_) {
    hbDraftDiasExcluidos_ = getDiasExcluidosEnPeriodo_().slice();
  }
  renderHbExcludedDaysSelector_();
  sincronizarPlaceholdersHbModal_();
  actualizarResumenHbModal_();
}

function resetVaciarBolsaConfirm_() {
  vaciarBolsaArmedUntil_ = 0;
  if (vaciarBolsaTimer_) {
    clearTimeout(vaciarBolsaTimer_);
    vaciarBolsaTimer_ = null;
  }
  const btn = document.getElementById('btn-vaciar-bolsa');
  if (btn) {
    btn.textContent = 'Vaciar ahorros';
    btn.classList.remove('bg-[#d31818]', 'hover:bg-[#b91c1c]');
    btn.classList.add('bg-white/15', 'hover:bg-white/25');
  }
}

function prepararHbModal_() {
  resetVaciarBolsaConfirm_();
  hbExcludedDirty_ = false;
  hbDraftDiasExcluidos_ = getDiasExcluidosEnPeriodo_().slice();
  setMoneyValue('hb-update-amount', '');
  setMoneyValue('hb-bolsa-input', '');
  renderHbExcludedDaysSelector_();
  sincronizarPlaceholdersHbModal_();
  actualizarResumenHbModal_();
}

attachMoneyInput('hb-update-amount', actualizarResumenHbModal_);
attachMoneyInput('hb-bolsa-input', actualizarResumenHbModal_);
attachMoneyInput('tx-amount', () => {});

function aplicarYGuardarHbYBolsa_(updatesLocal, payloadBackend) {
  ++diarioLoadToken_;

  if (Object.prototype.hasOwnProperty.call(updatesLocal, 'homeBankingTotal')) {
    appState.homeBankingTotal = updatesLocal.homeBankingTotal;
  }
  if (Object.prototype.hasOwnProperty.call(updatesLocal, 'bolsaTotal')) {
    appState.bolsaTotal = updatesLocal.bolsaTotal;
  }
  if (Object.prototype.hasOwnProperty.call(updatesLocal, 'diasExcluidos')) {
    const periodoSet = new Set(appState.diasRestantes || []);
    const historicos = (appState.diasExcluidos || []).filter(f => !periodoSet.has(f));
    appState.diasExcluidos = normalizarDiasExcluidosLocal_(historicos.concat(updatesLocal.diasExcluidos));
  }
  hbExcludedDirty_ = false;
  setMoneyValue('hb-update-amount', '');
  setMoneyValue('hb-bolsa-input', '');
  guardarCacheDiarioLocal_();
  renderMicroView();
  refrescarVistaHbModalSiAbierto_();

  callBackendBackground('actualizarHB', payloadBackend)
    .catch(err => console.error('Error al actualizar Home Banking:', err));
}

async function saveHbAmount() {
  const tieneHb = tieneEdicionMonto_('hb-update-amount');
  const tieneBolsa = tieneEdicionMonto_('hb-bolsa-input');
  const cambioExcluidos = hbExcludedDirty_;

  if (!tieneHb && !tieneBolsa && !cambioExcluidos) {
    showAppToast('Sin cambios para guardar');
    return;
  }

  const updatesLocal = {};
  const payloadBackend = {};
  if (tieneHb) {
    const valHb = getMoneyValue('hb-update-amount');
    updatesLocal.homeBankingTotal = valHb;
    payloadBackend.homeBankingTotal = valHb;
  }
  if (tieneBolsa) {
    const valBolsa = getMoneyValue('hb-bolsa-input');
    updatesLocal.bolsaTotal = valBolsa;
    payloadBackend.bolsaTotal = valBolsa;
  }
  if (cambioExcluidos) {
    const excl = hbDraftDiasExcluidos_.slice();
    updatesLocal.diasExcluidos = excl;
    payloadBackend.diasExcluidos = excl;
  }

  aplicarYGuardarHbYBolsa_(updatesLocal, payloadBackend);
  showAppToast((!tieneHb && !tieneBolsa && cambioExcluidos) ? 'Días exceptuados actualizados' : 'Saldo actualizado');
}

async function handleVaciarBolsaAhorro() {
  if ((Number(appState.bolsaTotal) || 0) <= 0) {
    resetVaciarBolsaConfirm_();
    showAppToast('Tus ahorros ya están en $ 0');
    return;
  }
  const now = Date.now();
  if (now >= vaciarBolsaArmedUntil_) {
    vaciarBolsaArmedUntil_ = now + 3500;
    const btn = document.getElementById('btn-vaciar-bolsa');
    if (btn) {
      btn.textContent = '¿Confirmar vaciar?';
      btn.classList.remove('bg-white/15', 'hover:bg-white/25');
      btn.classList.add('bg-[#d31818]', 'hover:bg-[#b91c1c]');
    }
    if (vaciarBolsaTimer_) clearTimeout(vaciarBolsaTimer_);
    vaciarBolsaTimer_ = setTimeout(() => {
      resetVaciarBolsaConfirm_();
    }, 3500);
    return;
  }
  resetVaciarBolsaConfirm_();
  setMoneyValue('hb-update-amount', '');
  setMoneyValue('hb-bolsa-input', '');
  hbExcludedDirty_ = false;
  hbDraftDiasExcluidos_ = getDiasExcluidosEnPeriodo_().slice();
  aplicarYGuardarHbYBolsa_({ bolsaTotal: 0 }, { bolsaTotal: 0 });
  showAppToast('Ahorros pasados al presupuesto');
}

function initOutsideCardTapToClose_() {
  document.addEventListener('click', (e) => {
    if (Date.now() < ptrSuppressClickUntil_) return;
    const target = e.target;
    if (!target || typeof target.closest !== 'function') return;

    const ignoredSel = '.card-dark-main, .avatar-btn, .msg-header-btn, .modal-overlay, #exit-toast, #sync-toast';
    if (typeof e.composedPath === 'function') {
      const path = e.composedPath();
      if (Array.isArray(path) && path.some(node => node && typeof node.matches === 'function' && node.matches(ignoredSel))) {
        return;
      }
    }

    if (target.isConnected === false || (typeof document.contains === 'function' && !document.contains(target))) {
      return;
    }

    if (
      target.closest('.card-dark-main') ||
      target.closest('.avatar-btn') ||
      target.closest('.msg-header-btn') ||
      target.closest('.modal-overlay') ||
      target.closest('#exit-toast') ||
      target.closest('#sync-toast')
    ) {
      return;
    }

    const subvistas = [
      { id: 'hb-modal', close: () => toggleHbModal(false) },
      { id: 'budget-audit-modal', close: () => toggleBudgetAuditModal(false) },
      { id: 'future-days-modal', close: () => toggleFutureDaysModal(false) }
    ];
    subvistas.forEach(sv => {
      const el = document.getElementById(sv.id);
      if (el && !el.classList.contains('hidden')) sv.close();
    });
  });
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

  if (esDiaExcluido_(appState.lastProcessedDate)) {
    try {
      const resultado = await callBackendConSync('resolverCierreDia', { decision: 'redistribuir', tipo: 'sobrante', monto: 0 });
      appState.lastProcessedDate = normalizarFechaConfig_(resultado.lastProcessedDate, hoyISO_());
      guardarCacheDiarioLocal_();
    } catch (e) {
      console.error('Error al cerrar día exceptuado:', e);
    }
    return;
  }

  const ventana = [appState.lastProcessedDate].concat(getDiasActivos_());
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
    appState.lastProcessedDate = normalizarFechaConfig_(resultado.lastProcessedDate, hoyISO_());
    guardarCacheDiarioLocal_();
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
    if (!isAuthError_(e)) {
      showAppToast('Error al cerrar el día', true);
    }
  } finally {
    ocultarSyncToast_();
  }
}

function generarIdMovimientoLocal_() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return 'tx_' + crypto.randomUUID();
  }
  return 'tx_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
}

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
      tabList.className = 'px-3 py-1 text-xs font-black tracking-wider text-white border-b-2 border-white focus:outline-none uppercase text-center';
    }
    if (tabAdd) {
      tabAdd.className = 'px-3 py-1 text-xs font-normal tracking-wider text-white/70 hover:text-white focus:outline-none uppercase text-center';
    }
  } else {
    panelAdd.classList.remove('hidden');
    panelAdd.classList.add('flex');
    panelList.classList.add('hidden');
    if (tabAdd) {
      tabAdd.className = 'px-3 py-1 text-xs font-black tracking-wider text-white border-b-2 border-white focus:outline-none uppercase text-center';
    }
    if (tabList) {
      tabList.className = 'px-3 py-1 text-xs font-normal tracking-wider text-white/70 hover:text-white focus:outline-none uppercase text-center';
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
  resetAppScrollToTop_();
  if (view === 'list') {
    maybeApplyPendingSwReload_();
  }
}

function parseTxCustomDates_() {
  const customDaysEl = document.getElementById('tx-custom-days');
  const raw = (customDaysEl && customDaysEl.value) ? customDaysEl.value.trim() : '';
  if (!raw) return [];

  const fechas = [];
  const seen = new Set();
  const diasPeriodo = appState.diasRestantes || [];

  raw.split(',').map(s => s.trim()).filter(Boolean).forEach(token => {
    let iso = '';
    if (esFechaCalendarioValidaLocal_(token)) {
      iso = token;
    } else {
      const num = parseInt(token, 10);
      if (!isNaN(num)) {
        const match = diasPeriodo.find(f => Number(f.split('-')[2]) === num);
        if (match) iso = match;
      }
    }
    if (iso && !seen.has(iso)) {
      seen.add(iso);
      fechas.push(iso);
    }
  });

  return fechas.sort();
}

function renderTxDaysCarousel_() {
  const cont = document.getElementById('tx-days-carousel');
  if (!cont) return;

  ensureCarouselTouchIsolation_(cont);

  const hoy = hoyISO_();
  const dias = (appState.diasRestantes && appState.diasRestantes.length)
    ? appState.diasRestantes.slice()
    : [hoy];
  if (!dias.includes(hoy)) dias.unshift(hoy);

  const assignedInput = document.getElementById('tx-assigned-date');
  const currentAssigned = (assignedInput && assignedInput.value) || hoy;
  const selectedDates = parseTxCustomDates_();

  const prevScroll = cont.scrollLeft || 0;
  cont.innerHTML = dias.map(f => {
    const isSelected = (txModalSubtype === 'single')
      ? (f === currentAssigned)
      : selectedDates.includes(f);

    const isExcl = esDiaExcluido_(f);
    return renderDayPillHtml_(
      f,
      isSelected,
      'data-tx-day="' + escapeHtml_(f) + '"',
      isExcl && !isSelected ? 'is-excluded-hint' : '',
      isExcl
    );
  }).join('');
  cont.scrollLeft = prevScroll;

  const divHint = document.getElementById('tx-divisible-hint');
  if (divHint) {
    if (txModalSubtype !== 'divisible') {
      divHint.classList.add('hidden');
    } else {
      const totalActivos = getDiasActivos_().length || (appState.diasRestantes ? appState.diasRestantes.length : 1);
      divHint.textContent = selectedDates.length === 0
        ? ('Sin elegir días: se divide en todos los días activos (' + totalActivos + (totalActivos === 1 ? ' día)' : ' días)'))
        : ('Dividido en ' + selectedDates.length + (selectedDates.length === 1 ? ' día seleccionado' : ' días seleccionados'));
      divHint.classList.remove('hidden');
    }
  }
}

function selectTxDay_(fechaISO) {
  const assignedInput = document.getElementById('tx-assigned-date');
  const customDaysInput = document.getElementById('tx-custom-days');

  if (txModalSubtype === 'single') {
    if (assignedInput) assignedInput.value = fechaISO;
  } else {
    let selected = parseTxCustomDates_();
    if (selected.includes(fechaISO)) {
      selected = selected.filter(f => f !== fechaISO);
    } else {
      selected.push(fechaISO);
      selected.sort();
    }
    if (customDaysInput) customDaysInput.value = selected.join(',');
    const daysCountEl = document.getElementById('tx-days-count');
    if (daysCountEl) daysCountEl.value = '';
    const divStartEl = document.getElementById('tx-divisible-start-date');
    if (divStartEl) divStartEl.value = '';
  }
  renderTxDaysCarousel_();
}

function setTxSubtype(tipo) {
  const prevSubtype = txModalSubtype;
  txModalSubtype = tipo;

  const tabSingle = document.getElementById('tab-single');
  const tabDivisible = document.getElementById('tab-divisible');
  if (tabSingle && tabDivisible) {
    if (tipo === 'single') {
      tabSingle.className = 'px-3 py-1 text-sm font-black text-white focus:outline-none border-b-2 border-white';
      tabDivisible.className = 'px-3 py-1 text-sm font-normal text-white/70 hover:text-white focus:outline-none';
    } else {
      tabDivisible.className = 'px-3 py-1 text-sm font-black text-white focus:outline-none border-b-2 border-white';
      tabSingle.className = 'px-3 py-1 text-sm font-normal text-white/70 hover:text-white focus:outline-none';
    }
  }

  const assignCont = document.getElementById('tx-assigned-date-container');
  if (assignCont) assignCont.classList.toggle('hidden', tipo === 'divisible');
  const divOpts = document.getElementById('divisible-options');
  if (divOpts) divOpts.classList.toggle('hidden', tipo !== 'divisible');

  const customDaysEl = document.getElementById('tx-custom-days');
  if (customDaysEl) customDaysEl.value = '';
  const daysCountEl = document.getElementById('tx-days-count');
  if (daysCountEl) daysCountEl.value = '';
  const divStartEl = document.getElementById('tx-divisible-start-date');
  if (divStartEl) divStartEl.value = '';

  const fechaEl = document.getElementById('tx-assigned-date');
  if (tipo === 'divisible') {
    const chkBag = document.getElementById('chk-from-bag');
    if (chkBag) chkBag.checked = false;
    if (fechaEl) fechaEl.removeAttribute('disabled');
  } else if (prevSubtype === 'divisible' && fechaEl) {
    fechaEl.value = hoyISO_();
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
  if (assignEl) {
    assignEl.value = (m.tipo === 'single') ? (fechas[0] || hoyISO_()) : hoyISO_();
  }

  if (m.tipo === 'divisible') {
    const daysCountEl = document.getElementById('tx-days-count');
    if (daysCountEl) daysCountEl.value = '';
    const divStartEl = document.getElementById('tx-divisible-start-date');
    if (divStartEl) divStartEl.value = '';
    const customDaysEl = document.getElementById('tx-custom-days');
    if (customDaysEl) customDaysEl.value = fechas.join(',');
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
  if (!monto || monto <= 0) {
    const amtEl = document.getElementById('tx-amount');
    if (amtEl && typeof amtEl.focus === 'function') amtEl.focus();
    showAppToast('Ingresá un monto válido', true);
    return;
  }

  const descripcion = document.getElementById('tx-desc').value.trim();
  const fromBag = document.getElementById('chk-from-bag').checked;
  let fechasAfectadas = [];

  if (subtypeToSave === 'single') {
    const fecha = document.getElementById('tx-assigned-date').value || hoyISO_();
    fechasAfectadas = [fecha];
  } else {
    const selectedDates = parseTxCustomDates_();
    const diasCount = parseInt(document.getElementById('tx-days-count').value, 10);
    const fechaInicio = document.getElementById('tx-divisible-start-date').value;

    if (selectedDates.length) {
      fechasAfectadas = selectedDates;
    } else if (diasCount && fechaInicio) {
      const base = new Date(fechaInicio + 'T00:00:00');
      for (let i = 0; i < diasCount; i++) {
        fechasAfectadas.push(formatearFechaISOLocal_(new Date(base.getFullYear(), base.getMonth(), base.getDate() + i)));
      }
    } else {
      const activos = getDiasActivos_();
      fechasAfectadas = activos.length ? activos.slice() : appState.diasRestantes.slice();
    }
  }

  if (!fechasAfectadas.length) { showAppToast('Seleccioná al menos una fecha para este gasto', true); return; }

  toggleModal(false);

  // Update Optimista
  const idMov = idToSave || generarIdMovimientoLocal_();
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
    id: idMov,
    tipo: subtypeToSave,
    fechasAfectadas: fechasAfectadas,
    monto: monto,
    descripcion: descripcion,
    usuario: userToSave,
    actorUsuario: appState.activeUser,
    fromBag: fromBag,
    disponibleHoyTexto: disponibleHoyTexto
  })
    .then(() => recargarEstadoDiario_(false))
    .catch(err => console.error('Error sincronizando movimiento:', err));
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

  const disponibleHoyTexto = formatearMoneda_(presupuestoParaFecha_(hoyISO_()));

  callBackendBackground('eliminarMovimiento', {
    id: idToDelete,
    usuario: appState.activeUser,
    disponibleHoyTexto: disponibleHoyTexto
  })
    .then(() => recargarEstadoDiario_(false))
    .catch(err => console.error('Error sincronizando eliminación de movimiento:', err));
}

// ============================================================
// AUDITORÍA Y FUTUROS DÍAS (DIARIO)
// ============================================================

function openBudgetAuditModal(targetDay) {
  const fecha = targetDay === 'tomorrow' ? formatearFechaISOLocal_(sumarDiasLocal_(new Date(), 1)) : hoyISO_();
  const comp = calcularComposicion_();
  const excluido = esDiaExcluido_(fecha);
  const gastoDelDia = comp.gastosPorFecha[fecha] || 0;
  const baseDia = excluido ? 0 : comp.objetivoBase;
  const disponible = excluido ? 0 : (comp.objetivoBase - gastoDelDia);

  const auditTitle = document.getElementById('audit-title');
  const auditSubtitle = document.getElementById('audit-subtitle');
  if (auditTitle) auditTitle.textContent = targetDay === 'tomorrow' ? 'Detalle de Mañana' : 'Detalle de Hoy';
  if (auditSubtitle) {
    auditSubtitle.textContent = (excluido && gastoDelDia > 0)
      ? (formatearFechaLegible_(fecha) + ' · Exceptuado (consumos del saldo general)')
      : formatearFechaLegible_(fecha);
  }

  const movimientosDelDia = appState.movimientos.filter(m => {
    if (m.fromBag) return false;
    const fechas = normalizarFechas_(m.fechasAfectadas);
    return fechas.includes(fecha);
  });

  let html = '<div class="flex justify-between items-baseline py-2 border-b border-white/20">' +
    '<span class="text-base font-bold text-white">' + (excluido ? 'Presupuesto base (exceptuado):' : 'Presupuesto base:') + '</span>' +
    '<span class="text-base font-bold text-white">' + formatearMoneda_(baseDia) + '</span></div>';

  if (movimientosDelDia.length) {
    html += movimientosDelDia.map(m => {
      const badge = resolverBadgeUsuario_(m.usuario);
      const safeId = escapeHtml_(m.id);
      const safeDesc = escapeHtml_(m.descripcion || (m.tipo === 'divisible' ? 'Gasto divisible' : 'Gasto único'));
      return '<div class="flex justify-between items-baseline py-2.5 border-b border-white/10 cursor-pointer hover:opacity-90 transition-opacity" data-audit-tx-id="' + safeId + '" role="button" tabindex="0">' +
        '<div>' +
        '<p class="text-sm font-bold text-[#d31818]">' + safeDesc + ': -' + formatearMoneda_(m.montoPorFecha) + '</p>' +
        '<p class="text-[11px] text-white/80 mt-1 flex items-center gap-1.5">' +
        '<span class="inline-flex w-4 h-4 rounded-full bg-white font-avatar font-bold text-[10px] items-center justify-center shrink-0" style="color: ' + badge.color + ';">' + badge.letter + '</span>' +
        '<span>' + escapeHtml_(badge.user) + '</span></p>' +
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
    resetAppScrollToTop_();
  } else {
    if (modalEl) {
      modalEl.classList.add('hidden');
      modalEl.classList.remove('flex', 'active');
    }
    if (dash) dash.classList.remove('hidden');
    resetAppScrollToTop_();
    maybeApplyPendingSwReload_();
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
    resetAppScrollToTop_();
  } else {
    if (modalEl) {
      modalEl.classList.add('hidden');
      modalEl.classList.remove('flex', 'active');
    }
    if (dash) dash.classList.remove('hidden');
    resetAppScrollToTop_();
    maybeApplyPendingSwReload_();
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
    const excluido = esDiaExcluido_(fecha);
    const gasto = comp.gastosPorFecha[fecha] || 0;
    const disponible = excluido ? 0 : (comp.objetivoBase - gasto);
    const movs = appState.movimientos.filter(m => {
      if (m.fromBag) return false;
      const fechas = normalizarFechas_(m.fechasAfectadas);
      return fechas.includes(fecha);
    });

    let detalle = '';
    if (movs.length) {
      detalle = '<div class="mt-1 space-y-1">' +
        movs.map(m => '<button type="button" data-future-tx-id="' + escapeHtml_(m.id) + '" class="w-full flex justify-between text-xs text-white/80 hover:text-white p-1 rounded transition-colors text-left">' +
          '<span>• ' + escapeHtml_(m.descripcion || 'Gasto') + '</span><span class="font-bold text-[#d31818]">-' + formatearMoneda_(m.montoPorFecha) + '</span></button>').join('') +
        '</div>';
    }

    const subtexto = excluido
      ? (gasto > 0 ? ('Exceptuado · Consumos: ' + formatearMoneda_(gasto)) : 'Sin presupuesto asignado (tarjeta)')
      : (gasto > 0 ? ('Gastados: ' + formatearMoneda_(gasto)) : 'Sin consumos asignados');
    const badgeExcl = excluido
      ? '<span class="ml-1.5 inline-block px-2 py-0.5 rounded-full bg-white/15 text-[10px] font-bold uppercase tracking-wide text-white/90">Exceptuado</span>'
      : '';

    return '<div class="py-2.5 border-b border-white/15' + (excluido ? ' opacity-65' : '') + '">' +
      '<div class="flex justify-between items-baseline gap-2">' +
      '<div><div class="flex items-center flex-wrap"><span class="font-bold text-white text-sm capitalize' + (excluido ? ' line-through' : '') + '">' + formatearFechaLegible_(fecha) + '</span>' + badgeExcl + '</div>' +
      '<span class="text-[11px] text-white/70">' + subtexto + '</span></div>' +
      '<span class="font-bold text-base text-white shrink-0">' + formatearMoneda_(disponible) + '</span></div>' + detalle + '</div>';
  }).join('');
}

// ============================================================
// NAVEGACIÓN ANCLADA A ESTADOS DE PANTALLA (DEFINITIVA)
// ============================================================

let lastBackPressTime = 0;

function pushOverlayStack_(modalId) {
  popOverlayStack_(modalId);
  modalOpenStack_.push(modalId);
}

function popOverlayStack_(modalId) {
  const idx = modalOpenStack_.lastIndexOf(modalId);
  if (idx !== -1) modalOpenStack_.splice(idx, 1);
}

function closeAllActiveModalsWithoutSaving_() {
  toggleHbModal(false);
  toggleBudgetAuditModal(false);
  toggleFutureDaysModal(false);
  setMicroSubView('list', false);

  // Destrucción obligatoria de estado en formularios (Zero-Draft Persistence)
  resetTxForm_();

  const closers = {
    'message-modal': closeMessageModal,
    'shopping-modal': closeShoppingModal,
    'palette-modal': closePaletteModal
  };
  ['message-modal', 'shopping-modal', 'palette-modal'].forEach(id => {
    const el = document.getElementById(id);
    if (el && el.classList.contains('active')) closers[id]();
  });

  const activeModals = document.querySelectorAll('.modal-overlay.active, .modal.active');
  activeModals.forEach(m => {
    if (m && m.id !== 'day-change-modal' && m.id !== 'access-key-modal') m.classList.remove('active');
  });

  const microDash = document.getElementById('micro-dashboard-view');
  if (microDash) microDash.classList.remove('hidden');
  resetAppScrollToTop_();
  maybeApplyPendingSwReload_();
}

function closeTopActiveLayer_() {
  const closers = {
    'message-modal': closeMessageModal,
    'shopping-modal': closeShoppingModal,
    'palette-modal': closePaletteModal
  };

  while (modalOpenStack_.length) {
    const topId = modalOpenStack_[modalOpenStack_.length - 1];
    const el = document.getElementById(topId);
    if (el && el.classList.contains('active')) {
      if (closers[topId]) {
        closers[topId]();
      } else {
        popOverlayStack_(topId);
        el.classList.remove('active');
        resetAppScrollToTop_();
        maybeApplyPendingSwReload_();
      }
      return;
    }
    modalOpenStack_.pop();
  }

  const activeOverlays = Array.from(document.querySelectorAll('.modal-overlay.active, .modal.active'));
  const closable = activeOverlays.filter(m => m && m.id !== 'day-change-modal' && m.id !== 'access-key-modal');
  if (closable.length) {
    const top = closable[closable.length - 1];
    if (top.id && closers[top.id]) {
      closers[top.id]();
    } else {
      top.classList.remove('active');
      resetAppScrollToTop_();
      maybeApplyPendingSwReload_();
    }
    return;
  }

  // No descartar #day-change-modal ni #access-key-modal con Back
  if (activeOverlays.some(m => m && (m.id === 'day-change-modal' || m.id === 'access-key-modal'))) {
    return;
  }

  closeAllActiveModalsWithoutSaving_();
}

function pushModalHistory_(modalId) {
  try {
    if (history && history.state) {
      history.replaceState({ page: 'home_guard', subview: modalId || 'subview' }, '');
    } else {
      history.pushState({ page: 'home_guard', subview: modalId || 'subview' }, '');
    }
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

function intentarSalirAppOBack_(desdePopState) {
  if (navigator.app && navigator.app.exitApp) {
    navigator.app.exitApp();
  } else if (window.App && window.App.exitApp) {
    window.App.exitApp();
  } else if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
    window.Capacitor.Plugins.App.exitApp();
  } else if (desdePopState) {
    history.back();
  }
}

function handleBackNavigationAction_(desdePopState) {
  if (isExitingApp_) return;
  const current = getCurrentScreenState();
  if (current === 'MICRO_HOME') {
    const now = Date.now();
    if (lastBackPressTime > 0 && (now - lastBackPressTime < 2000)) {
      lastBackPressTime = 0;
      isExitingApp_ = true;
      setTimeout(() => { isExitingApp_ = false; }, 1500);
      intentarSalirAppOBack_(desdePopState);
      return;
    }
    lastBackPressTime = now;
    showAppToast('Presioná dos veces seguidas para salir', false, 2000);
    if (desdePopState) {
      try { history.pushState({ page: 'home_guard' }, ''); } catch (err) {}
    }
  } else {
    lastBackPressTime = 0;
    closeTopActiveLayer_();
    if (desdePopState) {
      try { history.pushState({ page: 'home_guard' }, ''); } catch (err) {}
    }
  }
}

function initAndroidBackHistory_() {
  if (typeof history !== 'undefined' && 'scrollRestoration' in history) {
    try { history.scrollRestoration = 'manual'; } catch (e) {}
  }

  // Entrada base + centinela para interceptar Back sin acumular entradas extra
  try {
    if (!history.state || history.state.page !== 'home_guard') {
      if (typeof history.replaceState === 'function') {
        history.replaceState({ page: 'home_root' }, '');
      }
      history.pushState({ page: 'home_guard' }, '');
    }
  } catch (e) {}

  window.addEventListener('popstate', () => handleBackNavigationAction_(true));

  // Escucha de Evento backbutton de Hardware (Android / Cordova / APK / Capacitor)
  document.addEventListener('backbutton', (e) => {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    handleBackNavigationAction_(false);
  }, false);

  // Compatibilidad con Capacitor App Plugin
  if (typeof window !== 'undefined' && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
    try {
      window.Capacitor.Plugins.App.addListener('backButton', () => {
        handleBackNavigationAction_(false);
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
    if (target && target.closest('.days-carousel, #tx-days-carousel, #hb-excluded-days-list, input, select, textarea, button')) {
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

function syncModalOverlayToViewport_(modalId, cardId, vvHeight, vvOffsetTop, isKeyboardOpen) {
  const modal = document.getElementById(modalId);
  const card = document.getElementById(cardId);
  if (!modal) return;
  if (isKeyboardOpen && modal.classList.contains('active')) {
    modal.style.height = vvHeight + 'px';
    modal.style.top = vvOffsetTop + 'px';
    modal.style.bottom = 'auto';
    if (card) card.style.maxHeight = Math.max(200, vvHeight - 24) + 'px';
  } else {
    modal.style.height = '';
    modal.style.top = '';
    modal.style.bottom = '';
    if (card) card.style.maxHeight = '';
  }
}

function ensureMessageModalSendVisible_() {
  const modal = document.getElementById('message-modal');
  const card = document.getElementById('message-modal-card');
  const btn = document.getElementById('btn-send-msg');
  const input = document.getElementById('msg-custom-input');
  if (!modal || !modal.classList.contains('active') || !card) return;
  try {
    if (btn && typeof btn.scrollIntoView === 'function') {
      btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } else if (input && typeof input.scrollIntoView === 'function') {
      input.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    if (btn && typeof btn.getBoundingClientRect === 'function' && typeof card.getBoundingClientRect === 'function') {
      const btnRect = btn.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      if (btnRect.bottom > cardRect.bottom - 8) {
        card.scrollTop += (btnRect.bottom - cardRect.bottom + 14);
      }
    } else if (typeof card.scrollHeight === 'number' && typeof card.clientHeight === 'number') {
      card.scrollTop = Math.max(0, card.scrollHeight - card.clientHeight);
    }
  } catch (e) {}
}

/** Mantiene barras flotantes y modales alineados con el viewport y el teclado virtual. */
function updateFloatingCircleButtonsPosition() {
  const bars = document.querySelectorAll('.floating-actions-bar');
  const winH = typeof window.innerHeight === 'number' && window.innerHeight > 0 ? window.innerHeight : 800;
  const vv = window.visualViewport;
  const vvHeight = vv && typeof vv.height === 'number' ? vv.height : winH;
  const vvOffsetTop = vv && typeof vv.offsetTop === 'number' ? vv.offsetTop : 0;
  const vvBottom = vvHeight + vvOffsetTop;
  const keyboardInset = Math.max(0, Math.round(winH - vvBottom));
  const isKeyboardOpen = keyboardInset > 60;

  if (bars.length) {
    const appViewport = document.getElementById('app-viewport');
    const appRect = appViewport && typeof appViewport.getBoundingClientRect === 'function'
      ? appViewport.getBoundingClientRect()
      : null;

    let visibleBottom = Math.min(winH, vvBottom);
    if (appRect && appRect.bottom > 0) {
      visibleBottom = Math.min(visibleBottom, appRect.bottom);
      visibleBottom = Math.max(visibleBottom, appRect.top + 88);
    }

    const bottomOffset = Math.max(20, Math.round(winH - visibleBottom + 20));
    const bottomValue = bottomOffset <= 20
      ? 'calc(20px + env(safe-area-inset-bottom, 0px))'
      : `${bottomOffset}px`;

    bars.forEach(bar => {
      bar.style.bottom = bottomValue;
    });
  }

  syncModalOverlayToViewport_('message-modal', 'message-modal-card', vvHeight, vvOffsetTop, isKeyboardOpen);
  syncModalOverlayToViewport_('shopping-modal', 'shopping-modal-card', vvHeight, vvOffsetTop, isKeyboardOpen);
  syncModalOverlayToViewport_('access-key-modal', 'access-key-modal-card', vvHeight, vvOffsetTop, isKeyboardOpen);

  if (isKeyboardOpen && document.activeElement && document.activeElement.id === 'msg-custom-input') {
    ensureMessageModalSendVisible_();
  }

  if (wasKeyboardOpen_ && !isKeyboardOpen) {
    try {
      if (typeof window.scrollTo === 'function') window.scrollTo(0, 0);
      if (document.documentElement) document.documentElement.scrollTop = 0;
      if (document.body) document.body.scrollTop = 0;
      const appViewportEl = document.getElementById('app-viewport');
      if (appViewportEl) appViewportEl.scrollTop = 0;
    } catch (e) {}
  }
  wasKeyboardOpen_ = isKeyboardOpen;
}

function aplicarScrollCeroInmediato_() {
  try {
    if (typeof window.scrollTo === 'function') {
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    }
  } catch (e) {
    try { window.scrollTo(0, 0); } catch (_) {}
  }
  try {
    if (document.documentElement) document.documentElement.scrollTop = 0;
    if (document.body) document.body.scrollTop = 0;
  } catch (e) {}
  ['app-viewport', 'micro-panel-list', 'view-micro'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.scrollTop = 0;
  });
  try {
    document.querySelectorAll('.card-dark-main').forEach(el => {
      el.scrollTop = 0;
    });
  } catch (e) {}
  updateFloatingCircleButtonsPosition();
}

function resetAppScrollToTop_() {
  aplicarScrollCeroInmediato_();
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => aplicarScrollCeroInmediato_());
  }
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

function normalizarDiasRestantesLocal_(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  raw.forEach(f => {
    const iso = String(f || '').trim();
    if (esFechaCalendarioValidaLocal_(iso) && !seen.has(iso)) {
      seen.add(iso);
      out.push(iso);
    }
  });
  return out.sort();
}

function normalizarMovimientosLocal_(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(m => m && typeof m === 'object')
    .map(m => Object.assign({}, m, {
      monto: Number.isFinite(Number(m.monto)) ? Number(m.monto) : 0,
      montoPorFecha: Number.isFinite(Number(m.montoPorFecha)) ? Number(m.montoPorFecha) : 0,
      fechasAfectadas: normalizarFechas_(m.fechasAfectadas),
      usuario: normalizarUsuarioLocal_(m.usuario, appState.activeUser || 'Brian'),
      fromBag: !!m.fromBag
    }));
}

function cargarCacheDiarioLocal_() {
  try {
    const cached = localStorage.getItem('cached_diario_state');
    if (!cached) return false;
    const parsed = JSON.parse(cached);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    if (parsed.homeBankingTotal !== undefined && Number.isFinite(Number(parsed.homeBankingTotal))) {
      appState.homeBankingTotal = Number(parsed.homeBankingTotal);
    }
    if (parsed.bolsaTotal !== undefined && Number.isFinite(Number(parsed.bolsaTotal))) {
      appState.bolsaTotal = Number(parsed.bolsaTotal);
    }
    if (parsed.diaCobro !== undefined) appState.diaCobro = parsed.diaCobro;
    if (Array.isArray(parsed.diasRestantes)) appState.diasRestantes = normalizarDiasRestantesLocal_(parsed.diasRestantes);
    if (Array.isArray(parsed.diasExcluidos)) appState.diasExcluidos = normalizarDiasExcluidosLocal_(parsed.diasExcluidos);
    if (Array.isArray(parsed.movimientos)) appState.movimientos = normalizarMovimientosLocal_(parsed.movimientos);
    if (Array.isArray(parsed.listaCompras)) appState.listaCompras = normalizarListaCompras_(parsed.listaCompras);
    if (parsed.lastProcessedDate !== undefined) appState.lastProcessedDate = normalizarFechaConfig_(parsed.lastProcessedDate, hoyISO_());
    if (parsed.whatsappConfigured !== undefined) appState.whatsappConfigured = !!parsed.whatsappConfigured;
    return true;
  } catch (e) {
    return false;
  }
}

function aplicarEstadoDiario_(data) {
  if (!data || typeof data !== 'object') return;
  if (Number.isFinite(Number(data.homeBankingTotal))) appState.homeBankingTotal = Number(data.homeBankingTotal);
  if (Number.isFinite(Number(data.bolsaTotal))) appState.bolsaTotal = Number(data.bolsaTotal);
  appState.diaCobro = data.diaCobro;
  appState.diasRestantes = normalizarDiasRestantesLocal_(data.diasRestantes);
  appState.diasExcluidos = normalizarDiasExcluidosLocal_(data.diasExcluidos);
  appState.movimientos = normalizarMovimientosLocal_(data.movimientos);
  if (Array.isArray(data.listaCompras) && !hasPendingShoppingBatch_() && !hasQueuedShoppingSync_()) {
    appState.listaCompras = normalizarListaCompras_(data.listaCompras);
  }
  appState.lastProcessedDate = normalizarFechaConfig_(data.lastProcessedDate, hoyISO_());
  appState.whatsappConfigured = !!data.whatsappConfigured;
  guardarCacheDiarioLocal_();
  renderMicroView();
  refrescarVistaHbModalSiAbierto_();
  actualizarBadgeListaCompras_();
  const shoppingModal = document.getElementById('shopping-modal');
  if (shoppingModal && shoppingModal.classList.contains('active')) {
    renderShoppingList_();
  }
}

async function recargarEstadoDiario_(conToast) {
  if (authPaused_ || !getStoredAccessKey_() || pendingSyncCount > 0 || getPendingSyncQueue_().length > 0 || hasPendingShoppingBatch_()) return;
  const miToken = ++diarioLoadToken_;
  try {
    if (!appState.lastProcessedDate && miToken === diarioLoadToken_ && cargarCacheDiarioLocal_()) {
      renderMicroView();
    }
  } catch (e) {}

  try {
    const data = conToast === false ? await callBackend('getEstadoDiario', {}) : await callBackendConSync('getEstadoDiario', {});
    if (miToken !== diarioLoadToken_ || pendingSyncCount > 0 || getPendingSyncQueue_().length > 0 || hasPendingShoppingBatch_()) return;
    aplicarEstadoDiario_(data);
  } catch (err) {
    if (miToken === diarioLoadToken_) {
      console.error('Error al recargar estado diario:', err);
    }
  }
}

async function manualRefreshDiario_() {
  if (isManualRefreshing_) return false;
  isManualRefreshing_ = true;
  try {
    if (!getStoredAccessKey_() || authPaused_) {
      openAccessKeyModal_('Ingresá tu clave de acceso para actualizar.');
      return false;
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      showAppToast('Sin conexión a internet', true);
      return false;
    }

    if (hasPendingShoppingBatch_()) {
      await flushShoppingBatch_('manual_refresh');
    }
    if (getPendingSyncQueue_().length > 0) {
      await processPendingSyncQueue_();
    }
    if (authPaused_ || getPendingSyncQueue_().length > 0 || hasPendingShoppingBatch_()) {
      showAppToast('Quedan cambios pendientes de sincronizar', true);
      return false;
    }

    if (swRegistration_ && typeof swRegistration_.update === 'function') {
      swRegistration_.update().catch(() => {});
    }

    const miToken = ++diarioLoadToken_;
    const data = await callBackend('getEstadoDiario', {}, { maxRetries: 1, timeoutMs: 15000 });
    if (
      miToken !== diarioLoadToken_ ||
      authPaused_ ||
      pendingSyncCount > 0 ||
      getPendingSyncQueue_().length > 0 ||
      hasPendingShoppingBatch_()
    ) {
      return false;
    }
    aplicarEstadoDiario_(data);
    try {
      await chequearCierreDia_();
    } catch (e) {
      console.error('Error al chequear el cierre de día tras actualizar:', e);
    }
    showAppToast('Actualizado', false, 1800);
    return true;
  } catch (err) {
    console.error('Error en actualización manual:', err);
    if (!isAuthError_(err)) {
      showAppToast('No se pudo actualizar. Intentá de nuevo.', true);
    }
    return false;
  } finally {
    isManualRefreshing_ = false;
  }
}

async function bootstrapEstado_() {
  if (isAppFramed_()) return;
  if (!getStoredAccessKey_()) {
    authPaused_ = true;
    purgarCacheLecturaYEstadoMemoria_();
    openAccessKeyModal_('Ingresá tu clave de acceso para sincronizar.');
    return;
  }

  const miToken = ++diarioLoadToken_;
  try {
    if (miToken === diarioLoadToken_ && cargarCacheDiarioLocal_()) {
      renderMicroView();
      actualizarBadgeListaCompras_();
    }
  } catch (e) {}

  enqueuePendingShoppingDraftForRecovery_();

  if (getPendingSyncQueue_().length > 0) {
    await processPendingSyncQueue_();
    if (authPaused_ || getPendingSyncQueue_().length > 0) return;
  }

  try {
    const data = await callBackendConSync('getEstadoDiario', {});
    if (miToken !== diarioLoadToken_ || authPaused_ || getPendingSyncQueue_().length > 0 || hasPendingShoppingBatch_()) return;
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
}

window.diagnosticarBackend = async function() {
  console.log('--- DIAGNÓSTICO DE CONEXIÓN CON GOOGLE APPS SCRIPT ---');
  try {
    const diario = await callBackendConSync('getEstadoDiario', {});
    const resumen = {
      ok: true,
      movimientos: Array.isArray(diario && diario.movimientos) ? diario.movimientos.length : 0,
      listaCompras: Array.isArray(diario && diario.listaCompras) ? diario.listaCompras.length : 0,
      whatsappConfigured: Boolean(diario && diario.whatsappConfigured)
    };
    console.log('✅ getEstadoDiario OK:', resumen);
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
  if (authPaused_ || !getStoredAccessKey_()) {
    showAppToast('Desbloqueá la aplicación antes de exportar un respaldo', true);
    return null;
  }
  const respaldo = {
    version: 'multimillonarios-diario',
    exportDate: new Date().toISOString(),
    appState: appState,
    configLocal: {
      activeUser: appState.activeUser
    },
    localStorage: {}
  };

  const BACKUP_STORAGE_ALLOWLIST = [
    'userActive',
    'userPalette_Brian',
    'userPalette_Virginia',
    'userPaletteVars_Brian',
    'userPaletteVars_Virginia',
    'cached_diario_state',
    'pending_sync_queue',
    'shopping_draft_batch'
  ];

  try {
    BACKUP_STORAGE_ALLOWLIST.forEach(key => {
      const rawVal = localStorage.getItem(key);
      if (rawVal === null) return;
      try {
        respaldo.localStorage[key] = JSON.parse(rawVal);
      } catch (e) {
        respaldo.localStorage[key] = rawVal;
      }
    });
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
// MENSAJES DE PAREJA VÍA WHATSAPP
// ============================================================

function getOtroUsuario_(usuario) {
  return usuario === 'Virginia' ? 'Brian' : 'Virginia';
}

function openMessageModal() {
  const modal = document.getElementById('message-modal');
  if (!modal) return;
  const titleEl = document.getElementById('msg-modal-title');
  const para = getOtroUsuario_(appState.activeUser);
  if (titleEl) titleEl.textContent = '💌 Mensajito para ' + para;

  modal.classList.add('active');
  pushOverlayStack_('message-modal');
  pushModalHistory_('message-modal');
  updateFloatingCircleButtonsPosition();
}

function closeMessageModal() {
  popOverlayStack_('message-modal');
  const msgInput = document.getElementById('msg-custom-input');
  if (msgInput && typeof msgInput.blur === 'function') msgInput.blur();
  const modal = document.getElementById('message-modal');
  if (modal) modal.classList.remove('active');
  updateFloatingCircleButtonsPosition();
  resetAppScrollToTop_();
  maybeApplyPendingSwReload_();
}

function seleccionarMensajeRapido(idx) {
  const texto = PRESET_COUPLE_MESSAGES[idx];
  const input = document.getElementById('msg-custom-input');
  if (!texto || !input) return;
  input.value = texto;
  input.focus();
  ensureMessageModalSendVisible_();
  setTimeout(ensureMessageModalSendVisible_, 180);
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
  ensureMessageModalSendVisible_();
}

async function enviarMensajePareja() {
  const input = document.getElementById('msg-custom-input');
  const btn = document.getElementById('btn-send-msg');
  const limpio = String(input ? input.value : '').trim().slice(0, 500);
  if (!limpio) {
    if (input) input.focus();
    showAppToast('Escribí o elegí un mensajito primero', true);
    return false;
  }

  const de = appState.activeUser;
  const para = getOtroUsuario_(de);
  const payload = { texto: limpio, de: de, para: para };

  const finalizarEnvioUI = () => {
    if (input) input.value = '';
    closeMessageModal();
  };

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    callBackendBackground('enviarMensaje', payload);
    finalizarEnvioUI();
    return true;
  }

  const textoPrevio = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Enviando...';
  }

  try {
    const res = await callBackend('enviarMensaje', payload);
    finalizarEnvioUI();
    const wa = res && res.whatsapp ? res.whatsapp : null;
    if (wa && wa.sent) {
      showAppToast('💬 Enviado al grupo de WhatsApp');
    } else if (wa && wa.reason === 'missing_greenapi_config') {
      showAppToast('Falta configurar Green API en la hoja Config', true);
    } else {
      showAppToast('No se pudo enviar al grupo de WhatsApp', true);
    }
    return true;
  } catch (err) {
    if (isAuthError_(err)) {
      return false;
    }
    if (isRetryableBackendError_(err)) {
      callBackendBackground('enviarMensaje', payload);
      finalizarEnvioUI();
      return true;
    }
    showAppToast(err && err.message ? err.message : 'No se pudo enviar el mensaje', true);
    return false;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = textoPrevio;
    }
  }
}

async function enviarListaComprasWhatsApp() {
  const btn = document.getElementById('btn-send-shopping-wa');
  const payload = { de: appState.activeUser };

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    if (hasPendingShoppingBatch_()) {
      await flushShoppingBatch_('whatsapp_send_list');
    }
    callBackendBackground('enviarListaComprasWhatsApp', payload);
    closeMessageModal();
    return true;
  }

  const textoPrevio = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Enviando lista...';
  }

  try {
    if (hasPendingShoppingBatch_()) {
      await flushShoppingBatch_('whatsapp_send_list');
    }
    if (getPendingSyncQueue_().length > 0 && !authPaused_ && getStoredAccessKey_()) {
      await processPendingSyncQueue_();
    }
    const res = await callBackend('enviarListaComprasWhatsApp', payload);
    closeMessageModal();
    const wa = res && res.whatsapp ? res.whatsapp : null;
    if (wa && wa.sent) {
      showAppToast('🛒 Lista de compras enviada al grupo de WhatsApp');
    } else if (wa && wa.reason === 'missing_greenapi_config') {
      showAppToast('Falta configurar Green API', true);
    } else {
      showAppToast('No se pudo enviar al grupo de WhatsApp', true);
    }
    return true;
  } catch (err) {
    if (isAuthError_(err)) {
      return false;
    }
    if (isRetryableBackendError_(err)) {
      callBackendBackground('enviarListaComprasWhatsApp', payload);
      closeMessageModal();
      return true;
    }
    showAppToast(err && err.message ? err.message : 'No se pudo enviar la lista de compras', true);
    return false;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = textoPrevio;
    }
  }
}

function solicitarRecargaSuave_() {
  if (isAppFramed_() || authPaused_ || !getStoredAccessKey_()) return;
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  if (hasPendingShoppingBatch_()) return;
  if (pendingSyncCount === 0 && getPendingSyncQueue_().length > 0 && !isProcessingSyncQueue_ && !authPaused_ && getStoredAccessKey_()) {
    processPendingSyncQueue_()
      .then(() => {
        if (!authPaused_ && getPendingSyncQueue_().length === 0 && !hasPendingShoppingBatch_()) {
          return recargarEstadoDiario_(false);
        }
      })
      .catch(() => {});
    return;
  }
  if (pendingSyncCount > 0 || getPendingSyncQueue_().length > 0 || isReloadingDiario_) return;
  const now = Date.now();
  if (now - lastAutoReloadTs_ < 8000) return;

  lastAutoReloadTs_ = now;
  isReloadingDiario_ = true;
  recargarEstadoDiario_(false).finally(() => {
    isReloadingDiario_ = false;
  });
}

function initAutoSyncRefresh_() {
  if (autoSyncTimer_) clearInterval(autoSyncTimer_);
  autoSyncTimer_ = setInterval(() => {
    solicitarRecargaSuave_();
  }, 120000);

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        flushShoppingBatch_('visibility_hidden', { useKeepalive: true });
      } else {
        solicitarRecargaSuave_();
      }
    });
  }

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('pagehide', () => {
      flushShoppingBatch_('pagehide', { useKeepalive: true });
    });
  }
}

// ============================================================
// LISTA DE COMPRAS / PENDIENTES (COMPARTIDA, SIN IMPACTO EN SALDOS)
// ============================================================

function escapeHtml_(str) {
  return String(str || '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

function normalizarListaCompras_(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(it => {
    if (!it || typeof it !== 'object') return null;
    const id = String(it.id || '').trim();
    const texto = String(it.texto || '')
      .replace(/[\r\n\t]+/g, ' ')
      .trim()
      .slice(0, 120)
      .replace(/^[\s=+\-@]+/, '')
      .trim();
    if (!id || !texto) return null;
    return {
      id: id,
      texto: texto,
      done: !!it.done,
      autor: normalizarUsuarioLocal_(String(it.autor || '').trim(), 'Brian'),
      creadoEn: String(it.creadoEn || '')
    };
  }).filter(Boolean);
}

function actualizarBadgeListaCompras_() {
  const badge = document.getElementById('shopping-pending-badge');
  if (!badge) return;
  const pendientes = (appState.listaCompras || []).filter(it => !it.done).length;
  if (pendientes > 0) {
    badge.textContent = pendientes > 99 ? '99+' : String(pendientes);
    badge.classList.remove('hidden');
  } else {
    badge.textContent = '0';
    badge.classList.add('hidden');
  }
}

function renderShoppingList_() {
  const cont = document.getElementById('shopping-list-container');
  const summaryEl = document.getElementById('shopping-summary-text');
  const clearBtn = document.getElementById('btn-clear-shopping-done');
  if (!cont) return;

  const lista = normalizarListaCompras_(appState.listaCompras);
  appState.listaCompras = lista;
  const pendientes = lista.filter(it => !it.done);
  const comprados = lista.filter(it => it.done);

  if (summaryEl) {
    if (!lista.length) {
      summaryEl.textContent = 'Lista vacía';
    } else if (!pendientes.length) {
      summaryEl.textContent = '¡Todo comprado! (' + comprados.length + ')';
    } else {
      summaryEl.textContent = pendientes.length + (pendientes.length === 1 ? ' pendiente' : ' pendientes') +
        (comprados.length ? ' · ' + comprados.length + (comprados.length === 1 ? ' comprado' : ' comprados') : '');
    }
  }
  if (clearBtn) clearBtn.classList.toggle('hidden', comprados.length === 0);

  if (!lista.length) {
    cont.innerHTML = '<div class="text-center py-8 text-xs text-zinc-400 font-medium">No hay productos cargados.<br>Escribí arriba para agregar el primero.</div>';
    actualizarBadgeListaCompras_();
    return;
  }

  const ordenados = [...pendientes, ...comprados];
  cont.innerHTML = ordenados.map(it => {
    const safeId = escapeHtml_(it.id);
    const safeTexto = escapeHtml_(it.texto);
    const autorBadge = resolverBadgeUsuario_(it.autor);
    return '<div class="shopping-item-row' + (it.done ? ' done' : '') + '">' +
      '<button type="button" data-toggle-shop-id="' + safeId + '" class="flex items-center gap-2.5 flex-1 min-w-0 text-left">' +
        '<span class="shopping-check-circle" aria-hidden="true">' + (it.done ? '✓' : '') + '</span>' +
        '<span class="shopping-item-text flex-1 min-w-0">' + safeTexto + '</span>' +
      '</button>' +
      '<span class="w-5 h-5 rounded-full bg-white border border-zinc-200 font-avatar font-bold text-[10px] flex items-center justify-center shrink-0" style="color: ' + autorBadge.color + ';" title="' + escapeHtml_(autorBadge.user) + '">' + autorBadge.letter + '</span>' +
      '<button type="button" data-delete-shop-id="' + safeId + '" class="text-zinc-400 hover:text-rose-600 text-xs font-bold px-1.5 py-1 shrink-0" aria-label="Eliminar ítem">✕</button>' +
    '</div>';
  }).join('');

  actualizarBadgeListaCompras_();
}

const SHOPPING_DRAFT_KEY = 'shopping_draft_batch';

function normalizarInitialDoneMap_(rawObj) {
  const map = Object.create(null);
  if (rawObj && typeof rawObj === 'object' && !Array.isArray(rawObj)) {
    Object.keys(rawObj).forEach(k => {
      if (typeof k === 'string' && k) {
        map[k] = !!rawObj[k];
      }
    });
  }
  return map;
}

function loadShoppingDraft_() {
  try {
    const raw = localStorage.getItem(SHOPPING_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.ops)) return null;
    return {
      usuario: normalizarUsuarioLocal_(parsed.usuario, appState.activeUser || 'Brian'),
      initialDoneById: normalizarInitialDoneMap_(parsed.initialDoneById),
      ops: parsed.ops
    };
  } catch (e) {
    return null;
  }
}

function saveShoppingDraft_(draft) {
  try {
    if (!draft || !Array.isArray(draft.ops) || !draft.ops.length) {
      localStorage.removeItem(SHOPPING_DRAFT_KEY);
      return;
    }
    localStorage.setItem(SHOPPING_DRAFT_KEY, JSON.stringify({
      usuario: normalizarUsuarioLocal_(draft.usuario, appState.activeUser || 'Brian'),
      initialDoneById: draft.initialDoneById || {},
      ops: draft.ops
    }));
  } catch (e) {}
}

function clearShoppingDraft_() {
  try {
    localStorage.removeItem(SHOPPING_DRAFT_KEY);
  } catch (e) {}
}

function hasPendingShoppingBatch_() {
  const draft = loadShoppingDraft_();
  return !!(draft && draft.ops.length > 0);
}

function hasQueuedShoppingSync_() {
  return getPendingSyncQueue_().some(it => it && it.action === 'guardarListaCompras');
}

function ensureShoppingDraft_() {
  const existing = loadShoppingDraft_();
  if (existing) {
    existing.usuario = normalizarUsuarioLocal_(appState.activeUser, existing.usuario || 'Brian');
    return existing;
  }
  return {
    usuario: appState.activeUser || 'Brian',
    initialDoneById: Object.create(null),
    ops: []
  };
}

function generarIdShoppingBatch_() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return 'shpb_' + crypto.randomUUID();
  }
  return 'shpb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
}

function compileShoppingBatchPayload_(draft) {
  if (!draft || !Array.isArray(draft.ops) || !draft.ops.length) return null;
  return {
    op: 'batch',
    batchId: generarIdShoppingBatch_(),
    usuario: normalizarUsuarioLocal_(draft.usuario, appState.activeUser || 'Brian'),
    ops: draft.ops.slice(0, 50)
  };
}

function enqueuePendingShoppingDraftForRecovery_() {
  const draft = loadShoppingDraft_();
  if (!draft || !draft.ops.length) {
    clearShoppingDraft_();
    return false;
  }
  const batchPayload = compileShoppingBatchPayload_(draft);
  clearShoppingDraft_();
  if (!batchPayload) return false;
  enqueuePendingSync_('guardarListaCompras', batchPayload);
  return true;
}

function aplicarListaServidorSiLimpia_(res) {
  if (
    res &&
    Array.isArray(res.listaCompras) &&
    !hasPendingShoppingBatch_() &&
    !hasQueuedShoppingSync_()
  ) {
    appState.listaCompras = normalizarListaCompras_(res.listaCompras);
    guardarCacheDiarioLocal_();
    actualizarBadgeListaCompras_();
    const modal = document.getElementById('shopping-modal');
    if (modal && modal.classList.contains('active')) renderShoppingList_();
  }
}

function flushShoppingBatch_(_trigger, opts) {
  if (isAppFramed_() || authPaused_ || !getStoredAccessKey_()) {
    return Promise.resolve(null);
  }
  const draft = loadShoppingDraft_();
  if (!draft || !draft.ops.length) {
    clearShoppingDraft_();
    return Promise.resolve(null);
  }
  const batchPayload = compileShoppingBatchPayload_(draft);
  clearShoppingDraft_();
  if (!batchPayload) return Promise.resolve(null);

  const useKeepalive = !!(opts && opts.useKeepalive);
  if (useKeepalive) {
    const accessKey = getStoredAccessKey_();
    const queueBefore = getPendingSyncQueue_().length;
    const syncId = enqueuePendingSync_('guardarListaCompras', batchPayload);
    const bodyStr = accessKey
      ? JSON.stringify({ action: 'guardarListaCompras', payload: batchPayload, accessKey: accessKey })
      : '';
    if (
      accessKey &&
      !authPaused_ &&
      (typeof navigator === 'undefined' || navigator.onLine !== false) &&
      queueBefore === 0 &&
      pendingSyncCount === 0 &&
      !isProcessingSyncQueue_ &&
      bodyStr.length > 0 &&
      bodyStr.length <= 50000 &&
      typeof fetch === 'function'
    ) {
      try {
        return fetch(BACKEND_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: bodyStr,
          keepalive: true
        })
          .then(res => (res && res.ok ? res.json() : null))
          .then(json => {
            if (json && json.ok) {
              savePendingSyncQueue_(getPendingSyncQueue_().filter(x => x.id !== syncId));
              if (json.data) aplicarListaServidorSiLimpia_(json.data);
              return json.data || null;
            }
            return null;
          })
          .catch(() => null);
      } catch (e) {
        return Promise.resolve(null);
      }
    }
    return Promise.resolve(null);
  }

  ++diarioLoadToken_;
  return callBackendBackground('guardarListaCompras', batchPayload)
    .then(res => {
      if (res) aplicarListaServidorSiLimpia_(res);
      return res;
    })
    .catch(err => {
      console.error('Error sincronizando lote de lista de compras:', err);
      return null;
    });
}

function openShoppingModal() {
  const modal = document.getElementById('shopping-modal');
  if (!modal) return;
  renderShoppingList_();
  modal.classList.add('active');
  pushOverlayStack_('shopping-modal');
  pushModalHistory_('shopping-modal');
  updateFloatingCircleButtonsPosition();
}

function closeShoppingModal() {
  popOverlayStack_('shopping-modal');
  const shoppingInput = document.getElementById('shopping-item-input');
  if (shoppingInput && typeof shoppingInput.blur === 'function') shoppingInput.blur();
  const modal = document.getElementById('shopping-modal');
  if (modal) modal.classList.remove('active');
  updateFloatingCircleButtonsPosition();
  resetAppScrollToTop_();
  if (hasPendingShoppingBatch_()) {
    flushShoppingBatch_('modal_close');
  }
  maybeApplyPendingSwReload_();
}

function agregarItemListaCompras() {
  const input = document.getElementById('shopping-item-input');
  const texto = String(input ? input.value : '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 120)
    .replace(/^[\s=+\-@]+/, '')
    .trim();
  if (!texto) {
    if (input) input.focus();
    showAppToast('Escribí un producto o pendiente primero', true);
    return;
  }

  const nuevo = {
    id: 'shp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    texto: texto,
    done: false,
    autor: appState.activeUser || 'Brian',
    creadoEn: new Date().toISOString()
  };

  appState.listaCompras = [nuevo, ...normalizarListaCompras_(appState.listaCompras)];
  if (input) {
    input.value = '';
    input.focus();
  }
  guardarCacheDiarioLocal_();
  renderShoppingList_();

  const draft = ensureShoppingDraft_();
  draft.ops.push({ op: 'add', item: nuevo });
  saveShoppingDraft_(draft);
  if (draft.ops.length >= 45) flushShoppingBatch_('batch_cap');
}

function toggleItemListaCompras(id) {
  const targetId = String(id || '').trim();
  const item = (appState.listaCompras || []).find(it => String(it.id) === targetId);
  if (!item) return;

  const prevDone = !!item.done;
  item.done = !prevDone;
  guardarCacheDiarioLocal_();
  renderShoppingList_();

  const draft = ensureShoppingDraft_();
  let lastClearIdx = -1;
  for (let i = draft.ops.length - 1; i >= 0; i--) {
    if (draft.ops[i].op === 'clearDone') {
      lastClearIdx = i;
      break;
    }
  }
  const addIdx = draft.ops.findIndex(o => o.op === 'add' && o.item && String(o.item.id) === targetId);
  if (addIdx !== -1 && addIdx > lastClearIdx) {
    draft.ops[addIdx].item.done = item.done;
  } else {
    if (!Object.prototype.hasOwnProperty.call(draft.initialDoneById, targetId)) {
      draft.initialDoneById[targetId] = prevDone;
    }
    let existingToggleIdx = -1;
    for (let i = draft.ops.length - 1; i > lastClearIdx; i--) {
      if (draft.ops[i].op === 'toggle' && String(draft.ops[i].id) === targetId) {
        existingToggleIdx = i;
        break;
      }
    }
    if (existingToggleIdx !== -1) {
      if (item.done === !!draft.initialDoneById[targetId]) {
        draft.ops.splice(existingToggleIdx, 1);
      } else {
        draft.ops[existingToggleIdx].done = item.done;
      }
    } else {
      draft.ops.push({ op: 'toggle', id: targetId, done: item.done });
    }
  }
  saveShoppingDraft_(draft);
  if (draft.ops.length >= 45) flushShoppingBatch_('batch_cap');
}

function eliminarItemListaCompras(id) {
  const targetId = String(id || '').trim();
  const prevItem = (appState.listaCompras || []).find(it => String(it.id) === targetId);
  if (!prevItem) return;

  appState.listaCompras = (appState.listaCompras || []).filter(it => String(it.id) !== targetId);
  guardarCacheDiarioLocal_();
  renderShoppingList_();

  const draft = ensureShoppingDraft_();
  const addIdx = draft.ops.findIndex(o => o.op === 'add' && o.item && String(o.item.id) === targetId);
  if (addIdx !== -1) {
    draft.ops = draft.ops.filter(o => {
      if (o.op === 'add' && o.item && String(o.item.id) === targetId) return false;
      if ((o.op === 'toggle' || o.op === 'delete') && String(o.id) === targetId) return false;
      return true;
    });
  } else {
    if (!Object.prototype.hasOwnProperty.call(draft.initialDoneById, targetId)) {
      draft.initialDoneById[targetId] = !!prevItem.done;
    }
    let lastClearIdx = -1;
    for (let i = draft.ops.length - 1; i >= 0; i--) {
      if (draft.ops[i].op === 'clearDone') {
        lastClearIdx = i;
        break;
      }
    }
    draft.ops = draft.ops.filter((o, idx) => !(idx > lastClearIdx && o.op === 'toggle' && String(o.id) === targetId));
    draft.ops.push({ op: 'delete', id: targetId });
  }
  saveShoppingDraft_(draft);
  if (draft.ops.length >= 45) flushShoppingBatch_('batch_cap');
}

function limpiarCompradosListaCompras() {
  const clearedItems = (appState.listaCompras || []).filter(it => it.done);
  if (!clearedItems.length) return;

  const clearedIds = new Set(clearedItems.map(it => String(it.id)));
  appState.listaCompras = (appState.listaCompras || []).filter(it => !it.done);
  guardarCacheDiarioLocal_();
  renderShoppingList_();
  showAppToast('🧹 Comprados eliminados de la lista');

  const draft = ensureShoppingDraft_();
  const preExistingIdsCleared = [];
  clearedItems.forEach(it => {
    const cid = String(it.id);
    const addedInSession = draft.ops.some(o => o.op === 'add' && o.item && String(o.item.id) === cid);
    if (addedInSession) {
      draft.ops = draft.ops.filter(o => {
        if (o.op === 'add' && o.item && String(o.item.id) === cid) return false;
        if (o.op === 'toggle' && String(o.id) === cid) return false;
        return true;
      });
    } else {
      if (!Object.prototype.hasOwnProperty.call(draft.initialDoneById, cid)) {
        draft.initialDoneById[cid] = true;
      }
      preExistingIdsCleared.push(cid);
    }
  });

  if (preExistingIdsCleared.length > 0 && (draft.ops.length === 0 || draft.ops[draft.ops.length - 1].op !== 'clearDone')) {
    draft.ops.push({ op: 'clearDone' });
  }
  if (!draft.ops.length && clearedIds.size > 0) {
    clearShoppingDraft_();
  } else {
    saveShoppingDraft_(draft);
  }
  if (draft.ops.length >= 45) flushShoppingBatch_('batch_cap');
}

if (typeof history !== 'undefined' && 'scrollRestoration' in history) {
  try { history.scrollRestoration = 'manual'; } catch (e) {}
}

let isUiDelegationBound_ = false;
let isSwRegistered_ = false;
let swRegistration_ = null;
let pendingSwReload_ = false;
let isManualRefreshing_ = false;
let ptrSuppressClickUntil_ = 0;

function shouldDeferSwReload_() {
  const keyModal = document.getElementById('access-key-modal');
  if (keyModal && keyModal.classList.contains('active')) return true;
  if (getCurrentScreenState() !== 'MICRO_HOME') return true;
  if (
    pendingSyncCount > 0 ||
    isProcessingSyncQueue_ ||
    getPendingSyncQueue_().length > 0 ||
    hasPendingShoppingBatch_()
  ) {
    return true;
  }
  return false;
}

function executeSwReload_() {
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem('app_skip_splash_once', '1');
    }
  } catch (e) {}
  try {
    if (typeof window !== 'undefined' && window.location && typeof window.location.reload === 'function') {
      window.location.reload();
    }
  } catch (e) {}
}

function maybeApplyPendingSwReload_() {
  if (!pendingSwReload_) return false;
  if (shouldDeferSwReload_()) return false;
  pendingSwReload_ = false;
  executeSwReload_();
  return true;
}

function dispatchUiAction_(action, arg, triggerEl) {
  if (authPaused_ || !getStoredAccessKey_()) return;
  const handlers = {
    'open-shopping-modal': () => openShoppingModal(),
    'open-message-modal': () => openMessageModal(),
    'open-budget-audit': () => openBudgetAuditModal(arg),
    'open-hb-modal': () => toggleHbModal(true),
    'open-future-days-modal': () => toggleFutureDaysModal(true),
    'set-micro-subview': () => setMicroSubView(arg),
    'set-tx-subtype': () => setTxSubtype(arg),
    'scroll-days-carousel': () => scrollDaysCarousel(Number(arg)),
    'scroll-hb-days-carousel': () => scrollDaysCarousel(Number(arg), 'hb-excluded-days-list'),
    'delete-editing-tx': () => deleteCurrentEditingTransaction(),
    'submit-tx-form': () => handleFormSubmit(),
    'vaciar-bolsa-ahorro': () => handleVaciarBolsaAhorro(),
    'close-hb-modal': () => toggleHbModal(false),
    'save-hb-amount': () => saveHbAmount(),
    'close-budget-audit': () => toggleBudgetAuditModal(false),
    'close-future-days-modal': () => toggleFutureDaysModal(false),
    'resolve-day-change': () => resolveDayChange(arg),
    'close-palette-modal': () => closePaletteModal(),
    'close-message-modal': () => closeMessageModal(),
    'select-quick-msg': () => seleccionarMensajeRapido(Number(arg)),
    'send-quick-msg': () => enviarMensajeRapido(Number(arg)),
    'send-shopping-whatsapp': () => enviarListaComprasWhatsApp(),
    'send-custom-msg': () => enviarMensajePareja(),
    'close-shopping-modal': () => closeShoppingModal(),
    'add-shopping-item': () => agregarItemListaCompras(),
    'clear-checked-shopping': () => limpiarCompradosListaCompras(),
    'handle-bag-checkbox': () => handleBagCheckbox(triggerEl)
  };
  if (Object.prototype.hasOwnProperty.call(handlers, action)) handlers[action]();
}

function esEventoPermitidoBloqueado_(target) {
  return Boolean(target && typeof target.closest === 'function' && target.closest('#access-key-modal'));
}

function exigirBloqueoUi_(e, target) {
  if (!authPaused_ && getStoredAccessKey_()) return false;
  if (esEventoPermitidoBloqueado_(target)) return false;
  e.preventDefault();
  e.stopPropagation();
  const keyModal = document.getElementById('access-key-modal');
  if (!keyModal || !keyModal.classList.contains('active')) {
    openAccessKeyModal_('Ingresá tu clave de acceso para continuar.');
  }
  return true;
}

function initUiEventDelegation_() {
  if (isUiDelegationBound_) return;
  isUiDelegationBound_ = true;

  document.addEventListener('click', (e) => {
    if (Date.now() < ptrSuppressClickUntil_) return;
    const target = e.target;
    if (!target || typeof target.closest !== 'function') return;

    if (target.closest('#btn-clear-pending-local')) {
      handleClearPendingLocalClick_();
      return;
    }

    if (exigirBloqueoUi_(e, target)) return;

    const backdropEl = target.closest('[data-backdrop-close]');
    if (backdropEl && e.target === backdropEl) {
      const kind = backdropEl.getAttribute('data-backdrop-close');
      if (kind === 'palette') closePaletteModal();
      else if (kind === 'message') closeMessageModal();
      else if (kind === 'shopping') closeShoppingModal();
      return;
    }

    const stopPropEl = target.closest('[data-stop-prop="true"]');
    if (stopPropEl) {
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    }

    const hbPill = target.closest('[data-hb-day]');
    if (hbPill) {
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      toggleHbExcludedDay_(hbPill.getAttribute('data-hb-day'));
      return;
    }

    const txPill = target.closest('[data-tx-day]');
    if (txPill) {
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      selectTxDay_(txPill.getAttribute('data-tx-day'));
      return;
    }

    const paletteBtn = target.closest('[data-palette-id]');
    if (paletteBtn) {
      seleccionarPaletaUsuario(paletteBtn.getAttribute('data-palette-id'));
      return;
    }

    const txItemBtn = target.closest('[data-tx-id]');
    if (txItemBtn) {
      toggleModal(true, txItemBtn.getAttribute('data-tx-id'));
      return;
    }

    const auditTxEl = target.closest('[data-audit-tx-id]');
    if (auditTxEl) {
      toggleBudgetAuditModal(false);
      toggleModal(true, auditTxEl.getAttribute('data-audit-tx-id'));
      return;
    }

    const futureTxEl = target.closest('[data-future-tx-id]');
    if (futureTxEl) {
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      toggleFutureDaysModal(false);
      toggleModal(true, futureTxEl.getAttribute('data-future-tx-id'));
      return;
    }

    const toggleShopEl = target.closest('[data-toggle-shop-id]');
    if (toggleShopEl) {
      toggleItemListaCompras(toggleShopEl.getAttribute('data-toggle-shop-id'));
      return;
    }

    const delShopEl = target.closest('[data-delete-shop-id]');
    if (delShopEl) {
      eliminarItemListaCompras(delShopEl.getAttribute('data-delete-shop-id'));
      return;
    }

    const emojiBtn = target.closest('[data-emoji]');
    if (emojiBtn) {
      insertEmoji(emojiBtn.getAttribute('data-emoji'));
      return;
    }

    const actionEl = target.closest('[data-action]');
    if (actionEl) {
      if (actionEl.tagName === 'INPUT' && actionEl.type === 'checkbox') return;
      dispatchUiAction_(actionEl.getAttribute('data-action'), actionEl.getAttribute('data-arg'), actionEl);
    }
  });

  document.addEventListener('change', (e) => {
    const target = e.target;
    if (exigirBloqueoUi_(e, target)) return;
    if (!target || typeof target.matches !== 'function') return;
    if (target.matches('[data-action="handle-bag-checkbox"]')) {
      handleBagCheckbox(target);
    }
  });

  document.addEventListener('input', (e) => {
    const target = e.target;
    if (exigirBloqueoUi_(e, target)) return;
    if (!target || typeof target.matches !== 'function') return;
    if (target.matches('[data-capitalize="true"]')) {
      capitalizeInput(target);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const target = e.target;
    if (exigirBloqueoUi_(e, target)) return;
    if (!target || typeof target.closest !== 'function') return;
    const auditTxEl = target.closest('[data-audit-tx-id]');
    if (auditTxEl) {
      e.preventDefault();
      toggleBudgetAuditModal(false);
      toggleModal(true, auditTxEl.getAttribute('data-audit-tx-id'));
    }
  });

  const accessForm = document.getElementById('access-key-form');
  if (accessForm) {
    accessForm.addEventListener('submit', (e) => {
      e.preventDefault();
      submitAccessKeyForm_();
    });
  }
}

function isAtTopForPtr_() {
  const winY = (typeof window !== 'undefined' && typeof window.scrollY === 'number') ? window.scrollY : 0;
  if (winY > 0) return false;
  const docEl = typeof document !== 'undefined' ? document.scrollingElement : null;
  if (docEl && docEl.scrollTop > 0) return false;
  const appViewport = document.getElementById('app-viewport');
  if (appViewport && appViewport.scrollTop > 0) return false;
  const panelList = document.getElementById('micro-panel-list');
  if (panelList && panelList.scrollTop > 0) return false;
  return true;
}

function resetPtrIndicator_() {
  const ind = document.getElementById('ptr-indicator');
  if (!ind) return;
  ind.classList.remove('pulling', 'visible', 'ready', 'refreshing');
  ind.style.transform = '';
  const spinner = ind.querySelector ? ind.querySelector('.ptr-spinner') : null;
  if (spinner && spinner.style) spinner.style.transform = '';
}

function initCustomPullToRefresh_() {
  let ptrTracking = false;
  let ptrEngaged = false;
  let startX = 0;
  let startY = 0;
  let lastDy = 0;
  const TRIGGER_DY = 72;

  document.addEventListener('touchstart', (e) => {
    if (!e || !e.touches || e.touches.length !== 1) {
      ptrTracking = false;
      return;
    }
    if (isManualRefreshing_ || getCurrentScreenState() !== 'MICRO_HOME' || !isAtTopForPtr_()) {
      ptrTracking = false;
      return;
    }
    const target = e.target;
    if (target && typeof target.closest === 'function') {
      if (target.closest('.days-carousel, #tx-days-carousel, #hb-excluded-days-list, input, select, textarea, button.emoji-chip')) {
        ptrTracking = false;
        return;
      }
    }
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    lastDy = 0;
    ptrEngaged = false;
    ptrTracking = true;
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!ptrTracking || !e || !e.touches || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;

    if (!ptrEngaged) {
      if (dy < -6 || (Math.abs(dx) > 10 && Math.abs(dx) >= Math.abs(dy))) {
        ptrTracking = false;
        return;
      }
      if (dy > 14 && dy > Math.abs(dx) * 1.5 && isAtTopForPtr_() && getCurrentScreenState() === 'MICRO_HOME') {
        ptrEngaged = true;
      } else {
        return;
      }
    }

    if (!isAtTopForPtr_() || dy <= 0) {
      ptrTracking = false;
      ptrEngaged = false;
      resetPtrIndicator_();
      return;
    }

    lastDy = dy;
    const ind = document.getElementById('ptr-indicator');
    if (ind) {
      const pullPx = Math.min(88, Math.round(dy * 0.45));
      ind.style.transform = 'translate3d(-50%, ' + (pullPx - 36) + 'px, 0) scale(1)';
      ind.classList.add('pulling', 'visible');
      ind.classList.toggle('ready', dy >= TRIGGER_DY);
      const spinner = ind.querySelector ? ind.querySelector('.ptr-spinner') : null;
      if (spinner && spinner.style) {
        spinner.style.transform = 'rotate(' + Math.round(dy * 3) + 'deg)';
      }
    }
  }, { passive: true });

  const finishPull = () => {
    if (!ptrTracking) return;
    const wasEngaged = ptrEngaged;
    const dy = lastDy;
    ptrTracking = false;
    ptrEngaged = false;
    lastDy = 0;

    if (wasEngaged && dy >= TRIGGER_DY && !isManualRefreshing_ && getCurrentScreenState() === 'MICRO_HOME') {
      ptrSuppressClickUntil_ = Date.now() + 300;
      const ind = document.getElementById('ptr-indicator');
      if (ind) {
        ind.style.transform = '';
        ind.classList.remove('pulling', 'ready');
        ind.classList.add('visible', 'refreshing');
        const spinner = ind.querySelector ? ind.querySelector('.ptr-spinner') : null;
        if (spinner && spinner.style) spinner.style.transform = '';
      }
      manualRefreshDiario_().finally(() => {
        resetPtrIndicator_();
      });
    } else {
      resetPtrIndicator_();
    }
  };

  document.addEventListener('touchend', finishPull, { passive: true });
  document.addEventListener('touchcancel', () => {
    ptrTracking = false;
    ptrEngaged = false;
    lastDy = 0;
    resetPtrIndicator_();
  }, { passive: true });
}

function initServiceWorkerRegistration_() {
  if (isSwRegistered_) return;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  isSwRegistered_ = true;

  const registerSw = () => {
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
      .then(reg => {
        swRegistration_ = reg;
        console.log('Service Worker registrado con éxito con alcance:', reg.scope);
      })
      .catch(err => {
        console.error('Error al registrar Service Worker:', err);
      });
  };

  if (typeof document !== 'undefined' && document.readyState === 'complete') {
    registerSw();
  } else if (typeof window !== 'undefined') {
    window.addEventListener('load', registerSw);
  }

  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    if (shouldDeferSwReload_()) {
      pendingSwReload_ = true;
      return;
    }
    refreshing = true;
    executeSwReload_();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  if (isAppFramed_()) {
    if (document.documentElement && document.documentElement.classList) {
      document.documentElement.classList.add('framed-blocked');
    }
    return;
  }
  const splashEl = document.getElementById('app-splash-screen');
  const skipSplash = document.documentElement && document.documentElement.classList && document.documentElement.classList.contains('skip-splash');
  if (splashEl) {
    if (skipSplash) {
      splashEl.classList.add('splash-hidden', 'hidden');
    } else {
      setTimeout(() => {
        splashEl.classList.add('splash-hidden');
        setTimeout(() => splashEl.classList.add('hidden'), 380);
      }, 650);
    }
  }
  resetAppScrollToTop_();
  window.addEventListener('load', resetAppScrollToTop_);
  window.addEventListener('pageshow', resetAppScrollToTop_);

  cargarUsuarioYColorLocal_();
  if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.persist === 'function') {
    navigator.storage.persist().catch(() => {});
  }
  initUiEventDelegation_();
  initCustomPullToRefresh_();
  initAvatarLongPress_();
  initOutsideCardTapToClose_();
  initHorizontalSwipeGesture_();
  initAndroidBackHistory_();
  initServiceWorkerRegistration_();
  autoFitCircleButtons();
  actualizarBadgeListaCompras_();
  initAutoSyncRefresh_();

  const shoppingInput = document.getElementById('shopping-item-input');
  if (shoppingInput) {
    shoppingInput.addEventListener('focus', () => {
      updateFloatingCircleButtonsPosition();
      setTimeout(updateFloatingCircleButtonsPosition, 140);
      setTimeout(updateFloatingCircleButtonsPosition, 300);
    });
    shoppingInput.addEventListener('blur', () => {
      setTimeout(updateFloatingCircleButtonsPosition, 120);
    });
    shoppingInput.addEventListener('keydown', e => {
      if (authPaused_ || !getStoredAccessKey_()) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        agregarItemListaCompras();
      }
    });
  }

  const msgInput = document.getElementById('msg-custom-input');
  if (msgInput) {
    const ajustarModalMensajes = () => {
      updateFloatingCircleButtonsPosition();
      ensureMessageModalSendVisible_();
    };
    msgInput.addEventListener('focus', () => {
      ajustarModalMensajes();
      setTimeout(ajustarModalMensajes, 140);
      setTimeout(ajustarModalMensajes, 300);
    });
    msgInput.addEventListener('input', ajustarModalMensajes);
    msgInput.addEventListener('blur', () => {
      setTimeout(updateFloatingCircleButtonsPosition, 120);
    });
    msgInput.addEventListener('keydown', e => {
      if (authPaused_ || !getStoredAccessKey_()) return;
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
  if (window.visualViewport && typeof window.visualViewport.addEventListener === 'function') {
    window.visualViewport.addEventListener('resize', updateFloatingCircleButtonsPosition);
    window.visualViewport.addEventListener('scroll', updateFloatingCircleButtonsPosition, { passive: true });
  }
  bootstrapEstado_();
});


