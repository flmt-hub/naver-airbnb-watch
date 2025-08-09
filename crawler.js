// 최종 안전판: m.land 클러스터(JSON/HTML) → 실패 시 Playwright로 재시도 → 일별 스냅샷 저장
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright'); // 브라우저 컨텍스트 재시도용

// ===== 입력(워크플로 inputs/ENV로 덮어쓰기 가능) =====
const DIST = (process.env.DIST_CODES || '1144000000')  // 마포구
  .split(',').map(s => s.trim()).filter(Boolean);
const TYPES = (process.env.TYPES || 'OR')              // 원룸
  .split(',').map(s => s.trim()).filter(Boolean);
const TRADE = (process.env.TRADE || 'B2')              // 월세
  .split(',').map(s => s.trim()).filter(Boolean);
const MAX_PAGES = parseInt(process.env.MAX_PAGES || '40', 10);
const GRID = parseInt(process.env.GRID || '3', 10);    // 지도 타일 분해(3~4 추천)

const H = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
  'Accept-Language': 'ko-KR,ko;q=0.9',
  'Accept': 'text/html,application/json;q=0.9,*/*;q=0.8',
  'Referer': 'https://m.land.naver.com/',
  'X-Requested-With': 'XMLHttpRequest'
};

function esc(s){ return String(s==null?'':s).replace(/"/g,'""'); }
function todayStr(){ const d=new Date(); const y=d.getUTCFullYear(); const m=String(d.getUTCMonth()+1).padStart(2,'0'); const dd=String(d.getUTCDate()).padStart(2,'0'); return `${y}${m}${dd}`; }
function toCSV(arr){
  const cols=['date','articleNo','title','type','deposit','rent','area_m2','floor','address','realtor','postedYmd','updatedYmd','link'];
  const lines=[cols.join(',')].concat(arr.map(o=>cols.map(c=>`"${esc(o[c])}"`).join(',')));
  return lines.join('\n');
}
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

// ── 공통 파서 ─────────────────────────────────────────────────────────────
function parseIdsFromHtml(html){
  const items = [];
  const seen = new Set();
  const reId = /(?:data-(?:article|atcl)-no=["']?|\/article\/info\/)(\d{7,})/g;
  let m;
  while ((m = reId.exec(html)) !== null) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({ atclNo: id });
  }
  return items;
}

function parseArticleList(payload){
  // 1) JSON 배열/객체
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.list)) return payload.list;
    if (Array.isArray(payload.articles)) return payload.articles;
    const html = payload.html || payload.body || payload.result || payload.listHtml || payload.renderedList;
    if (typeof html === 'string') return parseIdsFromHtml(html);
  }
  // 2) HTML 문자열
  if (typeof payload === 'string') return parseIdsFromHtml(payload);
  return [];
}

function pick(...vals){ for(const v of vals){ if(v!==undefined && v!==null && v!=='') return v; } return ''; }

// ── 모바일 지도 파라미터 ──────────────────────────────────────────────────
async function getFilterByKeyword(keyword){
  const r = await fetch(`https://m.land.naver.com/search/result/${encodeURIComponent(keyword)}`, { headers: H });
  const html = await r.text();
  const m = html.match(/filter:\s*\{([\s\S]*?)\}/);
  if(!m) throw new Error('filter block not found');
  const raw = m[1].replace(/[\s'"]/g,'');
  const grab = (k) => { const mm = raw.match(new RegExp(`${k}:([^,}]+)`)); return mm ? mm[1] : ''; };
  const lat = parseFloat(grab('lat')), lon = parseFloat(grab('lon')), z = grab('z') || '12', cortarNo = grab('cortarNo');
  const lat_margin = 0.118, lon_margin = 0.111;
  return {
    lat, lon, z, cortarNo,
    btm: (lat-lat_margin).toFixed(6),
    lft: (lon-lon_margin).toFixed(6),
    top: (lat+lat_margin).toFixed(6),
    rgt: (lon+lon_margin).toFixed(6),
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

// ── 클러스터/리스트 호출 (fetch) ──────────────────────────────────────────
async function fetchClusterList(tile, rletTpCd, tradTpCd, z, lat, lon){
  const u = new URL('https://m.land.naver.com/cluster/clusterList');
  u.searchParams.set('view','atcl');
  u.searchParams.set('cortarNo',''); // tile 기반일 땐 비워도 동작
  u.searchParams.set('rletTpCd', rletTpCd);
  u.searchParams.set('tradTpCd', tradTpCd);
  u.searchParams.set('z', z);
  u.searchParams.set('lat', lat);
  u.searchParams.set('lon', lon);
  u.searchParams.set('btm', tile.btm);
  u.searchParams.set('lft', tile.lft);
  u.searchParams.set('top', tile.top);
  u.searchParams.set('rgt', tile.rgt);
  const r = await fetch(u, { headers: H });
  if(!r.ok) throw new Error(`clusterList ${r.status}`);
  const j = await r.json();
  return (j && j.data && j.data.ARTICLE) ? j.data.ARTICLE : [];
}

async function fetchArticleListRaw(lgeo, z, lat, lon, count, tile, rletTpCd, tradTpCd, page){
  const u = new URL('https://m.land.naver.com/cluster/ajax/articleList');
  u.searchParams.set('itemId', lgeo);
  u.searchParams.set('mapKey','');
  u.searchParams.set('lgeo', lgeo);
  u.searchParams.set('showR0','');
  u.searchParams.set('rletTpCd', rletTpCd);
  u.searchParams.set('tradTpCd', tradTpCd);
  u.searchParams.set('z', z);
  u.searchParams.set('lat', lat);
  u.searchParams.set('lon', lon);
  u.searchParams.set('totCnt', count);
  u.searchParams.set('cortarNo', ''); // tile 모드
  u.searchParams.set('page', String(page));
  // 범위를 유지하려고 tile 정보도 같이 전달(백엔드가 쓰지 않아도 무해)
  u.searchParams.set('btm', tile.btm);
  u.searchParams.set('lft', tile.lft);
  u.searchParams.set('top', tile.top);
  u.searchParams.set('rgt', tile.rgt);
  const r = await fetch(u, { headers: H });
  if(!r.ok) throw new Error(`articleList ${r.status}`);
  return await r.text(); // JSON 또는 HTML 문자열
}

// ── Playwright 재시도(최후의 안전망) ──────────────────────────────────────
async function retryInBrowser(keyword, tiles, rlet, trad, z, lat, lon, sampleLimit=3){
  const browser = await chromium.launch({ headless: true, args: ['--lang=ko-KR'] });
  const ctx = await browser.newContext({ locale: 'ko-KR' });
  const page = await ctx.newPage();
  await page.goto(`https://m.land.naver.com/search/result/${encodeURIComponent(keyword)}`, { waitUntil: 'domcontentloaded' });

  const out = [];
  let saved = 0;

  for (const tile of tiles) {
    // ★ 인자를 객체 1개로 전달
    const groups = await page.evaluate(async (args) => {
      const { tile, rlet, trad, z, lat, lon } = args;
      const params = new URLSearchParams({
        view: 'atcl',
        cortarNo: '',
        rletTpCd: rlet,
        tradTpCd: trad,
        z: String(z), lat: String(lat), lon: String(lon),
        btm: tile.btm, lft: tile.lft, top: tile.top, rgt: tile.rgt
      });
      const r = await fetch('https://m.land.naver.com/cluster/clusterList?' + params.toString(), { credentials: 'include' });
      if (!r.ok) return [];
      const j = await r.json().catch(() => null);
      return j && j.data && j.data.ARTICLE ? j.data.ARTICLE : [];
    }, { tile, rlet, trad, z, lat, lon });

    for (const g of groups) {
      const lgeo = String(g.lgeo), count = Number(g.count || 0);
      const pages = Math.min(Math.ceil(count / 20), MAX_PAGES);

      for (let pageIndex = 1; pageIndex <= pages; pageIndex++) {
        // ★ 인자를 객체 1개로 전달 + pageIndex 반영 (기존 1 고정 버그 수정)
        const raw = await page.evaluate(async (args) => {
          const { lgeo, z, lat, lon, count, tile, rlet, trad, pageIndex } = args;
          const q = new URLSearchParams({
            itemId: lgeo, mapKey: '', lgeo, showR0: '',
            rletTpCd: rlet, tradTpCd: trad,
            z: String(z), lat: String(lat), lon: String(lon),
            totCnt: String(count), cortarNo: '', page: String(pageIndex),
            btm: tile.btm, lft: tile.lft, top: tile.top, rgt: tile.rgt
          });
          const r = await fetch('https://m.land.naver.com/cluster/ajax/articleList?' + q.toString(), { credentials: 'include' });
          return await r.text();
        }, { lgeo, z, lat, lon, count, tile, rlet, trad, pageIndex });

        // 샘플 저장 (처음 몇 페이지만)
        if (saved < sampleLimit) {
          fs.mkdirSync('samples', { recursive: true });
          fs.writeFileSync(path.join('samples', `articleList_browser_${lgeo}_${pageIndex}.txt`), raw, 'utf8');
          saved++;
        }

        // 파싱
        let parsed;
        try { parsed = parseArticleList(JSON.parse(raw)); }
        catch { parsed = parseArticleList(raw); }

        for (const it of parsed) {
          const id = String(it.atclNo || it.articleNo || '');
          if (id) out.push({ id });
        }
        await page.waitForTimeout(200);
      }
    }
  }

  await browser.close();
  return out;
}

// ── 메인 ──────────────────────────────────────────────────────────────────
async function main(){
  const startedAt = new Date().toISOString();
  const debug = { startedAt, mode:'mobile-cluster+grid+browser-fallback', params:{DIST,TYPES,TRADE,MAX_PAGES,GRID}, tiles:0, groups:0, combos:[], pushed:0, notes:[] };

  const seen = new Set(fs.existsSync('seen_ids.json') ? JSON.parse(fs.readFileSync('seen_ids.json','utf8')).map(String) : []);
  const rows = [];
  const byId = new Map();

  for(const code of DIST){
    const keyword = '마포구'; // 안전하게 구명 고정
    const f = await getFilterByKeyword(keyword);
    const tiles = splitGrid(f, GRID);
    debug.tiles += tiles.length;

    for(const rlet of TYPES){
      for(const trad of TRADE){
        // 1) 각 타일마다 그룹 → 리스트
        for(const tile of tiles){
          let groups = [];
          try {
            groups = await fetchClusterList(tile, rlet, trad, f.z, f.lat, f.lon);
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
                raw = await fetchArticleListRaw(lgeo, f.z, f.lat, f.lon, count, tile, rlet, trad, idx);
              } catch(e) {
                debug.notes.push('articleList-fail:'+e.message);
                continue;
              }

              // 샘플 저장(처음 몇 페이지만)
              if (debug.pushed < 5) {
                fs.mkdirSync('samples', {recursive:true});
                fs.writeFileSync(path.join('samples', `articleList_${lgeo}_${idx}.txt`), raw, 'utf8');
              }

              let parsed;
              try {
                const maybeJson = JSON.parse(raw);
                parsed = parseArticleList(maybeJson);
              } catch {
                parsed = parseArticleList(raw);
              }
              debug.combos.push({ code, rlet, trad, lgeo, page: idx, parsed: Array.isArray(parsed)? parsed.length : 0 });

              let added = 0;
              for(const it of (Array.isArray(parsed) ? parsed : [])){
                const id = String(it.atclNo || it.articleNo || '');
                if(!id || byId.has(id)) continue;
                byId.set(id, it);
                added++;
              }
              debug.pushed += added;
              await sleep(200);
            }
          }
        }

        // 2) 안전망: 아직 0이면 브라우저 컨텍스트로 재시도
        if (byId.size === 0) {
          const browserHits = await retryInBrowser(keyword, tiles, rlet, trad, f.z, f.lat, f.lon);
          for(const {id} of browserHits){
            if(!byId.has(id)) byId.set(id, { atclNo: id });
          }
          debug.notes.push(`browser-fallback-used:${browserHits.length}`);
        }
      }
    }
  }

  // 행 구성
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

  // 저장
  fs.writeFileSync('current.csv', toCSV(rows), 'utf8');
  fs.writeFileSync(`snapshot_${todayStr()}.csv`, toCSV(rows), 'utf8');
  const newOnes = rows.filter(r => !seen.has(String(r.articleNo)));
  fs.writeFileSync('new_today.csv', toCSV(newOnes), 'utf8');
  const newSeen = new Set([...seen, ...rows.map(r=>String(r.articleNo))]);
  fs.writeFileSync('seen_ids.json', JSON.stringify(Array.from(newSeen), null, 2), 'utf8');
  fs.writeFileSync('debug.json', JSON.stringify({ ...debug, scannedIds: rows.length }, null, 2), 'utf8');

  console.log(`✅ current.csv ${rows.length} rows, new_today.csv ${newOnes.length} rows (pushed:${debug.pushed}, groups:${debug.groups}, tiles:${debug.tiles})`);
}

main().catch(e=>{ console.error(e); process.exit(1); });
