// m.land 클러스터 + mapKey + 리다이렉트 follow + 모바일 UA → 실패 시 Playwright 폴백 → 스냅샷 저장
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

// ===== 입력(워크플로 inputs/ENV로 덮어쓰기 가능) =====
const DIST = (process.env.DIST_CODES || '1144000000').split(',').map(s=>s.trim()).filter(Boolean); // 마포구
const TYPES = (process.env.TYPES || 'OR').split(',').map(s=>s.trim()).filter(Boolean);            // 원룸
const TRADE = (process.env.TRADE || 'B2').split(',').map(s=>s.trim()).filter(Boolean);            // 월세
const MAX_PAGES = parseInt(process.env.MAX_PAGES || '40', 10);
const GRID = parseInt(process.env.GRID || '3', 10); // 지도 타일 분해(크면 더 잘 긁힘, 3~4 추천)

const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

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
function todayStr(){ const d=new Date(); const y=d.getUTCFullYear(); const m=String(d.getUTCMonth()+1).padStart(2,'0'); const dd=String(d.getUTCDate()).padStart(2,'0'); return `${y}${m}${dd}`; }
function toCSV(arr){
  const cols=['date','articleNo','title','type','deposit','rent','area_m2','floor','address','realtor','postedYmd','updatedYmd','link'];
  const lines=[cols.join(',')].concat(arr.map(o=>cols.map(c=>`"${esc(o[c])}"`).join(',')));
  return lines.join('\n');
}
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

// ── 파서 ─────────────────────────────────────────────────────────────
function parseIdsFromHtml(html){
  const items = [];
  const seen = new Set();
  const reId = /(?:data-(?:article|atcl)-no=["']?|\/article\/info\/)(\d{7,})/g;
  let m; while ((m = reId.exec(html)) !== null) { const id=m[1]; if(seen.has(id)) continue; seen.add(id); items.push({ atclNo:id }); }
  return items;
}
function parseArticleList(payload){
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.list)) return payload.list;
    if (Array.isArray(payload.articles)) return payload.articles;
    const html = payload.html || payload.body || payload.result || payload.listHtml || payload.renderedList;
    if (typeof html === 'string') return parseIdsFromHtml(html);
  }
  if (typeof payload === 'string') return parseIdsFromHtml(payload);
  return [];
}
function pick(...vals){ for(const v of vals){ if(v!==undefined && v!==null && v!=='') return v; } return ''; }

// ── 모바일 지도 파라미터 ────────────────────────────────────────────
async function getFilterByKeyword(keyword){
  const r = await fetch(`https://m.land.naver.com/search/result/${encodeURIComponent(keyword)}`, {
    headers: headers(37.5665,126.9780,12),
    redirect: 'follow'
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

  // ★ 307 리다이렉트 따라가도록 설정
  const r = await fetch(u, { headers: headers(lat,lon,z), redirect:'follow' });
  const txt = await r.text();
  return txt; // JSON 또는 HTML
}

// ── Playwright 폴백(모바일 컨텍스트) ─────────────────────────────────
async function retryInBrowser(keyword, tiles, rlet, trad, z, lat, lon, sampleLimit=3){
  const browser = await chromium.launch({ headless: true, args: ['--lang=ko-KR'] });
  const ctx = await browser.newContext({
    locale: 'ko-KR',
    userAgent: MOBILE_UA,
    viewport: { width: 390, height: 720 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true
  });
  const page = await ctx.newPage();
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'ko-KR,ko;q=0.9' });
  await page.goto(`https://m.land.naver.com/search/result/${encodeURIComponent(keyword)}`, { waitUntil: 'domcontentloaded' });

  const out = [];
  let saved = 0;

  for (const tile of tiles) {
    // clusterList에서 mapKey도 같이 가져오기 (★ 인자 1개 객체로 전달)
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
        // ★ 인자 1개 객체 + pageIndex 반영
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
  const debug = { startedAt, mode:'mobile-cluster+grid+browser-fallback+mapKey+redir', params:{DIST,TYPES,TRADE,MAX_PAGES,GRID}, tiles:0, groups:0, combos:[], pushed:0, notes:[] };

  const seen = new Set(fs.existsSync('seen_ids.json') ? JSON.parse(fs.readFileSync('seen_ids.json','utf8')).map(String) : []);
  const rows = [];
  const byId = new Map();

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

          // 안전망: 여전히 0이면 브라우저 컨텍스트로 재시도
          if (byId.size === 0) {
            const browserHits = await retryInBrowser(keyword, [tile], rlet, trad, f.z, f.lat, f.lon);
            for(const {id} of browserHits){ if(!byId.has(id)) byId.set(id, { atclNo: id }); }
            debug.notes.push(`browser-fallback-used:${byId.size}`);
          }
        }
      }
    }
  }

  const d = todayStr();
  for(const [id, it] of byId.entries()){
    rows.push({
      date: d,
      articleNo: id,
      title: pick(it.atclNm, it.articleName, it.cmplxNm, ''),
      type: pick(it.rletTpNm, ''),
      deposit: pick(it.hanPrc, ''),
      rent: pick(it.rentPrc, ''),
      area_m2: pick(it.spc2, it.area2, it.spc1, it.area1, ''),
      floor: pick(it.flrInfo, it.floor, ''),
      address: pick(it.ldongNm, it.ctpvNm, it.bldrNm, ''),
      realtor: pick(it.rltrNm, ''),
      postedYmd: pick(it.registYmd, ''),
      updatedYmd: '',
      link: `https://m.land.naver.com/article/info/${id}`
    });
  }

  fs.writeFileSync('current.csv', toCSV(rows), 'utf8');
  fs.writeFileSync(`snapshot_${d}.csv`, toCSV(rows), 'utf8');
  const newOnes = rows.filter(r => !seen.has(String(r.articleNo)));
  fs.writeFileSync('new_today.csv', toCSV(newOnes), 'utf8');
  const newSeen = new Set([...seen, ...rows.map(r=>String(r.articleNo))]);
  fs.writeFileSync('seen_ids.json', JSON.stringify(Array.from(newSeen), null, 2), 'utf8');
  fs.writeFileSync('debug.json', JSON.stringify({ ...debug, scannedIds: rows.length }, null, 2), 'utf8');

  console.log(`✅ current.csv ${rows.length} rows, new_today.csv ${newOnes.length} rows (pushed:${debug.pushed}, groups:${debug.groups}, tiles:${debug.tiles})`);
}

main().catch(e=>{ console.error(e); process.exit(1); });
