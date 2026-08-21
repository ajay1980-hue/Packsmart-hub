(function () {
  'use strict';

  var STORAGE_KEY = 'packsmartAssistantHidden';
  var APP_UA = /PacksmartSolutionsAndroid/i.test(navigator.userAgent || '');

  function readHidden() {
    try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch (e) { return false; }
  }

  function writeHidden(hidden) {
    try {
      if (hidden) localStorage.setItem(STORAGE_KEY, '1');
      else localStorage.removeItem(STORAGE_KEY);
    } catch (e) {}
  }

  function install() {
    var root = document.querySelector('[data-ps-assistant]');
    if (!root || root.dataset.psHideControlReady === 'true') return !!root;
    root.dataset.psHideControlReady = 'true';

    if (APP_UA) {
      root.style.setProperty('bottom', '60px', 'important');
    }

    var dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'ps-assistant__dismiss';
    dismiss.setAttribute('aria-label', 'Hide Packsmart assistant');
    dismiss.title = 'Hide assistant';
    dismiss.textContent = '×';
    dismiss.style.cssText = [
      'position:absolute',
      'right:-6px',
      'top:-9px',
      'z-index:2147483646',
      'width:25px',
      'height:25px',
      'display:grid',
      'place-items:center',
      'padding:0',
      'border:1px solid #f3ce70',
      'border-radius:999px',
      'background:#0d0f11',
      'color:#f3ce70',
      'box-shadow:0 5px 16px rgba(0,0,0,.45)',
      'font:800 17px/1 Arial,sans-serif',
      'cursor:pointer'
    ].join(';');
    root.appendChild(dismiss);

    var restore = document.createElement('button');
    restore.type = 'button';
    restore.id = 'PacksmartAssistantRestore';
    restore.setAttribute('aria-label', 'Show Packsmart assistant');
    restore.textContent = '✦ Show AI';
    restore.style.cssText = [
      'position:fixed',
      'right:12px',
      'bottom:' + (APP_UA ? '60px' : '12px'),
      'z-index:2147483646',
      'min-height:38px',
      'padding:8px 12px',
      'border:1px solid #f3ce70',
      'border-radius:999px',
      'background:#0d0f11',
      'color:#f3ce70',
      'box-shadow:0 8px 24px rgba(0,0,0,.42)',
      'font:800 12px/1.2 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif',
      'cursor:pointer'
    ].join(';');
    restore.hidden = true;
    document.body.appendChild(restore);

    function applyState(hidden) {
      root.style.setProperty('display', hidden ? 'none' : '', hidden ? 'important' : '');
      if (!hidden) root.style.removeProperty('display');
      restore.hidden = !hidden;
    }

    dismiss.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      writeHidden(true);
      applyState(true);
    });

    restore.addEventListener('click', function () {
      writeHidden(false);
      applyState(false);
      var launcher = root.querySelector('[data-ps-open]');
      if (launcher) launcher.focus();
    });

    applyState(readHidden());
    return true;
  }

  function boot() {
    if (install()) return;
    var observer = new MutationObserver(function () {
      if (install()) observer.disconnect();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(function () { observer.disconnect(); }, 15000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
