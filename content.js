(() => {
  'use strict';

  // URL の判定・組み立ては official-url.js（manifest で先に読む・tests/ で試験する）
  const OfficialUrl = globalThis.CrezoOfficialUrl;
  const OFFICIAL_PARAM_VAL = OfficialUrl.sellerIdForHost(window.location.hostname);
  const MAX_FETCH_FAILURES = 2;

  // 画面に出す文言（_locales/*/messages.json の content で始まるキー）
  function t(key, subs) {
    try {
      const msg = chrome.i18n.getMessage(key, subs);
      if (msg) return msg;
      console.warn('[Crezo Amazon Comfort] 文言が見つかりません:', key);
    } catch (e) {
      // 拡張の更新後に残った古いスクリプトでは chrome.* が使えない
      console.warn('[Crezo Amazon Comfort] 文言を読めませんでした:', key, e);
    }
    return key;
  }
  const RETRY_DELAY_MS = 3000; // 1回目の失敗のあと、すぐ取り直さない（Amazon に連打しない）

  // 初期設定
  const DEFAULT_SETTINGS = {
    officialOnly: false,      // Amazon公式販売のみ
    infiniteScroll: true      // 自動ページ追加
  };

  let currentSettings = { ...DEFAULT_SETTINGS };
  let isFetchingNextPage = false;
  let hasMorePages = true;
  let fetchFailures = 0;
  let retryAfter = 0;
  // Amazon は並べ替え・絞り込みで一覧だけを書き換えて URL を変えることがある。
  // そのとき前の検索の続きを足さないよう、検索の鍵と世代で見分ける
  let currentSearchKey = OfficialUrl.searchKey(window.location.href);
  let generation = 0;
  let currentContainer = null;
  let stopMessageTimer = null;
  // 読み込んだページ（同じページを二度取りに行かない）
  const loadedPages = new Set([OfficialUrl.pageKey(window.location.href)]);

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
        <label class="crezo-switch-label" data-crezo="official">
          <input type="checkbox" id="crezo-toggle-official" ${urlHasParam ? 'checked' : ''}>
          <span class="crezo-switch-text"></span>
        </label>
        <label class="crezo-switch-label" data-crezo="scroll">
          <input type="checkbox" id="crezo-toggle-scroll" ${currentSettings.infiniteScroll ? 'checked' : ''}>
          <span class="crezo-switch-text"></span>
        </label>
      </div>
    `;
    // 文言は _locales から（ブラウザの言語に合わせる）。textContent で入れる
    const officialLabel = bar.querySelector('[data-crezo="official"]');
    officialLabel.title = t('contentBarOfficialHint');
    officialLabel.querySelector('.crezo-switch-text').textContent = '🛡️ ' + t('contentBarOfficial');
    const scrollLabel = bar.querySelector('[data-crezo="scroll"]');
    scrollLabel.title = t('contentBarScrollHint');
    scrollLabel.querySelector('.crezo-switch-text').textContent = '⚡ ' + t('contentBarScroll');

    // 検索ヘッダーの上部に挿入
    searchContainer.parentNode.insertBefore(bar, searchContainer);

    // イベントリスナー
    const officialCb = bar.querySelector('#crezo-toggle-official');
    officialCb.addEventListener('change', (e) => {
      const enabled = e.target.checked;
      // 保存に失敗しても、押した操作はこのページに反映する
      saveSetting({ officialOnly: enabled }, () => toggleOfficialUrlParam(enabled));
    });

    const scrollCb = bar.querySelector('#crezo-toggle-scroll');
    scrollCb.addEventListener('change', (e) => {
      const enabled = e.target.checked;
      currentSettings.infiniteScroll = enabled;
      saveSetting({ infiniteScroll: enabled });
    });
  }

  // 拡張を更新・読み直したあと、開いたままのタブに残った古い content script では
  // chrome.storage が "Extension context invalidated" を投げる。投げても押した操作は止めない
  function saveSetting(values, after) {
    const done = () => { if (after) after(); };
    try {
      chrome.storage.sync.set(values, () => {
        if (chrome.runtime.lastError) {
          console.warn('[Crezo Amazon Comfort] 設定を保存できませんでした:', chrome.runtime.lastError.message);
        }
        done();
      });
    } catch (e) {
      console.warn('[Crezo Amazon Comfort] 設定を保存できませんでした（ページを読み直すと直ります）:', e);
      done();
    }
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
      resetIfSearchChanged();
      if (!currentSettings.infiniteScroll || isFetchingNextPage || !hasMorePages) return;
      if (Date.now() < retryAfter) return;

      // 商品一覧の末尾が画面の下から1200px以内に来たら次を読み込む
      // （document.documentElement.offsetHeight は Amazon で実際の高さと合わないことがある）
      const container = getResultsContainer();
      if (!container) return;
      const listBottom = container.getBoundingClientRect().bottom;
      if (listBottom - window.innerHeight < 1200) {
        fetchNextPage();
      }
    }, { passive: true });
    window.addEventListener('popstate', resetIfSearchChanged);
  }

  // 一覧だけが書き換わって別の検索になったら、自動スクロールの状態を最初に戻す
  function resetIfSearchChanged() {
    const key = OfficialUrl.searchKey(window.location.href);
    const container = getResultsContainer();
    if (currentContainer === null) currentContainer = container;
    if (key === currentSearchKey && container === currentContainer) return;
    currentSearchKey = key;
    currentContainer = container;
    generation += 1; // 読み込み途中の前の検索の結果は捨てる
    isFetchingNextPage = false;
    hasMorePages = true;
    fetchFailures = 0;
    retryAfter = 0;
    showingStopMessage = false;
    loadedPages.clear();
    loadedPages.add(OfficialUrl.pageKey(window.location.href));
    clearTimeout(stopMessageTimer);
    showLoadingIndicator(false);
    insertQuickToggleBar();
    const officialCb = document.getElementById('crezo-toggle-official');
    if (officialCb) officialCb.checked = urlHasOfficialParam(new URL(window.location.href));
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

  const FAIL_MESSAGE = t('contentLoadFailed');

  let showingStopMessage = false;

  function stopWithMessage(message) {
    hasMorePages = false;
    showingStopMessage = true;
    showLoadingIndicator(true, message);
    clearTimeout(stopMessageTimer);
    stopMessageTimer = setTimeout(() => showLoadingIndicator(false), 8000);
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
    // 「次へ」が読み込み済みのページを指していたら、同じ商品を取り続けないよう止める
    if (loadedPages.has(OfficialUrl.pageKey(nextUrl.href))) {
      hasMorePages = false;
      return;
    }

    isFetchingNextPage = true;
    showLoadingIndicator(true);
    const myGeneration = generation;
    const startContainer = getResultsContainer();
    // 届くまでに別の検索へ移った（一覧が書き換わった）ら、前の検索の続きは足さない
    const isStale = () => myGeneration !== generation ||
      OfficialUrl.searchKey(window.location.href) !== currentSearchKey ||
      getResultsContainer() !== startContainer;

    fetch(nextUrl.toString(), { credentials: 'same-origin' })
      .then(res => {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .then(html => {
        if (isStale()) return;
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
        label.textContent = /^\d+$/.test(pageNum || '') ? t('contentPageNumber', [pageNum]) : t('contentNextPage');
        pageSeparator.appendChild(label);
        insert(pageSeparator);

        // 同じ商品を二度足さない（一覧の商品だけで見る。スポンサーの横並びの中の ASIN で次のページの商品を落とさない）
        const seen = new Set();
        mainContainer.querySelectorAll('[data-component-type="s-search-result"][data-asin]').forEach(el => {
          const asin = el.getAttribute('data-asin');
          if (asin) seen.add(asin);
        });

        let added = 0;
        newResults.forEach(item => {
          const asin = item.getAttribute('data-asin');
          if (asin && seen.has(asin)) return;
          if (asin) seen.add(asin);
          const node = document.importNode(item, true);
          fixLazyImages(node);
          insert(node);
          added += 1;
        });
        loadedPages.add(OfficialUrl.pageKey(nextUrl.href));
        if (added === 0) {
          // 全部が読み込み済みの商品だった（同じページが返ってきた）。区切りだけを残さずに止める
          pageSeparator.remove();
          stopWithMessage(FAIL_MESSAGE);
          return;
        }

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
        if (isStale()) return;
        fetchFailures += 1;
        retryAfter = Date.now() + RETRY_DELAY_MS;
        console.warn('[Crezo Amazon Comfort] Failed to load next page:', err);
        if (fetchFailures >= MAX_FETCH_FAILURES) {
          stopWithMessage(FAIL_MESSAGE);
        }
      })
      .finally(() => {
        if (myGeneration !== generation) return; // 新しい検索の状態は触らない
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
      loader.querySelector('.crezo-loading-text').textContent = message || t('contentLoading');
      loader.querySelector('.crezo-spinner').style.display = message ? 'none' : '';
      loader.classList.add('active');
    } else if (loader) {
      loader.classList.remove('active');
    }
  }

})();
