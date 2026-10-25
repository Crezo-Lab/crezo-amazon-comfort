(() => {
  'use strict';

  // URL の判定・組み立ては official-url.js（manifest で先に読む・tests/ で試験する）
  const OfficialUrl = globalThis.CrezoOfficialUrl;
  const OFFICIAL_PARAM_VAL = OfficialUrl.sellerIdForHost(window.location.hostname);
  const MAX_FETCH_FAILURES = 2;

  // 初期設定
  const DEFAULT_SETTINGS = {
    officialOnly: false,      // Amazon公式販売のみ
    infiniteScroll: true      // 自動ページ追加
  };

  let currentSettings = { ...DEFAULT_SETTINGS };
  let isFetchingNextPage = false;
  let hasMorePages = true;
  let fetchFailures = 0;

  // 1.0.0 の開発支援（アソシエイトのタグ付け）は 1.0.1 で外した。保存済みの設定も消す
  // （sync は書き込み回数に上限があるので、残っているときだけ消す）
  chrome.storage.sync.get(['supportDev', 'affiliateTags'], (old) => {
    if (chrome.runtime.lastError || !old || Object.keys(old).length === 0) return;
    chrome.storage.sync.remove(['supportDev', 'affiliateTags'], () => {
      if (chrome.runtime.lastError) {
        console.warn('[Crezo Amazon Comfort] 古い設定を消せませんでした:', chrome.runtime.lastError.message);
      }
    });
  });

  // 設定読み込み
  chrome.storage.sync.get(DEFAULT_SETTINGS, (items) => {
    currentSettings = { ...DEFAULT_SETTINGS, ...items };
    init();
  });

  // 設定変更の監視（ページの移動はしない。開いている Amazon のタブが全部読み直されるため）
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') {
      for (const [key, change] of Object.entries(changes)) {
        if (key in DEFAULT_SETTINGS) currentSettings[key] = change.newValue;
      }
      applySettings();
    }
  });

  // ポップアップの「公式販売のみ」は、いま見ているタブにだけ届く
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'crezo-set-official' && isSearchPage()) {
      toggleOfficialUrlParam(!!msg.enabled);
    }
  });

  function getResultsContainer() {
    return document.querySelector('.s-main-slot') || document.querySelector('.s-result-list');
  }

  function isSearchPage() {
    return !!getResultsContainer();
  }

  function urlHasOfficialParam(url) {
    return OfficialUrl.hasOfficial(url, OFFICIAL_PARAM_VAL);
  }

  function init() {
    insertQuickToggleBar();
    handleOfficialOnlyFilter();
    if (isSearchPage()) setupInfiniteScroll();
  }

  function applySettings() {
    handleOfficialOnlyFilter();
    const scrollCb = document.getElementById('crezo-toggle-scroll');
    if (scrollCb) scrollCb.checked = !!currentSettings.infiniteScroll;
  }

  /* ========================================================
   * 1. 検索結果画面にクイック操作バー（浮動ヘッダー/バー）を挿入
   * ======================================================== */
  function insertQuickToggleBar() {
    if (document.getElementById('crezo-quick-bar')) return;

    // 検索結果コンテナのチェック
    const searchContainer = document.querySelector('.s-desktop-content') || document.querySelector('[data-component-type="s-search-results"]');
    if (!searchContainer) return;

    const urlHasParam = urlHasOfficialParam(new URL(window.location.href));

    const bar = document.createElement('div');
    bar.id = 'crezo-quick-bar';
    bar.innerHTML = `
      <div class="crezo-bar-content">
        <span class="crezo-logo-badge">Crezo</span>
        <label class="crezo-switch-label" title="Amazon公式が販売・発送する商品のみに絞り込みます">
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
        if (chrome.runtime.lastError) {
          console.warn('[Crezo Amazon Comfort] 設定を保存できませんでした:', chrome.runtime.lastError.message);
        }
        // 保存に失敗しても、押した操作はこのページに反映する
        toggleOfficialUrlParam(enabled);
      });
    });

    const scrollCb = bar.querySelector('#crezo-toggle-scroll');
    scrollCb.addEventListener('change', (e) => {
      const enabled = e.target.checked;
      currentSettings.infiniteScroll = enabled;
      chrome.storage.sync.set({ infiniteScroll: enabled }, () => {
        if (chrome.runtime.lastError) {
          console.warn('[Crezo Amazon Comfort] 設定を保存できませんでした:', chrome.runtime.lastError.message);
        }
      });
    });
  }

  /* ========================================================
   * 2. Amazon公式販売（&emi=出品者ID）の反映
   * ======================================================== */

  function handleOfficialOnlyFilter() {
    // ページロード時の自動リダイレクトは無限ループや意図せぬリロードを招くため行わない。
    // クイックバーやポップアップのトグル操作時のみURLを変更する。
  }

  function toggleOfficialUrlParam(enable) {
    const href = window.location.href;
    const next = enable
      ? OfficialUrl.buildEnableUrl(href, OFFICIAL_PARAM_VAL)
      : OfficialUrl.buildDisableUrl(href, OFFICIAL_PARAM_VAL);
    if (next) window.location.href = next;
  }

  /* ========================================================
   * 3. 自動スクロール（次ページの自動インライン取得・追記）
   * ======================================================== */
  function setupInfiniteScroll() {
    window.addEventListener('scroll', () => {
      if (!currentSettings.infiniteScroll || isFetchingNextPage || !hasMorePages) return;

      // 商品一覧の末尾が画面の下から1200px以内に来たら次を読み込む
      // （document.documentElement.offsetHeight は Amazon で実際の高さと合わないことがある）
      const container = getResultsContainer();
      if (!container) return;
      const listBottom = container.getBoundingClientRect().bottom;
      if (listBottom - window.innerHeight < 1200) {
        fetchNextPage();
      }
    }, { passive: true });
  }

  function findNextLink(root) {
    // 「次へ」だけを使う。最後のページでは「次へ」が無効の span になり a が無いので、ここで止まる。
    const a = root.querySelector('a.s-pagination-next');
    if (!a || a.classList.contains('s-pagination-disabled') || a.getAttribute('aria-disabled') === 'true') return null;
    return a;
  }

  // ページ送りの部品を、商品一覧の直下の子まで上にたどる
  function findPaginationBlock(container) {
    if (!container) return null;
    const strip = container.querySelector('.s-pagination-strip, .s-pagination-container');
    if (!strip) return null;
    let el = strip;
    while (el && el.parentElement !== container) el = el.parentElement;
    return el;
  }

  // Amazon の画像は遅れて読む作りのことがあるため、data 属性から src を入れる
  function fixLazyImages(root) {
    root.querySelectorAll('img').forEach(img => {
      const src = img.getAttribute('src') || '';
      const missing = !src || src.startsWith('data:');
      const dataSrc = img.getAttribute('data-src');
      if (missing && dataSrc) img.setAttribute('src', dataSrc);
      const dataSrcset = img.getAttribute('data-srcset');
      if (dataSrcset && !img.getAttribute('srcset')) img.setAttribute('srcset', dataSrcset);
      const dyn = img.getAttribute('data-a-dynamic-image');
      if (missing && !dataSrc && dyn) {
        try {
          const first = Object.keys(JSON.parse(dyn))[0];
          if (first) img.setAttribute('src', first);
        } catch (e) {
          console.warn('[Crezo Amazon Comfort] 画像の候補を読めませんでした:', e);
        }
      }
    });
  }

  const FAIL_MESSAGE = '次のページを読み込めませんでした。下のページ送りから進んでください';

  let showingStopMessage = false;

  function stopWithMessage(message) {
    hasMorePages = false;
    showingStopMessage = true;
    showLoadingIndicator(true, message);
    setTimeout(() => showLoadingIndicator(false), 8000);
  }

  function fetchNextPage() {
    const nextBtn = findNextLink(document);
    if (!nextBtn) {
      hasMorePages = false;
      return;
    }

    let nextUrl;
    try {
      nextUrl = new URL(nextBtn.getAttribute('href'), window.location.href);
    } catch (e) {
      stopWithMessage(FAIL_MESSAGE);
      return;
    }
    if (nextUrl.origin !== window.location.origin) {
      hasMorePages = false;
      return;
    }

    isFetchingNextPage = true;
    showLoadingIndicator(true);

    fetch(nextUrl.toString(), { credentials: 'same-origin' })
      .then(res => {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .then(html => {
        const doc = new DOMParser().parseFromString(html, 'text/html');

        const newResults = doc.querySelectorAll('[data-component-type="s-search-result"]');
        const mainContainer = getResultsContainer();
        if (!mainContainer) {
          hasMorePages = false;
          return;
        }
        if (newResults.length === 0) {
          // ロボット確認の画面などが返ってきたとき。取り直さずに止める
          stopWithMessage(FAIL_MESSAGE);
          return;
        }
        fetchFailures = 0;

        // 新しい商品は、一覧の中のページ送りの前に入れる
        const paginationBlock = findPaginationBlock(mainContainer);
        const insert = (node) => {
          if (paginationBlock) mainContainer.insertBefore(node, paginationBlock);
          else mainContainer.appendChild(node);
        };

        // 区切りバナー（数字は URL から。textContent で入れる）
        const pageSeparator = document.createElement('div');
        pageSeparator.className = 'crezo-page-separator';
        const label = document.createElement('span');
        const pageNum = nextUrl.searchParams.get('page');
        label.textContent = /^\d+$/.test(pageNum || '') ? `Page ${pageNum}` : '次のページ';
        pageSeparator.appendChild(label);
        insert(pageSeparator);

        // 同じ商品を二度足さない
        const seen = new Set();
        mainContainer.querySelectorAll('[data-asin]').forEach(el => {
          const asin = el.getAttribute('data-asin');
          if (asin) seen.add(asin);
        });

        newResults.forEach(item => {
          const asin = item.getAttribute('data-asin');
          if (asin && seen.has(asin)) return;
          if (asin) seen.add(asin);
          const node = document.importNode(item, true);
          fixLazyImages(node);
          insert(node);
        });

        // ページ送りを新しいページのものに入れ替える（「次へ」が次の未読ページを指すように）
        const newPaginationBlock = findPaginationBlock(doc.querySelector('.s-main-slot') || doc.querySelector('.s-result-list'));
        if (paginationBlock && newPaginationBlock) {
          paginationBlock.replaceWith(document.importNode(newPaginationBlock, true));
        }
        if (!findNextLink(doc)) {
          hasMorePages = false;
          // 入れ替えられなかったときに、古い「次へ」で読み込み済みのページへ戻らないようにする
          const staleNext = findNextLink(document);
          if (staleNext) staleNext.classList.add('s-pagination-disabled');
        } else if (!(paginationBlock && newPaginationBlock)) {
          // 入れ替えられなかったときは、今の「次へ」の行き先だけ差し替える
          nextBtn.setAttribute('href', findNextLink(doc).getAttribute('href'));
        }

      })
      .catch(err => {
        fetchFailures += 1;
        console.warn('[Crezo Amazon Comfort] Failed to load next page:', err);
        if (fetchFailures >= MAX_FETCH_FAILURES) {
          stopWithMessage(FAIL_MESSAGE);
        }
      })
      .finally(() => {
        isFetchingNextPage = false;
        // 止めた文言を出しているときだけ残す（最後のページまで読んだときは消す）
        if (!showingStopMessage) showLoadingIndicator(false);
      });
  }

  function showLoadingIndicator(show, message) {
    let loader = document.getElementById('crezo-loading-indicator');
    if (show) {
      if (!loader) {
        loader = document.createElement('div');
        loader.id = 'crezo-loading-indicator';
        loader.innerHTML = `
          <div class="crezo-spinner"></div>
          <span class="crezo-loading-text"></span>
        `;
        document.body.appendChild(loader);
      }
      loader.querySelector('.crezo-loading-text').textContent = message || '次の商品を読み込み中...';
      loader.querySelector('.crezo-spinner').style.display = message ? 'none' : '';
      loader.classList.add('active');
    } else if (loader) {
      loader.classList.remove('active');
    }
  }

})();
