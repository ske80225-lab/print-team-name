/* 順位表ページから、チーム名とエンブレムを直接取り出すブックマークレットの中身。
   順位表のページ上で実行するので、他サイトを fetch するときのような CORS の壁がない。
   結果は JSON でクリップボードに入る。A4ツールの貼り付け欄に ⌘V すれば取り込める。

   このファイルは読む用。実際に登録するのは index.html に載せた1行版。 */
(async function () {
  const sq = s => String(s || '').replace(/[\s　]+/g, ' ').trim();

  // 行のテキストから順位・増減の矢印・勝点を落とす
  const clean = t => sq(sq(t).split('\n')[0])
    .replace(/^\d{1,3}\s*[.．:：、,]?\s+/, '')
    .replace(/^[↑↓→←▲▼△▽—–\-=＝*・.,:：、\s]+/, '')
    .replace(/\s+[\d\-–—+.%]+$/, '')
    .trim();

  // エンブレムらしい大きさか。小さすぎ・大きすぎ・細長いものは除く。
  const okBox = r => r.width >= 12 && r.height >= 12 && r.width <= 240 && r.height <= 240 &&
    Math.min(r.width, r.height) / Math.max(r.width, r.height) > 0.5;

  const sig = el =>
    el.tagName + '.' + String(el.className || '').split(/\s+/).slice(0, 2).join('.');

  // エンブレムは <img> のこともあれば、CSSの背景画像のこともある（スポーツナビは後者）
  const cands = [];
  for (const im of document.images) {
    if (okBox(im.getBoundingClientRect())) cands.push({ el: im, src: im.currentSrc || im.src });
  }
  for (const el of document.querySelectorAll('span,i,em,b,div,a,figure')) {
    if (!okBox(el.getBoundingClientRect())) continue;
    const m = /url\(["']?(.*?)["']?\)/.exec(getComputedStyle(el).backgroundImage || '');
    if (m && m[1]) cands.push({ el, src: m[1] });
  }
  if (!cands.length) return alert('エンブレムらしい画像が見つかりませんでした。');

  // 表の中にある候補があれば、そちらだけを見る。サイトのナビゲーションにも
  // アイコンが並んでいることが多く、数だけで選ぶとそちらを掴んでしまう。
  const inTable = cands.filter(c => c.el.closest('tr'));
  const pool = inTable.length >= 3 ? inTable : cands;

  // 各候補について、テキストを持つ最小の祖先を「行」とみなす
  const found = [];
  for (const c of pool) {
    let el = c.el, name = '', key = '';
    for (let i = 0; i < 6 && el.parentElement; i++) {
      el = el.parentElement;
      const t = sq(el.innerText);
      if (t) { name = t; key = sig(el); break; }
    }
    if (name) found.push({ src: c.src, name, key });
  }
  if (!found.length) return alert('チーム名らしいテキストが見つかりませんでした。');

  // 同じ構造で繰り返されている組のうち、画像の種類が多く、テキストが短いものを選ぶ。
  // 増減の矢印も同じ数だけ並ぶが、画像の種類が数個しかなく、拾えるテキストは行全体になる。
  const groups = {};
  found.forEach(f => { (groups[f.key] = groups[f.key] || []).push(f); });
  const score = k => {
    const a = groups[k];
    return {
      distinct: new Set(a.map(x => x.src)).size,
      n: a.length,
      avg: a.reduce((s, x) => s + clean(x.name).length, 0) / a.length
    };
  };
  const best = Object.keys(groups).sort((x, y) => {
    const A = score(x), B = score(y);
    return B.distinct - A.distinct || B.n - A.n || A.avg - B.avg;
  })[0];
  const rows = groups[best];

  // 画像は可能なら data URL にして埋め込む。CORS で読めなければURLのまま返す。
  const inline = async url => {
    if (/^data:/.test(url)) return url;
    try {
      const r = await fetch(url, { mode: 'cors' });
      if (!r.ok) throw 0;
      const b = await r.blob();
      return await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.onerror = rej;
        fr.readAsDataURL(b);
      });
    } catch (e) { return url; }
  };

  const out = [];
  for (const r of rows) out.push({ name: clean(r.name), logo: await inline(r.src) });

  const json = JSON.stringify({ source: location.href, rows: out });
  try {
    await navigator.clipboard.writeText(json);
    alert(out.length + ' 件をコピーしました。A4ツールの貼り付け欄に ⌘V してください。');
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = json;
    Object.assign(ta.style, { position: 'fixed', top: '10px', left: '10px', width: '90vw', height: '60vh', zIndex: 99999 });
    document.body.appendChild(ta);
    ta.select();
    alert(out.length + ' 件を取り出しました。自動コピーができないので、選択されている内容を ⌘C してください。');
  }
})();
