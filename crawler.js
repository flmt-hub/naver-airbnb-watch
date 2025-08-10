// m.land 클러스터 + mapKey + 리다이렉트 follow + 모바일 UA
// + 초강력 ID 파서(Any→IDs) + 상세 HTML 수집(주소/특징/옵션/관리비/입주일/사진수)
// + Playwright 폴백(상세 일부 실패 시) + CSV UTF-8 with BOM + KST 날짜 정규화
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

// ===== 입력(워크플로 inputs/ENV로 덮어쓰기 가능) =====
const DIST = (process.env.DIST_CODES || '1144000000').split(',').map(s=>s.trim()).filter(Boolean); // 마포구
const TYPES = (process.env.TYPES || 'OR').split(',').map(s=>s.trim()).filter(Boolean);            // 원룸
const TRADE = (process.env.TRADE || 'B2').split(',').map(s=>s.trim()).filter(Boolean);            // 월세
const MAX_PAGES = parseInt(process.env.MAX_PAGES || '40', 10);
const GRID = parseInt(process.env.GRID || '3', 10);   // 지도 타일 분해(3~4 추천)
const DETAIL_BROWSER_LIMIT = parseInt(process.env.DETAIL_BROWSER_LIMIT || '12', 10); // 브라우저 폴백 상한

const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
const CSV_BOM = '\uFEFF'; // Excel 한글 깨짐 방지

// ── 날짜 유틸: KST 기준 ───────────────────────────────────────────────
function todayKST() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9*60*60*1000);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth()+1).padStart(2,'0');
  const d = String(kst.getUTCDate()).padStart(2,'0');
  return `${y}-${m}-${d}`;
}
function todayYmdKST() { return todayKST().replace(/-/g,''); }
function normYmd(v){
  if (!v) return '';
  const s = String(v).trim();
  let m = s.match(/^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return s;
}

// ── 공통 ──────────────────────────────────────────────────────────────
function headers(lat, lon, z) {
  return {
    'User-Agent': MOBILE_UA,
    'Accept-Language': 'ko-KR,ko;q=0.9',
    'Accept': 'application/json, text/plain, */*',
    'Referer': `https://m.land.naver.com/map/${lat},${lon},${z}/`,
    'Origin': 'https://m.land.naver.com',
    'X-Requested-With': 'XMLHttpRequest',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty'
  };
}
function esc(s){ return String(s==null?'':s).replace(/"/g,'""'); }
function toCSV(arr){
  const cols=[
    'date','articleNo','title','type','deposit','rent','area_m2','floor',
    'address','roadAddress','jibunAddress','manageFee','availableDate',
    'options','imagesCount','description','realtor','postedYmd','updatedYmd','link'
  ];
  const lines=[cols.join(',')].concat(arr.map(o=>cols.map(c=>`"${esc(o[c])}"`).join(',')));
  return lines.join('\n');
}
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

// ── 초강력 파서 (JSON/HTML/이스케이프 모두 커버) ───────────────────────
function parseAnyToIds(payload) {
  let s = '';
  if (typeof payload === 'string') s = payload;
  else { try { s = JSON.stringify(payload); } catch { s = ''; } }
  if (!s) return [];
  const ids = new Set();
  let m;
  const reAttrOrLink = /(?:data-(?:article|atcl)-no=["']?|\/article\/info\/)(\d{7,})/g;
  while ((m = reAttrOrLink.exec(s)) !== null) ids.add(m[1]);
  const reJsonKey = /(?:"|')(?:atclNo|articleNo)(?:"|')\s*[:=]\s*(?:"|')?(\d{7,})/g;
  while ((m = reJsonKey.exec(s)) !== null) ids.add(m[1]);
  const reEscLink = /\\\/article\\\/info\\\/(\d{7,})/g;
  while ((m = reEscLink.exec(s)) !== null) ids.add(m[1]);
  return Array.from(ids).map(id => ({ atclNo: id }));
}
function parseArticleList(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.list)) return payload.list;
    if (Array.isArray(payload.articles)) return payload.articles;
    if (Array.isArray(payload.body)) return payload.body;
    if (Array.isArray(payload.data)) return payload.data;
    const html = payload.html || payload.body || payload.result || payload.listHtml || payload.renderedList || payload.itemsHtml;
    if (typeof html === 'string') return parseAnyToIds(html);
    return parseAnyToIds(payload);
  }
  if (typeof payload === 'string') return parseAnyToIds(payload);
  return [];
}
function pick(...vals){ for(const v of vals){ if(v!==undefined && v!==null && v!=='') return v; } return ''; }

// ── 모바일 지도 파라미터 ────────────────────────────────────────────
async function getFilterByKeyword(keyword){
  const r = await fetch(`https://m.land.naver.com/search/result/${encodeURIComponent(keyword)}`, {
    headers: headers(37.5665,126.9780,12), redirect: 'follow'
  });
  const html = await r.text();
  const m = html.match(/filter:\s*\{([\s\S]*?)\}/);
  if(!m) throw new Error('filter block not found');
  const raw = m[1].replace(/[\s'"]/g,'');
  const grab = (k) => { const mm = raw.match(new RegExp(`${k}:([^,}]+)`)); return mm ? mm[1] : ''; };
  const lat = parseFloat(grab('lat')), lon = parseFloat(grab('lon')), z = grab('z') || '12';
  const lat_margin = 0.118, lon_margin = 0.111;
  return { lat, lon, z,
    btm: (lat-lat_margin).toFixed(6),
    lft: (lon-lon_margin).toFixed(6),
    top: (lat+lat_margin).toFixed(6),
    rgt: (lon+lon_margin).toFixed(6)
  };
}
function splitGrid({btm,lft,top,rgt}, n){
  const B = parseFloat(btm), L = parseFloat(lft), T = parseFloat(top), R = parseFloat(rgt);
  const tiles = [];
  for(let i=0;i<n;i++){
    for(let j=0;j<n;j++){
      const b = B + (T-B)*(i/n);
      const t = B + (T-B)*((i+1)/n);
      const l = L + (R-L)*(j/n);
      const r = L + (R-L)*((j+1)/n);
      tiles.push({ btm: b.toFixed(6), lft: l.toFixed(6), top: t.toFixed(6), rgt: r.toFixed(6) });
    }
  }
  return tiles;
}

// ── 클러스터/리스트 호출 ────────────────────────────────────────────
async function fetchClusterList(tile, rletTpCd, tradTpCd, z, lat, lon){
  const u = new URL('https://m.land.naver.com/cluster/clusterList');
  u.searchParams.set('view','atcl');
  u.searchParams.set('cortarNo','');
  u.searchParams.set('rletTpCd', rletTpCd);
  u.searchParams.set('tradTpCd', tradTpCd);
  u.searchParams.set('z', z);
  u.searchParams.set('lat', lat);
  u.searchParams.set('lon', lon);
  u.searchParams.set('btm', tile.btm);
  u.searchParams.set('lft', tile.lft);
  u.searchParams.set('top', tile.top);
  u.searchParams.set('rgt', tile.rgt);

  const r = await fetch(u, { headers: headers(lat,lon,z), redirect:'follow' });
  if(!r.ok) throw new Error(`clusterList ${r.status}`);
  const j = await r.json();
  const data = j?.data || j?.result || j;
  const groups = data?.ARTICLE || data?.article || [];
  const mapKey = data?.mapKey || data?.MAP_KEY || j?.mapKey || '';
  return { groups, mapKey };
}
async function fetchArticleListRaw(lgeo, mapKey, z, lat, lon, count, tile, rletTpCd, tradTpCd, page){
  const u = new URL('https://m.land.naver.com/cluster/ajax/articleList');
  u.searchParams.set('itemId', lgeo);
  u.searchParams.set('mapKey', mapKey || '');
  u.searchParams.set('lgeo', lgeo);
  u.searchParams.set('showR0','');
  u.searchParams.set('rletTpCd', rletTpCd);
  u.searchParams.set('tradTpCd', tradTpCd);
  u.searchParams.set('z', z);
  u.searchParams.set('lat', lat);
  u.searchParams.set('lon', lon);
  u.searchParams.set('totCnt', count);
  u.searchParams.set('cortarNo', '');
  u.searchParams.set('page', String(page));
  u.searchParams.set('btm', tile.btm);
  u.searchParams.set('lft', tile.lft);
  u.searchParams.set('top', tile.top);
  u.searchParams.set('rgt', tile.rgt);

  const r = await fetch(u, { headers: headers(lat,lon,z), redirect:'follow' });
  return await r.text(); // JSON 또는 HTML
}

// ── 상세 페이지 수집(HTML) ───────────────────────────────────────────
function stripTags(html){
  return html.replace(/<script[\s\S]*?<\/script>/gi,' ')
             .replace(/<style[\s\S]*?<\/style>/gi,' ')
             .replace(/<[^>]+>/g,'\n')
             .replace(/\u00a0/g,' ')
             .replace(/\s+\n/g,'\n')
             .replace(/\n{2,}/g,'\n')
             .trim();
}
function grabAfter(label, text){
  const idx = text.indexOf(label);
  if (idx < 0) return '';
  const tail = text.slice(idx + label.length);
  const stopIdx = (() => {
    const stops = ['옵션','가전','가구','관리비','입주','중개','사진','위치','주소','로드뷰','문의','매물번호','매물정보','가격','면적','층','\n\n'];
    let k = tail.length;
    for (const s of stops){
      const p = tail.indexOf(s);
      if (p >= 0 && p < k) k = p;
    }
    return k;
  })();
  return tail.slice(0, stopIdx).trim();
}
function parseDetailFromHtml(html){
  const text = stripTags(html);
  // 주소
  let roadAddress = '', jibunAddress = '';
  const mRoad = text.match(/도로명\s*주소?\s*[:：]?\s*([^\n]+)/);
  if (mRoad) roadAddress = mRoad[1].trim();
  const mJibun = text.match(/지번\s*주소?\s*[:：]?\s*([^\n]+)/);
  if (mJibun) jibunAddress = mJibun[1].trim();
  if (!roadAddress) {
    const m1 = text.match(/도로명\s*([^\n]+)/); if (m1) roadAddress = m1[1].trim();
  }
  if (!jibunAddress) {
    const m2 = text.match(/지번\s*([^\n]+)/); if (m2) jibunAddress = m2[1].trim();
  }
  // 특징(설명)
  let description = grabAfter('매물특징', text);
  if (!description || description.length < 3) {
    const mDesc = text.match(/매물특징\s*[:：]?\s*([^\n]+)/);
    if (mDesc) description = mDesc[1].trim();
  }
  // 옵션(가전/가구)
  let options = grabAfter('옵션', text);
  if (!options || options.length < 2) {
    const mOpt = text.match(/옵션\s*[:：]?\s*([^\n]+)/);
    if (mOpt) options = mOpt[1].trim();
  }
  options = options.replace(/·/g, ', ').replace(/\s{2,}/g,' ').replace(/,\s*,/g, ',').replace(/^,|,$/g,'').trim();

  // 관리비 / 입주일
  let manageFee = '';
  const mFee = text.match(/관리비\s*[:：]?\s*([^\n]+)/);
  if (mFee) manageFee = mFee[1].trim();

  let availableDate = '';
  const mAvail = text.match(/(입주가능일|입주일)\s*[:：]?\s*([^\n]+)/);
  if (mAvail) availableDate = mAvail[2].trim();

  // 사진 개수(대략) - 갤러리에서 img/thumbnail 흔적 위주로
  let imagesCount = 0;
  const reImg = /(data-src=|src=)["'][^"']+(land|thumb|image|photo|gallery)[^"']*["']/gi;
  let mi; while((mi = reImg.exec(html)) !== null) imagesCount++;

  return { roadAddress, jibunAddress, description, options, manageFee, availableDate, imagesCount };
}
async function fetchDetailHtml(id, lat, lon, z, sampleSaver){
  const url = `https://m.land.naver.com/article/info/${id}`;
  const r = await fetch(url, { headers: headers(lat,lon,z), redirect:'follow' });
  const html = await r.text();
  if (sampleSaver) sampleSaver(html);
  return parseDetailFromHtml(html);
}

// ── Playwright 폴백(상세 페이지 일부) ─────────────────────────────────
async function fetchDetailInBrowser(id, browserCtx, sampleSaver){
  const page = await browserCtx.newPage();
  await page.goto(`https://m.land.naver.com/article/info/${id}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  // 본문 전체 텍스트를 얻어서 같은 파서에 통과
  const html = await page.content();
  if (sampleSaver) sampleSaver(html);
  const out = parseDetailFromHtml(html);
  await page.close();
  return out;
}

// ── Playwright 폴백(리스트 API) ─────────────────────────────────────
async function retryListInBrowser(keyword, tiles, rlet, trad, z, lat, lon, sampleLimit=3){
  const browser = await chromium.launch({ headless: true, args: ['--lang=ko-KR'] });
  const ctx = await browser.newContext({
    locale: 'ko-KR', userAgent: MOBILE_UA,
    viewport: { width: 390, height: 720 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true
  });
  const page = await ctx.newPage();
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'ko-KR,ko;q=0.9' });
  await page.goto(`https://m.land.naver.com/search/result/${encodeURIComponent(keyword)}`, { waitUntil: 'domcontentloaded' });

  const out = [];
  let saved = 0;

  for (const tile of tiles) {
    const { groups, mapKey } = await page.evaluate(async (args) => {
      const { tile, rlet, trad, z, lat, lon } = args;
      const params = new URLSearchParams({
        view: 'atcl', cortarNo: '', rletTpCd: rlet, tradTpCd: trad,
        z: String(z), lat: String(lat), lon: String(lon),
        btm: tile.btm, lft: tile.lft, top: tile.top, rgt: tile.rgt
      });
      const r = await fetch('https://m.land.naver.com/cluster/clusterList?' + params.toString(), { credentials:'include' });
      if (!r.ok) return { groups: [], mapKey: '' };
      const j = await r.json().catch(()=>null);
      const data = j?.data || j;
      return {
        groups: (data && data.ARTICLE) ? data.ARTICLE : [],
        mapKey: (data && (data.mapKey || data.MAP_KEY)) ? (data.mapKey || data.MAP_KEY) : ''
      };
    }, { tile, rlet, trad, z, lat, lon });

    for (const g of groups) {
      const lgeo = String(g.lgeo), count = Number(g.count || 0);
      const pages = Math.min(Math.ceil(count / 20), MAX_PAGES);

      for (let pageIndex = 1; pageIndex <= pages; pageIndex++) {
        const raw = await page.evaluate(async (args) => {
          const { lgeo, z, lat, lon, count, tile, rlet, trad, pageIndex, mapKey } = args;
          const q = new URLSearchParams({
            itemId: lgeo, mapKey: mapKey || '', lgeo, showR0: '',
            rletTpCd: rlet, tradTpCd: trad,
            z: String(z), lat: String(lat), lon: String(lon),
            totCnt: String(count), cortarNo: '', page: String(pageIndex),
            btm: tile.btm, lft: tile.lft, top: tile.top, rgt: tile.rgt
          });
          const r = await fetch('https://m.land.naver.com/cluster/ajax/articleList?' + q.toString(), { credentials:'include' });
          return await r.text();
        }, { lgeo, z, lat, lon, count, tile, rlet, trad, pageIndex, mapKey });

        if (saved < sampleLimit) {
          fs.mkdirSync('samples', { recursive: true });
          fs.writeFileSync(path.join('samples', `articleList_browser_${lgeo}_${pageIndex}.txt`), raw, 'utf8');
          saved++;
        }

        let parsed;
        try { parsed = parseArticleList(JSON.parse(raw)); }
        catch { parsed = parseArticleList(raw); }

        for (const it of parsed) {
          const id = String(it.atclNo || it.articleNo || '');
          if (id) out.push({ id });
        }
        await page.waitForTimeout(150);
      }
    }
  }

  await browser.close();
  return out;
}

// ── 메인 ────────────────────────────────────────────────────────────
async function main(){
  const startedAt = new Date().toISOString();
  const debug = {
    startedAt,
    mode:'mobile-cluster+grid+mapKey+redir+anyparser+detail+kst+bom',
    params:{DIST,TYPES,TRADE,MAX_PAGES,GRID,DETAIL_BROWSER_LIMIT},
    tiles:0, groups:0, combos:[], pushed:0, notes:[],
    details:{ tried:0, htmlOk:0, browserOk:0 }
  };

  const seen = new Set(fs.existsSync('seen_ids.json') ? JSON.parse(fs.readFileSync('seen_ids.json','utf8')).map(String) : []);
  const rows = [];
  const byId = new Map();

  // 1) ID 수집
  for(const code of DIST){
    const keyword = '마포구';
    const f = await getFilterByKeyword(keyword);
    const tiles = splitGrid(f, GRID);
    debug.tiles += tiles.length;

    for(const rlet of TYPES){
      for(const trad of TRADE){
        for(const tile of tiles){
          let groups=[], mapKey='';
          try {
            const r = await fetchClusterList(tile, rlet, trad, f.z, f.lat, f.lon);
            groups = r.groups; mapKey = r.mapKey || mapKey;
          } catch(e) {
            debug.notes.push('clusterList-fail:'+e.message);
            continue;
          }
          debug.groups += groups.length;

          for(const g of groups){
            const lgeo = String(g.lgeo), count = Number(g.count||0);
            const pages = Math.min(Math.ceil(count/20), MAX_PAGES);
            for(let idx=1; idx<=pages; idx++){
              let raw = '';
              try {
                raw = await fetchArticleListRaw(lgeo, mapKey, f.z, f.lat, f.lon, count, tile, rlet, trad, idx);
              } catch(e) {
                debug.notes.push('articleList-fail:'+e.message);
                continue;
              }
              if (debug.pushed < 5) {
                fs.mkdirSync('samples', {recursive:true});
                fs.writeFileSync(path.join('samples', `articleList_${lgeo}_${idx}.txt`), raw, 'utf8');
              }
              let parsed;
              try { parsed = parseArticleList(JSON.parse(raw)); }
              catch { parsed = parseArticleList(raw); }
              debug.combos.push({ code, rlet, trad, lgeo, page: idx, parsed: Array.isArray(parsed)? parsed.length : 0 });
              let added = 0;
              for(const it of (Array.isArray(parsed) ? parsed : [])){
                const id = String(it.atclNo || it.articleNo || '');
                if(!id || byId.has(id)) continue;
                byId.set(id, it); added++;
              }
              debug.pushed += added;
              await sleep(150);
            }
          }

          // 리스트가 아무것도 안 나오면 브라우저 폴백으로라도 ID 확보
          if (byId.size === 0) {
            const browserHits = await retryListInBrowser(keyword, [tile], rlet, trad, f.z, f.lat, f.lon);
            for(const {id} of browserHits){ if(!byId.has(id)) byId.set(id, { atclNo: id }); }
            debug.notes.push(`browser-list-fallback-used:${byId.size}`);
          }
        }
      }
    }
  }

  // 2) 상세 수집(HTML) + 일부 브라우저 폴백
  let browser = null, browserCtx = null, browserUsed = 0;
  async function ensureBrowser(){
    if (!browser){
      browser = await chromium.launch({ headless: true, args: ['--lang=ko-KR'] });
      browserCtx = await browser.newContext({
        locale:'ko-KR', userAgent: MOBILE_UA,
        viewport:{ width: 390, height: 720 }, deviceScaleFactor:2, isMobile:true, hasTouch:true
      });
      await browserCtx.setExtraHTTPHeaders({ 'Accept-Language': 'ko-KR,ko;q=0.9' });
    }
  }

  const dKST = todayKST();
  const dFile = todayYmdKST();

  for(const [id, it] of byId.entries()){
    // 목록 기반 기본값
    let title   = pick(it.atclNm, it.articleName, it.cmplxNm, '');
    let typeNm  = pick(it.rletTpNm, '');
    let deposit = pick(it.hanPrc, '');
    let rent    = pick(it.rentPrc, '');
    let area    = pick(it.spc2, it.area2, it.spc1, it.area1, '');
    let floor   = pick(it.flrInfo, it.floor, '');
    let addr    = pick(it.ldongNm, it.ctpvNm, it.bldrNm, '');
    let realtor = pick(it.rltrNm, '');
    let postedY = normYmd(pick(it.registYmd, it.prdYmd, ''));
    let updatedY= '';

    // 상세 보강
    debug.details.tried++;
    let roadAddress='', jibunAddress='', description='', options='', manageFee='', availableDate='', imagesCount=0;

    try{
      const det = await fetchDetailHtml(id, 37.5665,126.9780,12, (html)=>{
        if (debug.details.htmlOk < 2) { // 샘플 몇 개만 저장
          fs.mkdirSync('samples', {recursive:true});
          fs.writeFileSync(path.join('samples', `detail_${id}.html`), html, 'utf8');
        }
      });
      ({ roadAddress, jibunAddress, description, options, manageFee, availableDate, imagesCount } = det);
      if (roadAddress || jibunAddress || description) debug.details.htmlOk++;
    }catch(e){
      // 무시하고 폴백 고려
    }

    // 폴백: 핵심(주소/설명)이 둘 다 비어 있으면 브라우저로 재시도 (상한 제한)
    if (!roadAddress && !description && browserUsed < DETAIL_BROWSER_LIMIT){
      try{
        await ensureBrowser();
        const det2 = await fetchDetailInBrowser(id, browserCtx, (html)=>{
          if (browserUsed < 2) {
            fs.mkdirSync('samples', {recursive:true});
            fs.writeFileSync(path.join('samples', `detail_browser_${id}.html`), html, 'utf8');
          }
        });
        if (det2){
          if (!roadAddress) roadAddress = det2.roadAddress;
          if (!jibunAddress) jibunAddress = det2.jibunAddress;
          if (!description) description = det2.description;
          if (!options) options = det2.options;
          if (!manageFee) manageFee = det2.manageFee;
          if (!availableDate) availableDate = det2.availableDate;
          if (!imagesCount) imagesCount = det2.imagesCount || 0;
          debug.details.browserOk++;
          browserUsed++;
        }
      }catch(e){
        debug.notes.push(`detail-browser-fail:${id}:${e.message||e}`);
      }
    }

    rows.push({
      date: dKST,
      articleNo: id,
      title, type: typeNm, deposit, rent,
      area_m2: area, floor,
      address: addr,
      roadAddress, jibunAddress,
      manageFee, availableDate,
      options, imagesCount,
      description,
      realtor,
      postedYmd: postedY,
      updatedYmd: updatedY,
      link: `https://m.land.naver.com/article/info/${id}`
    });

    await sleep(200);
  }

  if (browser) await browser.close();

  // 3) 파일 저장 (CSV는 BOM 붙이기)
  fs.writeFileSync('current.csv', CSV_BOM + toCSV(rows), 'utf8');
  fs.writeFileSync(`snapshot_${dFile}.csv`, CSV_BOM + toCSV(rows), 'utf8');

  const seenArr = Array.from(seen);
  const newOnes = rows.filter(r => !seen.has(String(r.articleNo)));
  fs.writeFileSync('new_today.csv', CSV_BOM + toCSV(newOnes), 'utf8');

  const newSeen = new Set([...seenArr, ...rows.map(r=>String(r.articleNo))]);
  fs.writeFileSync('seen_ids.json', JSON.stringify(Array.from(newSeen), null, 2), 'utf8');

  fs.writeFileSync('debug.json', JSON.stringify({ ...debug, scannedIds: rows.length }, null, 2), 'utf8');

  console.log(`✅ current.csv ${rows.length} rows, new_today.csv ${newOnes.length} rows (pushed:${debug.pushed}, groups:${debug.groups}, tiles:${debug.tiles}, detailHtml:${debug.details.htmlOk}, detailBrowser:${debug.details.browserOk})`);
}

main().catch(e=>{ console.error(e); process.exit(1); });
