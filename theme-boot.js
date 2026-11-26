(function () {
  var isFramed = false;
  try {
    isFramed = window.self !== window.top;
  } catch (e) {
    isFramed = true;
  }
  try {
    window.__appFramedBlocked = isFramed;
  } catch (e) {}
  if (isFramed) {
    if (document && document.documentElement && document.documentElement.classList) {
      document.documentElement.classList.add('framed-blocked');
    }
    try {
      window.top.location = window.self.location.href;
    } catch (e) {}
    return;
  }

  var isReload = false;
  try {
    if (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('app_skip_splash_once') === '1') {
      isReload = true;
      sessionStorage.removeItem('app_skip_splash_once');
    }
  } catch (e) {}
  try {
    if (!isReload && typeof performance !== 'undefined' && typeof performance.getEntriesByType === 'function') {
      var navEntries = performance.getEntriesByType('navigation');
      if (navEntries && navEntries[0] && navEntries[0].type === 'reload') {
        isReload = true;
      }
    }
  } catch (e) {}
  try {
    if (!isReload && typeof performance !== 'undefined' && performance.navigation && performance.navigation.type === 1) {
      isReload = true;
    }
  } catch (e) {}
  if (isReload && document && document.documentElement && document.documentElement.classList) {
    document.documentElement.classList.add('skip-splash');
  }

  var ALLOWED_USERS = ['Brian', 'Virginia'];
  var rawUser = null;
  try {
    rawUser = localStorage.getItem('userActive');
  } catch (e) {}

  var activeUser = ALLOWED_USERS.indexOf(rawUser) !== -1 ? rawUser : 'Brian';
  window.__initialUser = activeUser;

  var ALLOWED_VARS = [
    '--color-primary',
    '--color-primary-dark',
    '--color-primary-light',
    '--color-primary-glow',
    '--color-surface-card',
    '--color-surface-header',
    '--color-muted',
    '--color-header-sub',
    '--color-bg-desktop'
  ];
  var COLOR_VALUE_REGEX = /^(#[0-9a-fA-F]{6}|rgba?\(\d{1,3},\s*\d{1,3},\s*\d{1,3}(?:,\s*(?:0|1|0?\.\d+))?\))$/;
  var HEX_VALUE_REGEX = /^#[0-9a-fA-F]{6}$/;

  try {
    var rawVars = localStorage.getItem('userPaletteVars_' + activeUser);
    if (rawVars) {
      var vars = JSON.parse(rawVars);
      if (vars && typeof vars === 'object' && !Array.isArray(vars)) {
        var root = document.documentElement;
        ALLOWED_VARS.forEach(function (key) {
          var val = vars[key];
          if (typeof val === 'string' && COLOR_VALUE_REGEX.test(val.trim())) {
            root.style.setProperty(key, val.trim());
          }
        });
        var primary = vars['--color-primary'];
        if (typeof primary === 'string' && HEX_VALUE_REGEX.test(primary.trim())) {
          var metas = document.querySelectorAll('meta[name="theme-color"]');
          metas.forEach(function (meta) {
            meta.setAttribute('content', primary.trim());
          });
        }
      }
    }
  } catch (e) {}

  document.addEventListener('DOMContentLoaded', function () {
    var titleEl = document.getElementById('nav-title-text');
    if (titleEl) {
      titleEl.textContent = 'Hola, ' + activeUser;
    }
  });
})();
