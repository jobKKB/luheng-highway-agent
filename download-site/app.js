(function () {
  'use strict';
  var config = window.LUHENG_DOWNLOAD || {};
  var links = document.querySelectorAll('[data-download]');
  var rawUrl = config.windowsUrl;
  var safeUrl = null;
  if (typeof rawUrl === 'string' && rawUrl.trim()) {
    try {
      rawUrl = rawUrl.trim();
      var parsed = new URL(rawUrl, window.location.href);
      if (/^https:\/\//i.test(rawUrl) && parsed.protocol === 'https:' && !parsed.username && !parsed.password) safeUrl = parsed.href;
      if (rawUrl.startsWith('/') && !rawUrl.startsWith('//') && parsed.origin === window.location.origin) safeUrl = parsed.href;
    } catch (ignore) { /* Invalid configuration leaves downloads disabled. */ }
  }
  links.forEach(function (link, index) {
    if (safeUrl) {
      link.href = safeUrl;
      link.removeAttribute('download');
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.removeAttribute('aria-disabled');
      link.removeAttribute('tabindex');
      link.querySelector('[data-download-label]').textContent = '下载 Windows 安装包';
    }
    link.addEventListener('click', function (event) {
      if (!safeUrl) event.preventDefault();
    });
  });
  if (safeUrl) document.querySelectorAll('[data-download-status]').forEach(function (status) { status.textContent = '直接下载 Windows 安装包，下载后请核对 SHA-256。'; });

  var toast = document.getElementById('toast');
  var toastTimer;
  function announce(message) {
    toast.textContent = message;
    toast.classList.add('is-visible');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () { toast.classList.remove('is-visible'); }, 3500);
  }
  function legacyCopy(value) {
    var input = document.createElement('textarea');
    input.value = value;
    input.setAttribute('readonly', '');
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    input.style.fontSize = '16px';
    document.body.appendChild(input);
    input.select();
    var success = document.execCommand('copy');
    input.remove();
    document.getElementById('copy-hash').focus({ preventScroll: true });
    if (!success) throw new Error('Copy unavailable');
  }
  document.getElementById('copy-hash').addEventListener('click', async function () {
    var value = document.getElementById('checksum-value').textContent.trim();
    try {
      if (navigator.clipboard && window.isSecureContext) {
        try { await navigator.clipboard.writeText(value); }
        catch (error) { legacyCopy(value); }
      } else { legacyCopy(value); }
      announce('SHA-256 校验值已复制');
    } catch (error) {
      var range = document.createRange();
      range.selectNodeContents(document.getElementById('checksum-value'));
      var selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      announce('请选中校验值，使用系统的复制功能');
    }
  });
})();
