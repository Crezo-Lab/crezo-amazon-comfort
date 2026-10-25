// node tests/official-url.test.js で走る（外部の道具は使わない）
const assert = require('node:assert/strict');
const test = require('node:test');
const U = require('../official-url.js');

const JP = 'AN1VRQENFRJN5';
const US = 'ATVPDKIKX0DER';
const q = (href, k) => new URL(href).searchParams.get(k);

test('国ごとの出品者ID', () => {
  assert.equal(U.sellerIdForHost('www.amazon.co.jp'), JP);
  assert.equal(U.sellerIdForHost('amazon.co.jp'), JP);
  assert.equal(U.sellerIdForHost('www.amazon.com'), US);
  assert.equal(U.sellerIdForHost('amazon.com'), US);
});

test('判定: emi・p_6 単独・p_6 の OR', () => {
  const has = (h, id = JP) => U.hasOfficial(new URL(h), id);
  assert.equal(has('https://www.amazon.co.jp/s?k=a'), false);
  assert.equal(has(`https://www.amazon.co.jp/s?k=a&emi=${JP}`), true);
  assert.equal(has(`https://www.amazon.co.jp/s?k=a&rh=n:1,p_6:${JP}`), true);
  // ほかの出品者と OR のときは公式のみではない
  assert.equal(has(`https://www.amazon.co.jp/s?k=a&rh=p_6:OTHER|${JP}`), false);
  assert.equal(has('https://www.amazon.co.jp/s?k=a&rh=p_6:OTHER'), false);
  assert.equal(has(`https://www.amazon.com/s?k=a&emi=${US}`, US), true);
  assert.equal(has(`https://www.amazon.com/s?k=a&emi=${JP}`, US), false);
});

test('付ける: rh 無し', () => {
  const out = U.buildEnableUrl('https://www.amazon.co.jp/s?k=a&page=3', JP);
  assert.equal(q(out, 'emi'), JP);
  assert.equal(q(out, 'page'), null);
  assert.equal(q(out, 'k'), 'a');
});

test('付ける: rh に n: だけ（残す）', () => {
  const out = U.buildEnableUrl('https://www.amazon.co.jp/s?k=a&rh=n:123,p_36:1000-5000', JP);
  assert.equal(q(out, 'rh'), 'n:123,p_36:1000-5000');
  assert.equal(q(out, 'emi'), JP);
});

test('付ける: ほかの出品者の p_6 は外す（emi と食い違って0件になるため）', () => {
  const out = U.buildEnableUrl('https://www.amazon.co.jp/s?k=a&rh=n:1,p_6:OTHER', JP);
  assert.equal(q(out, 'rh'), 'n:1');
  assert.equal(q(out, 'emi'), JP);
  const out2 = U.buildEnableUrl('https://www.amazon.co.jp/s?k=a&rh=p_6:OTHER', JP);
  assert.equal(q(out2, 'rh'), null);
});

test('付ける: 既に公式のみなら何もしない', () => {
  assert.equal(U.buildEnableUrl(`https://www.amazon.co.jp/s?k=a&emi=${JP}`, JP), null);
  assert.equal(U.buildEnableUrl(`https://www.amazon.co.jp/s?k=a&rh=p_6:${JP}`, JP), null);
});

test('付ける: p_6 が OTHER|Amazon なら付ける', () => {
  const out = U.buildEnableUrl(`https://www.amazon.co.jp/s?k=a&rh=p_6:OTHER|${JP}`, JP);
  assert.equal(q(out, 'emi'), JP);
  assert.ok(U.hasOfficial(new URL(out), JP));
});

test('外す: emi', () => {
  const out = U.buildDisableUrl(`https://www.amazon.co.jp/s?k=a&emi=${JP}&page=2`, JP);
  assert.equal(q(out, 'emi'), null);
  assert.equal(q(out, 'page'), null);
});

test('外す: rh の p_6 から Amazon だけを外す', () => {
  assert.equal(q(U.buildDisableUrl(`https://www.amazon.co.jp/s?k=a&rh=n:1,p_6:${JP}`, JP), 'rh'), 'n:1');
  assert.equal(q(U.buildDisableUrl(`https://www.amazon.co.jp/s?k=a&rh=p_6:${JP},n:1`, JP), 'rh'), 'n:1');
  assert.equal(q(U.buildDisableUrl(`https://www.amazon.co.jp/s?k=a&rh=p_6:OTHER|${JP}`, JP), 'rh'), 'p_6:OTHER');
  assert.equal(q(U.buildDisableUrl(`https://www.amazon.co.jp/s?k=a&rh=p_6:${JP}`, JP), 'rh'), null);
});

test('外す: 外す物が無ければ null・ほかの国の ID は触らない', () => {
  assert.equal(U.buildDisableUrl('https://www.amazon.co.jp/s?k=a', JP), null);
  assert.equal(U.buildDisableUrl(`https://www.amazon.com/s?k=a&emi=${JP}`, US), null);
});

test('同じ検索の鍵: ページ・計測の値の違いは同じ、並べ替え・絞り込みの違いは別', () => {
  const base = 'https://www.amazon.co.jp/s?k=switchbot&rh=n:1';
  assert.equal(U.searchKey(base + '&page=2&qid=111&ref=sr_pg_2'), U.searchKey(base + '&qid=222&crid=X&sprefix=sw'));
  assert.notEqual(U.searchKey(base), U.searchKey(base + '&s=price-asc-rank'));
  assert.notEqual(U.searchKey(base), U.searchKey('https://www.amazon.co.jp/s?k=switchbot&rh=n:2'));
  assert.notEqual(U.searchKey(base), U.searchKey(base + `&emi=${JP}`));
  assert.equal(U.searchKey('https://www.amazon.co.jp/s/ref=sr_pg_2?k=a'), U.searchKey('https://www.amazon.co.jp/s?k=a'));
});

test('ページの鍵: page が無いのは1ページ目', () => {
  assert.equal(U.pageKey('https://www.amazon.co.jp/s?k=a'), U.pageKey('https://www.amazon.co.jp/s?k=a&page=1&qid=9'));
  assert.notEqual(U.pageKey('https://www.amazon.co.jp/s?k=a'), U.pageKey('https://www.amazon.co.jp/s?k=a&page=2'));
});
