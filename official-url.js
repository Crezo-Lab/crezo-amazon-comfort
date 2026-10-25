// 「Amazon公式販売のみ」の URL を判定・組み立てる純粋な関数。
// content.js（同じ拡張の content script どうしは同じ global を共有する）と tests/ の node から使う。
(function (root) {
  'use strict';

  const KEY = 'emi';
  // Amazon 本体の出品者ID（国ごとに違う）
  const SELLER_IDS = {
    'co.jp': 'AN1VRQENFRJN5',
    'com': 'ATVPDKIKX0DER' // 未確認（広く知られた値だが本物のサイトで確かめていない）
  };

  function sellerIdForHost(hostname) {
    return /(^|\.)amazon\.com$/.test(hostname) ? SELLER_IDS.com : SELLER_IDS['co.jp'];
  }

  function p6Parts(rh) {
    return (rh || '').split(',').filter(part => part.startsWith('p_6:'));
  }

  // 公式のみになっているか。p_6 は「|」で並べると OR なので、Amazon だけのときに限る
  function hasOfficial(url, sellerId) {
    if (url.searchParams.get(KEY) === sellerId) return true;
    const parts = p6Parts(url.searchParams.get('rh'));
    return parts.length > 0 && parts.every(part => {
      const ids = part.slice(4).split('|').filter(Boolean);
      return ids.length === 1 && ids[0] === sellerId;
    });
  }

  // rh から出品者の絞り込みを外す。sellerId を渡せばその出品者だけ、null なら p_6 を全部
  function removeSellerFromRh(rh, sellerId) {
    return (rh || '').split(',').map(part => {
      if (!part.startsWith('p_6:')) return part;
      if (sellerId == null) return '';
      const ids = part.slice(4).split('|').filter(id => id && id !== sellerId);
      return ids.length ? 'p_6:' + ids.join('|') : '';
    }).filter(Boolean).join(',');
  }

  function setRh(url, rh) {
    if (rh) url.searchParams.set('rh', rh);
    else url.searchParams.delete('rh');
  }

  // 公式のみにする URL。既にそうなら null
  function buildEnableUrl(href, sellerId) {
    const url = new URL(href);
    if (hasOfficial(url, sellerId)) return null;
    url.searchParams.set(KEY, sellerId);
    // ほかの出品者の p_6 が残ると emi と食い違って0件になるので外す
    if (url.searchParams.has('rh')) setRh(url, removeSellerFromRh(url.searchParams.get('rh'), null));
    url.searchParams.delete('page'); // 絞り込み後は1ページ目から
    return url.toString();
  }

  // 公式のみを外す URL。外す物が無ければ null
  function buildDisableUrl(href, sellerId) {
    const url = new URL(href);
    const rh = url.searchParams.get('rh');
    const hasEmi = url.searchParams.get(KEY) === sellerId;
    const hasP6 = p6Parts(rh).some(part => part.slice(4).split('|').includes(sellerId));
    if (!hasEmi && !hasP6) return null;
    if (hasEmi) url.searchParams.delete(KEY);
    if (hasP6) setRh(url, removeSellerFromRh(rh, sellerId));
    url.searchParams.delete('page');
    return url.toString();
  }

  // 同じ検索かを見分ける鍵。ページ番号と、Amazon が書き換えるだけの計測用の値は除く
  const NOISE_PARAMS = /^(page|qid|ref|ref_|crid|sprefix|ds|_encoding|xpid|dib|dib_tag|content-id|psc|th|pd_rd_.*|pf_rd_.*|sr|spla)$/;
  function searchKey(href) {
    const url = new URL(href);
    const kept = [];
    url.searchParams.forEach((v, k) => { if (!NOISE_PARAMS.test(k)) kept.push(k + '=' + v); });
    kept.sort();
    return url.pathname.replace(/\/ref=.*$/, '') + '?' + kept.join('&');
  }

  function pageKey(href) {
    return searchKey(href) + '#page=' + (new URL(href).searchParams.get('page') || '1');
  }

  const api = { KEY, SELLER_IDS, sellerIdForHost, hasOfficial, removeSellerFromRh, buildEnableUrl, buildDisableUrl, searchKey, pageKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CrezoOfficialUrl = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
