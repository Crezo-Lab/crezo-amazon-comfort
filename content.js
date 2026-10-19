(() => {
  'use strict';

  // 初期設定
  const DEFAULT_SETTINGS = {
    officialOnly: false,      // Amazon公式販売のみ
    infiniteScroll: true,     // 自動ページ追加
    supportDev: false,        // 開発支援（オプトイン）
    affiliateTag: "newbie01280e-22"
  };

  let currentSettings = { ...DEFAULT_SETTINGS };
  let isFetchingNextPage = false;
  let hasMorePages = true;

  // 設定読み込み
  chrome.storage.sync.get(DEFAULT_SETTINGS, (items) => {
    currentSettings = items;
    init();
  });

  // 設定変更の監視
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') {
      for (const [key, change] of Object.entries(changes)) {
        currentSettings[key] = change.newValue;
      }
      applySettings();
    }
  });

  function init() {
    insertQuickToggleBar();
    handleOfficialOnlyFilter();
    setupInfiniteScroll();
    handleDevSupport();
  }

  function applySettings() {
    handleOfficialOnlyFilter();
  }

  /* ========================================================
   * 1. 検索結果画面にクイック操作バー（浮動ヘッダー/バー）を挿入
   * ======================================================== */
  function insertQuickToggleBar() {
    if (document.getElementById('crezo-quick-bar')) return;

    // 検索結果コンテナのチェック
    const searchContainer = document.querySelector('.s-desktop-content') || document.querySelector('[data-component-type="s-search-results"]');
    if (!searchContainer) return;

    const bar = document.createElement('div');
    bar.id = 'crezo-quick-bar';
    const urlHasParam = new URL(window.location.href).searchParams.get(OFFICIAL_PARAM_KEY) === OFFICIAL_PARAM_VAL;
    bar.innerHTML = `
      <div class="crezo-bar-content">
        <span class="crezo-logo-badge">Crezo</span>
        <label class="crezo-switch-label" title="Amazon.co.jp公式が販売・発送する商品のみに絞り込みます">
          <input type="checkbox" id="crezo-toggle-official" ${urlHasParam ? 'checked' : ''}>
          <span class="crezo-switch-text">🛡️ Amazon公式販売のみ</span>
        </label>
        <label class="crezo-switch-label" title="スクロールすると次ページを自動で読み込みます">
          <input type="checkbox" id="crezo-toggle-scroll" ${currentSettings.infiniteScroll ? 'checked' : ''}>
          <span class="crezo-switch-text">⚡ 自動スクロール</span>
        </label>
      </div>
    `;

    // 検索ヘッダーの上部に挿入
    searchContainer.parentNode.insertBefore(bar, searchContainer);

    // イベントリスナー
    const officialCb = bar.querySelector('#crezo-toggle-official');
    officialCb.addEventListener('change', (e) => {
      const enabled = e.target.checked;
      chrome.storage.sync.set({ officialOnly: enabled }, () => {
        toggleOfficialUrlParam(enabled);
      });
    });

    const scrollCb = bar.querySelector('#crezo-toggle-scroll');
    scrollCb.addEventListener('change', (e) => {
      const enabled = e.target.checked;
      chrome.storage.sync.set({ infiniteScroll: enabled });
      currentSettings.infiniteScroll = enabled;
    });
  }

  /* ========================================================
   * 2. Amazon公式販売（&emi=AN1VRQENFRJN5）の反映
   * ======================================================== */
  const OFFICIAL_PARAM_KEY = 'emi';
  const OFFICIAL_PARAM_VAL = 'AN1VRQENFRJN5';

  function handleOfficialOnlyFilter() {
    // ページロード時の自動リダイレクトは無限ループや意図せぬリロードを招くため行わない。
    // クイックバーやポップアップのトグル操作時のみURLを変更する。
  }

  function toggleOfficialUrlParam(enable) {
    const url = new URL(window.location.href);
    const hasParam = url.searchParams.get(OFFICIAL_PARAM_KEY) === OFFICIAL_PARAM_VAL;
    if (enable && !hasParam) {
      url.searchParams.set(OFFICIAL_PARAM_KEY, OFFICIAL_PARAM_VAL);
      window.location.href = url.toString();
    } else if (!enable && hasParam) {
      url.searchParams.delete(OFFICIAL_PARAM_KEY);
      window.location.href = url.toString();
    }
  }

  /* ========================================================
   * 3. 自動スクロール（次ページの自動インライン取得・追記）
   * ======================================================== */
  function setupInfiniteScroll() {
    window.addEventListener('scroll', () => {
      if (!currentSettings.infiniteScroll || isFetchingNextPage || !hasMorePages) return;

      const scrollBottom = window.innerHeight + window.scrollY;
      const docHeight = document.documentElement.offsetHeight;

      // ページ下部から800px手前に来たら次を読み込む
      if (docHeight - scrollBottom < 800) {
        fetchNextPage();
      }
    }, { passive: true });
  }

  function fetchNextPage() {
    const nextBtn = document.querySelector('a.s-pagination-next') || 
                    document.querySelector('.s-pagination-strip a:last-child');
    if (!nextBtn || !nextBtn.href || nextBtn.classList.contains('s-pagination-disabled')) {
      hasMorePages = false;
      return;
    }

    const nextUrl = nextBtn.href;
    isFetchingNextPage = true;
    showLoadingIndicator(true);

    fetch(nextUrl)
      .then(res => res.text())
      .then(html => {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');

        // 商品アイテムリストを取得
        const newResults = doc.querySelectorAll('[data-component-type="s-search-result"]');
        const mainContainer = document.querySelector('.s-main-slot') || 
                              document.querySelector('.s-result-list');

        if (newResults.length > 0 && mainContainer) {
          // 区切りバナーを挿入
          const pageSeparator = document.createElement('div');
          pageSeparator.className = 'crezo-page-separator';
          const matchPage = nextUrl.match(/page=(\d+)/);
          const pageNum = matchPage ? matchPage[1] : '次';
          pageSeparator.innerHTML = `<span>Page ${pageNum}</span>`;
          mainContainer.appendChild(pageSeparator);

          // 商品要素を追加
          newResults.forEach(item => {
            mainContainer.appendChild(document.importNode(item, true));
          });

          // 次ページリンクの更新
          const newNextBtn = doc.querySelector('a.s-pagination-next');
          if (newNextBtn && newNextBtn.href && !newNextBtn.classList.contains('s-pagination-disabled')) {
            nextBtn.href = newNextBtn.href;
          } else {
            hasMorePages = false;
            nextBtn.classList.add('s-pagination-disabled');
          }

          // 開発支援（オプトイン）の適用
          handleDevSupport();
        } else {
          hasMorePages = false;
        }
      })
      .catch(err => {
        console.warn('[Crezo Amazon Comfort] Failed to load next page:', err);
      })
      .finally(() => {
        isFetchingNextPage = false;
        showLoadingIndicator(false);
      });
  }

  function showLoadingIndicator(show) {
    let loader = document.getElementById('crezo-loading-indicator');
    if (show) {
      if (!loader) {
        loader = document.createElement('div');
        loader.id = 'crezo-loading-indicator';
        loader.innerHTML = `
          <div class="crezo-spinner"></div>
          <span>次の商品を読み込み中...</span>
        `;
        document.body.appendChild(loader);
      }
      loader.classList.add('active');
    } else if (loader) {
      loader.classList.remove('active');
    }
  }

  /* ========================================================
   * 4. 開発支援（完全オプトイン・ユーザーの自由意思による許可）
   * ======================================================== */
  function handleDevSupport() {
    if (!currentSettings.supportDev || !currentSettings.affiliateTag) return;

    // 商品リンクにタグを付与（規約に準拠したオープンなオプトイン形式）
    const productLinks = document.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"]');
    productLinks.forEach(link => {
      try {
        const u = new URL(link.href, window.location.origin);
        if (u.hostname.includes('amazon.co.jp') && !u.searchParams.has('tag')) {
          u.searchParams.set('tag', currentSettings.affiliateTag);
          link.href = u.toString();
        }
      } catch (e) {
        // invalid URL skip
      }
    });
  }
})();
