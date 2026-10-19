document.addEventListener('DOMContentLoaded', () => {
  const officialOnlyCb = document.getElementById('official-only');
  const infiniteScrollCb = document.getElementById('infinite-scroll');
  const supportDevCb = document.getElementById('support-dev');

  const DEFAULTS = {
    officialOnly: false,
    infiniteScroll: true,
    supportDev: false
  };

  // 設定読み込み
  chrome.storage.sync.get(DEFAULTS, (items) => {
    officialOnlyCb.checked = items.officialOnly;
    infiniteScrollCb.checked = items.infiniteScroll;
    supportDevCb.checked = items.supportDev;
  });

  // 変更検知と保存
  officialOnlyCb.addEventListener('change', () => {
    chrome.storage.sync.set({ officialOnly: officialOnlyCb.checked });
  });

  infiniteScrollCb.addEventListener('change', () => {
    chrome.storage.sync.set({ infiniteScroll: infiniteScrollCb.checked });
  });

  supportDevCb.addEventListener('change', () => {
    chrome.storage.sync.set({ supportDev: supportDevCb.checked });
  });
});
