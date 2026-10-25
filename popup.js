document.addEventListener('DOMContentLoaded', () => {
  const officialOnlyCb = document.getElementById('official-only');
  const infiniteScrollCb = document.getElementById('infinite-scroll');

  // 文言はブラウザの言語に合わせる（_locales に無い言語は ja のまま）
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const msg = chrome.i18n.getMessage(el.dataset.i18n);
    if (msg) el.textContent = msg;
  });
  document.documentElement.lang = chrome.i18n.getUILanguage().startsWith('ja') ? 'ja' : 'en';
  document.getElementById('appVersion').textContent = 'v' + chrome.runtime.getManifest().version;

  const DEFAULTS = {
    officialOnly: false,
    infiniteScroll: true
  };

  function warnIfFailed(what) {
    if (chrome.runtime.lastError) {
      console.warn('[Crezo Amazon Comfort] ' + what + ':', chrome.runtime.lastError.message);
    }
  }

  // 設定読み込み
  chrome.storage.sync.get(DEFAULTS, (items) => {
    officialOnlyCb.checked = items.officialOnly;
    infiniteScrollCb.checked = items.infiniteScroll;
  });

  // 変更検知と保存
  officialOnlyCb.addEventListener('change', () => {
    const enabled = officialOnlyCb.checked;
    chrome.storage.sync.set({ officialOnly: enabled }, () => warnIfFailed('設定を保存できませんでした'));
    // いま見ている Amazon の検索結果にだけ反映する（ほかのタブは読み直さない）
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || tab.id == null) return;
      chrome.tabs.sendMessage(tab.id, { type: 'crezo-set-official', enabled }, () => {
        // Amazon 以外のタブでは受け手がいないので、このエラーは出てよい
        void chrome.runtime.lastError;
      });
    });
  });

  infiniteScrollCb.addEventListener('change', () => {
    chrome.storage.sync.set({ infiniteScroll: infiniteScrollCb.checked }, () => warnIfFailed('設定を保存できませんでした'));
  });
});
