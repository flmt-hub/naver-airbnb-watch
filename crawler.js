const { chromium } = require('playwright');
const fs = require('fs');

// ===== 설정(입력으로 덮어쓰기 가능) =====
const DIST = (process.env.DIST_CODES || '1144000000')   // 마포구
  .split(',').map(s => s.trim()).filter(Boolean);
const TYPES = (process.env.TYPES || 'OR')               // OR = 원룸
  .split(',').map(s => s.trim()).filter(Boolean);
const TRADE = (process.env.TRADE || 'B2')               // B2 = 월세
  .split(',').map(s => s.trim()).filter(Boolean);
const MAX_PAGES = parseInt(process.env.MAX_PAGES || '40', 10); // 조합당 최대 페이지

// ===== 유틸 =====
async function fetchFromPage(page, url){
  return await page.evaluate(async (u)=>{
    const r = await fetch(u, { credentials: 'include' });
    if(!r.ok) return { ok:false, status:r.status, text: await r.text() };
    let j = await r.json().catch(async ()=>({ parseErr: await r.text() }));
    return { ok:true, json:j };
  }, url);
}
function extractList(j){ return j.articleList || j.list || j.articles || []; }
function pick(...vals){ for(const v of vals){ if(v!==undefined && v!==null && v!=='') return v; } return ''; }
function findKeyDeep(obj, keys){ // keys: array of lower-case keys
  const stack=[obj];
  while(stack.length){
    const cur=stack.pop();
    if(cur && typeof cur==='object'){
      for(const k of Object.keys(cur)){
        if(keys.includes(k.toLowerCase())) return cur[k];
        const v = cur[k];
        if(v && typeof v==='object') stack.push(v);
      }
    }
  }
  return '';
}
function todayStr(){
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth()+1).padStart(2,'0');
  const dd = String(d.getUTCDate()).padStart(2,'0');
  return `${y}${m}${dd}`;
}

(async () => {
  const startedAt = new Date().toISOString();
  const debug = { startedAt, params: { DIST, TYPES, TRADE, MAX_PAGES }, combos: [], scannedIds: 0, notes: [] };

  const browser = await chromium.launch({ headless: true, args: ['--lang=ko-KR'] });
  const ctx = await browser.newContext({ locale: 'ko-KR' });
  const page = await ctx.newPage();
  await page.goto('https://new.land.naver.com/', { waitUntil: 'domcontentloaded' });

  // 1) 목록 → ID + 요약정보 수집
  const ids = new Set();
  const listInfo = new Map(); // id -> last seen list item
  for (const code of DIST){
    for (const tp of TYPES){
      for (const tr of TRADE){
        for (let p=1; p<=MAX_PAGES; p++){
          const u = new URL('https://new.land.naver.com/api/articles');
          u.searchParams.set('cortarNo', code);
          u.searchParams.set('order', 'dates');
          u.searchParams.set('realEstateType', tp);
          u.searchParams.set('tradeType', tr);
          u.searchParams.set('page', String(p));
          u.searchParams.set('sameAddressGroup', 'false');
          u.searchParams.set('priceType', 'RETAIL');

          const res = await fetchFromPage(page, u.toString());
          if(!res.ok){ debug.combos.push({ code, tp, tr, page:p, status:res.status, items:0 }); break; }
          const list = extractList(res.json);
          debug.combos.push({ code, tp, tr, page:p, status:200, items:list.length });
          if(!list.length) break;
          for (const it of list){
            const id = String(it.atclNo || it.articleNo || '');
            if(!id) continue;
            ids.add(id);
            listInfo.set(id, it);
          }
          await page.waitForTimeout(700);
        }
      }
    }
  }
  debug.scannedIds = ids.size;
  console.log('Collected IDs:', ids.size);

  // 2) 상세(JSON 우선 → 실패 시 모바일 HTML)에서 필드 보강
  async function tryDetailJson(id){
    const candidates = [
      `https://new.land.naver.com/api/articles/ArticleInfo?articleNo=${id}`,
      `https://new.land.naver.com/api/articles/${id}`,
      `https://new.land.naver.com/api/articles/overview/${id}`,
    ];
    for(const u of candidates){
      const r = await fetchFromPage(page, u);
      if(r.ok && r.json && !r.json.parseErr) return r.json;
    }
    return null;
  }

  const pageM = await ctx.newPage();
  async function tryDetailHtml(id){
    try{
      await pageM.goto(`https://m.land.naver.com/article/info/${id}`, { waitUntil:'domcontentloaded', timeout:30000 });
      return await pageM.content();
    }catch(e){
      debug.notes.push(`detail-html-fail:${id}:${e.message}`); return '';
    }
  }

  // seen set (신규 판별)
  let seen = new Set();
  try{
    if(fs.existsSync('seen_ids.json')){
      const arr = JSON.parse(fs.readFileSync('seen_ids.json','utf8'));
      seen = new Set(arr.map(String));
    }
  }catch{}

  const rows = [];
  for(const id of ids){
    const li = listInfo.get(id) || {};
    const dj = await tryDetailJson(id);

    // 기본 필드 (목록/상세에서 최대한 뽑기)
    const title   = pick(li.atclNm, li.articleName, li.cmplxNm, findKeyDeep(dj||{}, ['articlename','atclnm','cmplxnm']));
    const typeNm  = pick(li.rletTpNm, findKeyDeep(dj||{}, ['rlettpnm','realestatetypename']));
    const deposit = pick(li.hanPrc, li.deposit, findKeyDeep(dj||{}, ['hanprc','deposit','deposittxt','prc']));
    const rent    = pick(li.rentPrc, li.monthlyRent, findKeyDeep(dj||{}, ['rentprc','monthlyrent']));
    const area    = pick(li.spc2, li.area2, li.spc1, li.area1, findKeyDeep(dj||{}, ['spc2','area2','supplyarea','exclusivearea']));
    const floor   = pick(li.flrInfo, li.floor, findKeyDeep(dj||{}, ['flrinfo','floor']));
    const addr    = pick(li.addr, findKeyDeep(dj||{}, ['addr','address']));
    const realtor = pick(li.rltrNm, findKeyDeep(dj||{}, ['rltrnm','realtorname']));
    const regYmd  = pick(li.registYmd, findKeyDeep(dj||{}, ['registymd','regdate','insertdate']));
    const updYmd  = pick(findKeyDeep(dj||{}, ['updatedate','modifydate','updymd']));

    // HTML 본문(옵션): 없어도 작동함
    let html = '';
    if(!dj){ html = await tryDetailHtml(id); }

    rows.push({
      date: todayStr(), articleNo: id,
      title, type: typeNm, deposit, rent,
      area_m2: area, floor, address: addr, realtor,
      postedYmd: regYmd, updatedYmd: updYmd,
      link: `https://m.land.naver.com/article/info/${id}`
    });
    await pageM.waitForTimeout(400);
  }

  // 3) 파일 저장
  // - current.csv: 최신 스냅샷
  // - snapshot_YYYYMMDD.csv: 일자별 스냅샷
  // - new_today.csv: 이전에 없던 신규만
  const byId = new Map(); // 중복 제거
  for(const r of rows){ if(!byId.has(r.articleNo)) byId.set(r.articleNo, r); }
  const out = Array.from(byId.values());

  const toCSV = (arr) => {
    const cols = ['date','articleNo','title','type','deposit','rent','area_m2','floor','address','realtor','postedYmd','updatedYmd','link'];
    const esc = s => String(s===undefined?'':s).replace(/"/g,'""');
    const lines = [cols.join(',')].concat(arr.map(o=>cols.map(c=>`"${esc(o[c])}"`).join(',')));
    return lines.join('\n');
  };

  const dstr = todayStr();
  fs.writeFileSync('current.csv', toCSV(out), 'utf8');
  fs.writeFileSync(`snapshot_${dstr}.csv`, toCSV(out), 'utf8');

  // 신규 판별 & 저장
  const newOnes = out.filter(r => !seen.has(String(r.articleNo)));
  fs.writeFileSync('new_today.csv', toCSV(newOnes), 'utf8');

  // seen 갱신
  const newSeen = new Set([...seen, ...out.map(r=>String(r.articleNo))]);
  fs.writeFileSync('seen_ids.json', JSON.stringify(Array.from(newSeen), null, 2), 'utf8');

  // 디버그 로그
  fs.writeFileSync('debug.json', JSON.stringify({ ...debug, totalRows: out.length, newToday: newOnes.length }, null, 2), 'utf8');

  console.log(`Saved current.csv (${out.length}), new_today.csv (${newOnes.length}), snapshot_${dstr}.csv`);
  await browser.close();
})();
