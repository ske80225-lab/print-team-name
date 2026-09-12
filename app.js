/* 順位表スクショ → A4印刷用一覧
   - エンブレム: ブラウザ内で画像から切り出し（外部送信なし）
   - チーム名/順位: Claude の vision に読ませる
*/

// サーバーレス関数などを経由させる場合はここに自分のURLを入れる。
// 空のままなら Anthropic API を直接呼び、APIキーは利用者のブラウザに保存される。
const PROXY_ENDPOINT = "";

const API_URL = PROXY_ENDPOINT || "https://api.anthropic.com/v1/messages";
const KEY_STORE = "anthropic_api_key";

const $ = s => document.querySelector(s);
// 画面に無い要素にはバインドしない（デザイン変更でパネルを外しても壊れないように）
const on = (sel, ev, fn) => { const el = $(sel); if (el) el.addEventListener(ev, fn); };
const drop = $('#drop'), fileIn = $('#file'), statusEl = $('#status'), listWrap = $('#listWrap');
let items = [];      // {rank, name, logo}
let logoBoxes = [];  // 切り出したエンブレムの位置。OCRで同じ行の文字を探すのに使う

/* ---------- APIキー ---------- */
function savedKey(){ try { return localStorage.getItem(KEY_STORE) || ''; } catch { return ''; } }
function refreshKeyNote(){
  const note = $('#keyNote');
  if (!note) return;                 // キー設定パネルは画面から外してある
  if (PROXY_ENDPOINT){
    note.textContent = 'プロキシ経由で読み取ります。キーの入力は不要です。';
    $('#apikey').closest('.bar').style.display = 'none';
    return;
  }
  const k = savedKey();
  $('#apikey').value = k;
  note.textContent = k
    ? 'キーが保存されています。読み込み時に自動でチーム名を取得します。'
    : 'キーが未設定です。上の「まとめて貼り付け」を使えば、キーなしでも名前を入れられます。';
}
on('#keySave', 'click', () => {
  try { localStorage.setItem(KEY_STORE, $('#apikey').value.trim()); } catch {}
  refreshKeyNote();
  setStatus('APIキーを保存しました。');
});
on('#keyClear', 'click', () => {
  try { localStorage.removeItem(KEY_STORE); } catch {}
  $('#apikey').value = '';
  refreshKeyNote();
  setStatus('APIキーを削除しました。');
});
refreshKeyNote();

function setStatus(msg, isErr){
  statusEl.textContent = msg || '';
  statusEl.className = 'status' + (isErr ? ' err' : '');
}

/* ---------- 入力 ---------- */
drop.addEventListener('click', () => fileIn.click());
drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') fileIn.click(); });
fileIn.addEventListener('change', e => { if (e.target.files[0]) handle(e.target.files[0]); });
['dragenter','dragover'].forEach(t =>
  drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('hot'); }));
['dragleave','drop'].forEach(t =>
  drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('hot'); }));
drop.addEventListener('drop', e => {
  const f = [...(e.dataTransfer.files||[])].find(f => f.type.startsWith('image/'));
  if (f) handle(f);
});
window.addEventListener('paste', e => {
  const it = [...(e.clipboardData.items||[])].find(i => i.type.startsWith('image/'));
  if (it) handle(it.getAsFile());
});

async function handle(file){
  try{
    setStatus('画像を解析中…');
    const img = await loadImage(file);
    const crops = extractLogos(img);
    setStatus(`エンブレム ${crops.length} 個を検出。`);

    let rows = [], local = null;
    if (PROXY_ENDPOINT || savedKey()){
      setStatus(`エンブレム ${crops.length} 個を検出。チーム名を読み取り中…`);
      try { rows = await readTable(img); }
      catch(err){
        console.error(err);
        setStatus('チーム名の読み取りに失敗しました（' + err.message + '）。手入力してください。', true);
      }
    } else if (crops.length){
      // キーが無ければブラウザ内のOCRで読む。無料で、画像はどこにも送られない。
      try { local = await readNamesLocally(img, logoBoxes); }
      catch(err){
        console.error(err);
        setStatus('チーム名の自動読み取りに失敗しました（' + err.message + '）。まとめて貼り付けか手入力で入れてください。', true);
      }
    }

    items = crops.map((c,i) => ({
      rank: rows[i]?.rank ?? (i+1),
      name: rows[i]?.name ?? (local ? local[i] : '') ?? '',
      logo: c
    }));
    for (let i = crops.length; i < rows.length; i++)
      items.push({rank: rows[i].rank ?? (i+1), name: rows[i].name ?? '', logo: null});

    render();
    if (items.length && !statusEl.classList.contains('err'))
      setStatus(`${items.length} 件を読み込みました。内容を確認して書き出してください。`);
    if (!items.length)
      setStatus('表を検出できませんでした。表の部分だけを切り取った画像で試してください。', true);
  }catch(err){
    console.error(err);
    setStatus('読み込みに失敗しました: ' + err.message, true);
  }
}

function loadImage(file){
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = r.result; };
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

/* ---------- エンブレム抽出 ---------- */
function extractLogos(img){
  const W = img.naturalWidth, H = img.naturalHeight;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const cx = cv.getContext('2d', {willReadFrequently:true});
  cx.drawImage(img, 0, 0);
  const data = cx.getImageData(0, 0, W, H).data;

  const bg = dominantBackgroundColor(data, W, H);
  const TOL = 42;

  const raw = new Uint8Array(W*H);
  for (let y = 0; y < H; y++){
    for (let x = 0; x < W; x++){
      const i = (y*W+x)*4;
      raw[y*W+x] = (data[i+3] >= 30 &&
        Math.abs(data[i]-bg[0]) + Math.abs(data[i+1]-bg[1]) + Math.abs(data[i+2]-bg[2]) > TOL) ? 1 : 0;
    }
  }

  // 罫線のある表では、全高に通る縦線のせいで行と行の隙間にもインクが乗り続け、
  // 行の帯が切り出せなくなる。構造線は数える対象から外す。
  const ruleCol = new Uint8Array(W);
  for (let x = 0; x < W; x++){
    let n = 0;
    for (let y = 0; y < H; y++) n += raw[y*W+x];
    if (n > H * 0.6) ruleCol[x] = 1;
  }
  thinOnly(ruleCol, Math.max(3, Math.round(W * 0.004)));
  let usableW = 0;
  for (let x = 0; x < W; x++) if (!ruleCol[x]) usableW++;

  const ruleRow = new Uint8Array(H);
  for (let y = 0; y < H; y++){
    let n = 0;
    for (let x = 0; x < W; x++) if (!ruleCol[x]) n += raw[y*W+x];
    if (n > usableW * 0.85) ruleRow[y] = 1;
  }
  thinOnly(ruleRow, Math.max(3, Math.round(H * 0.004)));

  const isInk = (x,y) => !ruleCol[x] && !ruleRow[y] && raw[y*W+x] === 1;

  const rowInk = new Array(H).fill(0);
  for (let y = 0; y < H; y++){
    let n = 0;
    for (let x = 0; x < W; x++) if (isInk(x,y)) n++;
    rowInk[y] = n;
  }
  const minBandH = Math.max(14, H * 0.012);

  const rowThr = Math.max(3, W * 0.012);
  const bands = runs(rowInk.map(v => v > rowThr), 2)
    .filter(b => b[1]-b[0] >= minBandH);
  if (!bands.length) return [];

  // 形の判定は帯ごとの高さではなく、表全体の行の高さ（中央値）を基準にする。
  // 淡い色のエンブレムは帯が短く出るので、その帯だけを基準にすると自分が弾かれる。
  const hs = bands.map(b => b[1]-b[0]).sort((a,b) => a-b);
  const bhRef = hs[hs.length >> 1];

  const perBand = bands.map(([y0,y1]) => {
    const bh = y1 - y0;
    const colInk = new Array(W).fill(0);
    for (let x = 0; x < W; x++){
      let n = 0;
      for (let y = y0; y < y1; y++) if (isInk(x,y)) n++;
      colInk[x] = n;
    }
    const cThr = Math.max(1, bh * 0.03);
    const cols = runs(colInk.map(v => v > cThr), Math.round(bh*0.10)+2);
    const out = [];
    for (const [x0,x1] of cols){
      const box = trim(x0, x1, y0, y1, isInk);
      if (!box) continue;
      const w = box[2]-box[0], h = box[3]-box[1];
      if (h < bhRef*0.40) continue;                     // 順位の数字・矢印は背が低い
      if (w < bhRef*0.42 || w > bhRef*1.75) continue;   // チーム名は横に長い
      out.push({box, score: h/bhRef + Math.min(w,h)/Math.max(w,h)});
    }
    return out;
  });

  const counts = {};
  perBand.forEach(b => { if (b.length) counts[b.length] = (counts[b.length]||0)+1; });
  const K = +Object.keys(counts).sort((a,b) => counts[b]-counts[a] || a-b)[0];
  if (!K) return [];

  const out = [];
  logoBoxes = [];
  perBand.forEach(cands => {
    if (!cands.length) return;
    cands.sort((a,b) => b.score - a.score);
    cands.slice(0, K).sort((a,b) => a.box[0]-b.box[0])
         .forEach(c => { out.push(cropPNG(cx, c.box, bg, TOL)); logoBoxes.push(c.box); });
  });
  return out;
}

// 罫線は細い線。エンブレムが縦にきっちり並んだ列も「ほぼ全部インク」になるため、
// 太い塊まで罫線として消すと、エンブレムごと消えてしまう。細い連なりだけ残す。
function thinOnly(flags, maxRun){
  const n = flags.length;
  let s = -1;
  for (let i = 0; i <= n; i++){
    if (i < n && flags[i]){ if (s < 0) s = i; }
    else if (s >= 0){
      if (i - s > maxRun) for (let j = s; j < i; j++) flags[j] = 0;
      s = -1;
    }
  }
}

// 背景色は画像全体の最頻色から求める。外周1pxだけを見ると、表の枠線や
// 行の区切り線の色を背景と誤認し、以降のインク判定が反転してしまう。
function dominantBackgroundColor(data, W, H){
  const tally = {};
  const step = Math.max(1, Math.round(Math.min(W, H) / 300));
  for (let y = 0; y < H; y += step){
    for (let x = 0; x < W; x += step){
      const i = (y*W+x)*4;
      if (data[i+3] < 30) continue;
      const k = (data[i]>>3)+','+(data[i+1]>>3)+','+(data[i+2]>>3);
      tally[k] = (tally[k]||0)+1;
    }
  }
  const k = Object.keys(tally).sort((a,b) => tally[b]-tally[a])[0] || '31,31,31';
  return k.split(',').map(v => (+v << 3) + 4);
}

function runs(flags, gapTol){
  const out = [];
  let s = -1, gap = 0;
  for (let i = 0; i < flags.length; i++){
    if (flags[i]){ if (s < 0) s = i; gap = 0; }
    else if (s >= 0){
      gap++;
      if (gap > gapTol){ out.push([s, i-gap+1]); s = -1; gap = 0; }
    }
  }
  if (s >= 0) out.push([s, flags.length - gap]);
  return out;
}

function trim(x0, x1, y0, y1, isInk){
  let a = x1, b = x0, c = y1, d = y0, any = false;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++)
      if (isInk(x,y)){
        any = true;
        if (x < a) a = x; if (x+1 > b) b = x+1;
        if (y < c) c = y; if (y+1 > d) d = y+1;
      }
  return any ? [a,c,b,d] : null;
}

function cropPNG(srcCtx, box, bg, tol){
  const [x0,y0,x1,y1] = box;
  const w = x1-x0, h = y1-y0, s = Math.max(w,h);
  const src = srcCtx.getImageData(x0, y0, w, h);
  const d = src.data;
  for (let i = 0; i < d.length; i += 4){
    const diff = Math.abs(d[i]-bg[0]) + Math.abs(d[i+1]-bg[1]) + Math.abs(d[i+2]-bg[2]);
    if (diff <= tol * 0.7) d[i+3] = 0;
  }
  const tmp = document.createElement('canvas');
  tmp.width = w; tmp.height = h;
  tmp.getContext('2d').putImageData(src, 0, 0);

  const out = document.createElement('canvas');
  out.width = out.height = 200;
  const o = out.getContext('2d');
  o.imageSmoothingQuality = 'high';
  const k = 200 / s;
  o.drawImage(tmp, (200 - w*k)/2, (200 - h*k)/2, w*k, h*k);
  return out.toDataURL('image/png');
}

/* ---------- ブラウザ内OCR（無料・外部送信なし） ---------- */
// 画像全体を読んで上から順に当てると行がずれるので、検出済みのエンブレムの
// 位置を基準に「同じ行の、エンブレムより右にある文字」だけを名前として拾う。
async function readNamesLocally(img, boxes){
  if (typeof Tesseract === 'undefined') throw new Error('OCRを読み込めませんでした');

  const W = img.naturalWidth, H = img.naturalHeight;
  const src = document.createElement('canvas');
  src.width = W; src.height = H;
  src.getContext('2d').drawImage(img, 0, 0);

  const regions = boxes.map(b => nameRegion(b, boxes, W, H));

  const worker = await Tesseract.createWorker('jpn', 1, {
    logger: m => { if (m.status && m.status !== 'recognizing text') setStatus(`OCRの準備中…（${m.status}）`); }
  });
  const names = [];
  try {
    await worker.setParameters({ tessedit_pageseg_mode: '7' });  // 1行として読む
    for (let i = 0; i < regions.length; i++){
      setStatus(`チーム名を読み取り中… ${i+1}/${regions.length}`);
      const { data } = await worker.recognize(stripe(src, regions[i]));
      names.push(squeezeJa(cleanName(data.text)));
    }
  } finally {
    await worker.terminate();
  }
  return names;
}

// 名前が書かれている範囲。エンブレムの右から、同じ行の次のエンブレム
// （無ければ画像の右端）まで。順位や矢印はエンブレムの左なので入らない。
function nameRegion(box, boxes, W, H){
  const h = box[3] - box[1], pad = h * 0.18;
  const y0 = Math.max(0, Math.round(box[1] - pad));
  const y1 = Math.min(H, Math.round(box[3] + pad));
  const x0 = Math.min(W - 1, Math.round(box[2] + h * 0.16));
  let x1 = W;
  for (const o of boxes){
    if (o === box) continue;
    const oc = (o[1] + o[3]) / 2;
    if (oc < box[1] || oc > box[3]) continue;          // 別の行
    if (o[0] > box[2] && o[0] < x1) x1 = o[0];         // 同じ行の右隣
  }
  return [x0, y0, Math.max(x0 + 1, Math.round(x1 - h * 0.05)), y1];
}

// 小さい文字は拡大しないと読めない。白地に載せて高さ90px前後に揃える。
function stripe(src, r){
  const [x0,y0,x1,y1] = r;
  const w = x1-x0, h = y1-y0;
  const k = Math.max(1, Math.min(4, 90 / h));
  const cv = document.createElement('canvas');
  cv.width = Math.round(w*k); cv.height = Math.round(h*k);
  const cx = cv.getContext('2d');
  cx.imageSmoothingQuality = 'high';
  cx.fillStyle = '#fff';
  cx.fillRect(0, 0, cv.width, cv.height);
  cx.drawImage(src, x0, y0, w, h, 0, 0, cv.width, cv.height);
  return cv;
}

function pickName(lines, box, k){
  const edge = box[2]*k, y0 = box[1]*k, y1 = box[3]*k;
  const cy = (y0+y1)/2, h = y1-y0;
  let best = '';
  for (const l of lines){
    const bb = l.bbox;
    if (!bb) continue;
    if (Math.abs((bb.y0+bb.y1)/2 - cy) > h*0.6) continue;   // 別の行
    const words = (l.words || []).filter(w => w.bbox && w.bbox.x0 >= edge - h*0.05);
    const src = words.length ? words.map(w => w.text).join(' ')
              : (bb.x0 >= edge - h*0.05 ? l.text : '');
    const t = squeezeJa(cleanName(src));
    if (t.length > best.length) best = t;                   // 一番よく読めた候補を採る
  }
  return best;
}

// 日本語のOCRは文字の間に空白を入れてくる。日本語に隣接する空白だけ詰め、
// 英字どうしの空白（OH LEUVEN など）は残す。
function squeezeJa(s){
  const ja = /[\u3000-\u30ff\u3400-\u9fff\uff00-\uffef]/;
  let out = '';
  for (let i = 0; i < s.length; i++){
    if (s[i] === ' '){
      const a = out[out.length-1] || '', b = s[i+1] || '';
      if (ja.test(a) || ja.test(b)) continue;
    }
    out += s[i];
  }
  return out.trim();
}

/* ---------- チーム名・順位の読み取り ---------- */
async function readTable(img){
  const {b64, mime} = downscale(img);
  const headers = {"Content-Type": "application/json"};
  if (!PROXY_ENDPOINT){
    headers["x-api-key"] = savedKey();
    headers["anthropic-version"] = "2023-06-01";
    headers["anthropic-dangerous-direct-browser-access"] = "true";
  }
  const res = await fetch(API_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 1000,
      messages: [{
        role: "user",
        content: [
          {type: "image", source: {type: "base64", media_type: mime, data: b64}},
          {type: "text", text:
            "この順位表スクリーンショットの各行を読み取り、JSON配列だけを返してください。" +
            "各要素は {\"rank\": 数値または null, \"name\": \"チーム名\"}。" +
            "name は画像の表記そのまま（日本語ならカタカナのまま）。" +
            "順序は必ず読み順（上から下、複数列なら各行で左→右）。" +
            "順位の数字が無い表なら rank は null。" +
            "説明・前置き・コードフェンスは書かず、JSON配列のみ出力すること。"}
        ]
      }]
    })
  });
  if (!res.ok) throw new Error('API ' + res.status);
  const data = await res.json();
  const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  const m = text.replace(/```json|```/g, '').match(/\[[\s\S]*\]/);
  if (!m) throw new Error('JSONを取得できませんでした');
  return JSON.parse(m[0]);
}

function downscale(img){
  const MAX = 1400;
  const k = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
  const cv = document.createElement('canvas');
  cv.width = Math.round(img.naturalWidth * k);
  cv.height = Math.round(img.naturalHeight * k);
  cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
  return {b64: cv.toDataURL('image/jpeg', 0.9).split(',')[1], mime: 'image/jpeg'};
}

/* ---------- 編集リスト ---------- */
function render(){
  if (!items.length){
    listWrap.innerHTML = '<p class="empty">まだ何も読み込まれていません。</p>';
    toggle(false);
    return;
  }
  const t = document.createElement('table');
  t.className = 'edit';
  t.innerHTML = '<thead><tr><th style="width:60px">順位</th><th style="width:46px"></th><th>チーム名</th><th style="width:52px"></th></tr></thead>';
  const tb = document.createElement('tbody');
  items.forEach((it, i) => {
    const tr = document.createElement('tr');

    const tdR = document.createElement('td');
    tdR.className = 'rk';
    const ir = document.createElement('input');
    ir.type = 'text'; ir.value = it.rank ?? '';
    ir.addEventListener('input', () => items[i].rank = ir.value);
    tdR.appendChild(ir);

    const tdL = document.createElement('td');
    if (it.logo){ const im = new Image(); im.src = it.logo; im.alt = ''; tdL.appendChild(im); }

    const tdN = document.createElement('td');
    const inp = document.createElement('input');
    inp.type = 'text'; inp.value = it.name || '';
    inp.addEventListener('input', () => items[i].name = inp.value);
    tdN.appendChild(inp);

    const tdD = document.createElement('td');
    tdD.className = 'del';
    const b = document.createElement('button');
    b.textContent = '削除';
    b.addEventListener('click', () => { items.splice(i,1); render(); });
    tdD.appendChild(b);

    tr.append(tdR, tdL, tdN, tdD);
    tb.appendChild(tr);
  });
  t.appendChild(tb);
  listWrap.innerHTML = '';
  listWrap.appendChild(t);
  toggle(true);
}
function toggle(enabled){ ['#print','#dl','#open','#add'].forEach(s => { const el = $(s); if (el) el.disabled = !enabled; }); }

/* ---------- チーム名の一括流し込み ---------- */
// macOS のテキスト認識表示で拾った文字列をそのまま受ける想定。順位の数字や
// 増減の矢印しか入っていない行は捨て、行頭に付いた順位は落とす。
const JUNK = /^[\s0-9.,:：・\-–—ー+↑↓▲▼△▽=＝%％*＊]+$/;
const LEAD_RANK = /^\s*\d{1,3}\s*[.．:：、,]?[\s\u3000]+/;

// 順位だけ・矢印だけの行を捨て、行頭に付いた順位を落とす。OCRの結果にも使う。
function cleanName(s){
  const t = String(s ?? '').replace(/[\u3000\s]+/g, ' ').trim();
  if (!t || JUNK.test(t)) return '';
  return t.replace(LEAD_RANK, '').replace(/^[、。,.:：;；・…_|\\\[\]{}<>↑↓→←▲▼△▽=＝\-–—\s]+/, '').trim();
}

function bulkNames(text){
  return text.split(/\r?\n/).map(cleanName).filter(Boolean);
}

/* ---------- 順位表ページのURLから取り込む ---------- */
// ブラウザは他サイトのHTMLを直接読めない（CORS）ので、取得サービスを1つ挟む。
// 返ってくるのはMarkdown化されたページで、表の行にチームへのリンクが残る。
const READER = 'https://r.jina.ai/';

// エンブレムはCSSの背景画像なのでMarkdownには出てこない。チームへのリンクから組み立てる。
// 区分はリーグごとに違う（海外は /ws/、Jリーグは /jleague/）ので、URLから取り出す。
//   https://soccer.yahoo.co.jp/jleague/team/199
//     → https://s.yimg.jp/images/sports/soccer/jleague/logo/team/120/199.png
function logoFromTeamUrl(teamUrl){
  const m = /soccer\.yahoo\.co\.jp\/([^/]+)\/team\/(\d+)/.exec(teamUrl || '');
  if (!m) return null;
  return 'https://s.yimg.jp/images/sports/soccer/' + m[1] + '/logo/team/120/' + m[2] + '.png';
}

function parseStandings(md){
  const rows = [], seen = new Set();
  for (const line of md.split('\n')){
    if (line.indexOf('|') < 0) continue;          // 表の行だけ見る（ナビのリンクを拾わない）
    const re = /\[([^\]]*)\]\((https?:\/\/[^)]*?\/team\/(\d+))\)/g;
    let m, last = null;
    while ((m = re.exec(line))) if (cleanName(m[1])) last = m;
    if (!last) continue;
    const id = last[3];
    if (seen.has(id)) continue;                   // 同じページの別の表（日程や得点者）に出てくる分
    seen.add(id);
    rows.push({ rank: '', name: cleanName(last[1]), logo: logoFromTeamUrl(last[2]) });
  }
  return rows;
}

on('#grabRun', 'click', async () => {
  const url = $('#pageUrl').value.trim();
  if (!/^https?:\/\//.test(url)){ setStatus('順位表ページのURLを貼ってください。', true); return; }
  const btn = $('#grabRun');
  btn.disabled = true;
  try {
    setStatus('順位表ページを読み込み中…');
    const res = await fetch(READER + url, { headers: { Accept: 'text/plain' } });
    if (!res.ok) throw new Error('取得に失敗しました（' + res.status + '）');
    const rows = parseStandings(await res.text());
    if (!rows.length) throw new Error('順位表を見つけられませんでした');
    items = rows;
    render();
    const noLogo = items.filter(it => !it.logo).length;
    setStatus(`${items.length} 件を取り込みました。` +
      (noLogo ? `エンブレムは ${noLogo} 件が未対応のサイト形式のため空です。` :
                'エンブレムはURL参照です（印刷時にネット接続が要ります）。'));
  } catch (err){
    console.error(err);
    setStatus('読み込めませんでした（' + err.message + '）。ブックマークレットかスクショをお試しください。', true);
  } finally {
    btn.disabled = false;
  }
});

// ブックマークレットが出す JSON。名前だけでなくエンブレムも入っている。
function importGrabbed(text){
  let d;
  try { d = JSON.parse(text); } catch (e) { return null; }
  const rows = Array.isArray(d) ? d : (d && Array.isArray(d.rows) ? d.rows : null);
  if (!rows) return null;
  return rows
    .map(r => ({
      rank: r && r.rank != null ? r.rank : '',
      name: cleanName(r && r.name),
      logo: r && typeof r.logo === 'string' && r.logo ? r.logo : null
    }))
    .filter(r => r.name || r.logo);
}

on('#bulkApply', 'click', () => {
  const grabbed = importGrabbed($('#bulk').value);
  if (grabbed){
    if (!grabbed.length){ setStatus('取り込める行がありませんでした。', true); return; }
    items = grabbed;
    render();
    const embedded = items.filter(it => it.logo && it.logo.startsWith('data:')).length;
    setStatus(`${items.length} 件を取り込みました。` +
      (embedded < items.length
        ? `エンブレム ${items.length - embedded} 件はURL参照のままです（印刷時にネット接続が要ります）。`
        : ''));
    return;
  }

  const names = bulkNames($('#bulk').value);
  if (!names.length){ setStatus('貼り付けられた名前がありません。', true); return; }
  const before = items.length;
  names.forEach((n, i) => {
    if (items[i]) items[i].name = n;
    else items.push({rank:'', name:n, logo:null});
  });
  render();
  const rest = before - names.length;
  setStatus(`${names.length} 件の名前を流し込みました。` +
    (rest > 0 ? `残り ${rest} 件は空のままです。` : '') +
    (names.length > before ? `エンブレムのない行を ${names.length - before} 件足しました。` : ''));
});

on('#bulkClear', 'click', () => { $('#bulk').value = ''; setStatus(''); });

on('#add', 'click', () => { items.push({rank:'', name:'', logo:null}); render(); });

/* ---------- A4出力 ---------- */
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

// 紙面の中身。別タブ用のHTMLと、このページでそのまま印刷する分で同じものを使う。
function sheetInner(){
  const title = $('#title').value || '';
  const cols = Math.min(3, Math.max(1, +$('#cols').value || 2));
  const per = Math.ceil(items.length / cols);
  // 順位が1件も入っていない一覧では、順位の列ごと省いて名前に幅を回す。
  const hasRank = items.some(it => String(it.rank ?? '').trim() !== '');

  let tables = '';
  for (let c = 0; c < cols; c++){
    const slice = items.slice(c*per, (c+1)*per);
    if (!slice.length) continue;
    const rows = slice.map(it => `        <tr>
${hasRank ? `          <td class="rank">${esc(it.rank)}</td>\n` : ''}          <td class="lg">${it.logo ? `<img src="${it.logo}" alt="">` : ''}</td>
          <td class="nm">${esc(it.name)}</td>
        </tr>`).join('\n');
    tables += `    <table>
      <colgroup>${hasRank ? '<col class="c-rank">' : ''}<col class="c-lg"><col></colgroup>
      <tbody>
${rows}
      </tbody>
    </table>\n`;
  }

  return `<div class="sheet">
  <h1>${esc(title)}</h1>
  <p class="sub">全${items.length}件</p>
  <div class="grid" style="grid-template-columns:repeat(${cols},1fr)">
${tables}  </div>
</div>`;
}

function buildHTML(){
  const title = $('#title').value || '';
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>
  @page { size: A4 portrait; margin: 13mm 11mm; }
  :root{ --line:#d9dce1; --text:#1f3fa8; }
  html,body{margin:0;padding:0;background:#fff;}
  body{
    font-family:"Hiragino Kaku Gothic ProN","Yu Gothic","Meiryo",sans-serif;
    color:#222;
    -webkit-print-color-adjust:exact; print-color-adjust:exact;
  }
  .sheet{width:188mm;margin:0 auto;}
  h1{font-size:13pt;font-weight:600;margin:0 0 1mm;letter-spacing:.03em;}
  .sub{font-size:8pt;color:#6b7280;margin:0 0 3.5mm;}
  .grid{display:grid;column-gap:5mm;}
  table{width:100%;border-collapse:collapse;table-layout:fixed;}
  col.c-rank{width:9mm;} col.c-lg{width:15mm;}
  td{border:1px solid var(--line);height:12.4mm;vertical-align:middle;padding:0;background:#fff;}
  .rank{text-align:center;font-size:10pt;font-weight:600;color:#000;}
  .lg{text-align:center;}
  .lg img{width:10.5mm;height:10.5mm;object-fit:contain;display:block;margin:0 auto;}
  .nm{color:var(--text);font-size:10.5pt;font-weight:500;padding-left:2.5mm;}
</style>
</head>
<body>
${sheetInner()}
</body>
</html>`;
}

on('#dl', 'click', () => {
  const blob = new Blob([buildHTML()], {type:'text/html'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'a4_table.html';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
});

on('#open', 'click', () => {
  const w = window.open('', '_blank');
  if (!w){ setStatus('ポップアップがブロックされました。ダウンロードから開いてください。', true); return; }
  w.document.write(buildHTML());
  w.document.close();
});


/* ---------- このまま印刷（スマホ対応） ---------- */
// スマホのブラウザは window.open + document.write をブロックすることが多い。
// 同じ紙面をこのページの中に組み、ブラウザの印刷機能へ直接渡す。
async function waitImages(root){
  const imgs = [...root.querySelectorAll('img')].filter(im => !im.complete);
  if (!imgs.length) return;
  await Promise.race([
    Promise.all(imgs.map(im => new Promise(r => { im.onload = im.onerror = r; }))),
    new Promise(r => setTimeout(r, 6000))
  ]);
}

on('#print', 'click', async () => {
  if (!items.length){ setStatus('先に一覧を作ってください。', true); return; }
  const area = $('#printArea');
  area.innerHTML = sheetInner();
  setStatus('印刷の準備中…');
  await waitImages(area);
  setStatus('印刷ダイアログを開きました。出ない場合はブラウザの共有メニューから「プリント」を選んでください。');
  window.print();
});

/* ---------- 手動で追加 ---------- */
let manualLogo = null;

on('#manualPick', 'click', () => $('#manualLogo').click());

on('#manualLogo', 'change', async e => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';                       // 同じ画像をもう一度選べるように
  if (!f) return;
  try {
    const img = await loadImage(f);
    manualLogo = squarePNG(img);
    const pv = $('#manualPreview');
    pv.src = manualLogo; pv.hidden = false;
    $('#manualPickLabel').hidden = true;
    setStatus('エンブレムを読み込みました。チーム名を入れて「一覧に追加」を押してください。');
  } catch (err){
    console.error(err);
    setStatus('画像を読み込めませんでした。', true);
  }
});

// 印刷の枠は正方形。余白を足して縦横を揃えておくと、行ごとに大きさがぶれない。
function squarePNG(img){
  const w = img.naturalWidth, h = img.naturalHeight, s = Math.max(w, h);
  const cv = document.createElement('canvas');
  cv.width = cv.height = 200;
  const cx = cv.getContext('2d');
  cx.imageSmoothingQuality = 'high';
  const k = 200 / s;
  cx.drawImage(img, (200 - w*k)/2, (200 - h*k)/2, w*k, h*k);
  return cv.toDataURL('image/png');
}

function clearManual(){
  manualLogo = null;
  const pv = $('#manualPreview');
  pv.removeAttribute('src'); pv.hidden = true;
  $('#manualPickLabel').hidden = false;
  $('#manualName').value = '';
  $('#manualRank').value = '';
}

function manualAdd(){
  const name = $('#manualName').value.trim();
  const rank = $('#manualRank').value.trim();
  if (!name && !manualLogo){
    setStatus('チーム名かエンブレムのどちらかを入れてください。', true);
    return;
  }
  items.push({ rank, name, logo: manualLogo });
  render();
  clearManual();
  setStatus(`手動で1件追加しました（全${items.length}件）。`);
  $('#manualName').focus();
}

on('#manualAdd', 'click', manualAdd);
on('#manualName', 'keydown', e => { if (e.key === 'Enter') manualAdd(); });
on('#manualRank', 'keydown', e => { if (e.key === 'Enter') manualAdd(); });
