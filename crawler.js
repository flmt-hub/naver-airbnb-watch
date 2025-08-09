const { chromium } = require('playwright');
const fs = require('fs');

// ---- 설정 (워크플로 inputs/ENV로 덮어쓸 수 있음) ----
const DIST = (process.env.DIST_CODES || '1144000000,1168000000,1165000000')
  .split(',').map(s => s.trim()).filter(Boolean); // 기본: 마포, 강남, 서초
const TYPES = (process.env.TYPES || 'APT,OPST,VL')
  .split(',').map(s => s.trim()).filter(Boolean);
const TRADE = (process.env.TRADE || 'B2')
  .split(',').map(s => s.trim()).filter(Boolean);
const MAX_PAGES = parseInt(process.env.MAX_PAGES || '8', 10); // 조합당 최대 페이지 (디폴트 8)

const RE = /(에어\s*비?엔?비|에\s*어\s*비\s*앤\s*비|air\s*-?\s*bnb|airbnb)/i; // 키워드

async function fetchFromPage(page, url){
  return await page.evaluate(async (u)=>{
    const r = await fetch(u, { credentials: 'include' });
    if(!r.ok) return { ok:false, status:r.status, text: await r.text() };
    let j = await r.json().catch(async ()=>({ parseErr: await r.text() }));
    return { ok:true, json:j };
  }, url);
}
function extractList(j){ return j.articleList || j.list || j.articles || []; }

(async () => {
  const startedAt = new Date().toISOString();
  const debug = {
    startedAt,
    params: { DIST, TYPES, TRADE, MAX_PAGES },
    combos: [],
    scannedIds: 0,
    matched: 0,
    notes: []
  };

  const browser = await chromium.launch({ headless: true, args: ['--lang=ko-KR'] });
  const ctx = await browser.newContext({ locale: 'ko-KR' });
  const page = await ctx.newPage();
  await page.goto('https://new.land.naver.com/', { waitUntil: 'domcontentloaded' });

  // 1) 목록에서 articleNo 수집
  const ids = new Set();
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
          if(!res.ok){
            debug.combos.push({ code, tp, tr, page: p, status: res.status, items: 0 });
            break;
          }
          const list = extractList(res.json);
          debug.combos.push({ code, tp, tr, page: p, status: 200, items: list.length });
          if(!list.length) break;
          for (const it of list){
            const id = String(it.atclNo || it.articleNo || '');
            if(id) ids.add(id);
          }
          await page.waitForTimeout(800);
        }
      }
    }
  }
  debug.scannedIds = ids.size;
  console.log('Collected IDs:', ids.size);

  // 2) 상세에서 키워드 확인 (모바일 HTML)
  const pageM = await ctx.newPage();
  const rows = [];
  let i = 0;
  for (const id of ids){
    i++;
    try{
      await pageM.goto(`https://m.land.naver.com/article/info/${id}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const html = await pageM.content();
      if (RE.test(html)) rows.push({ articleNo: id, link: `https://m.land.naver.com/article/info/${id}` });
      await pageM.waitForTimeout(650);
    }catch(e){
      debug.notes.push(`detail-fail:${id}:${e.message}`);
    }
  }
  debug.matched = rows.length;

  // 3) CSV + 디버그 저장
  const csv = 'articleNo,link\n' + rows.map(r=>`${r.articleNo},${r.link}`).join('\n');
  fs.writeFileSync('results.csv', csv, 'utf8');
  fs.writeFileSync('debug.json', JSON.stringify(debug, null, 2), 'utf8');

  console.log(`Saved results.csv (${rows.length} rows)`);
  console.log(`Saved debug.json (scannedIds=${debug.scannedIds})`);

  await browser.close();

  if (rows.length === 0) {
    console.log('WARNING: No matches. Check debug.json combos/items to see if list API returned entries.');
  }
})();
