// 모바일 엔드포인트(쿠키 불필요) 기반: 마포구 OR(원룸) B2(월세) 전수 + 매일 스냅샷
const fs = require('fs');

// ===== 입력(워크플로 inputs/ENV로 덮어쓰기 가능) =====
const DIST = (process.env.DIST_CODES || '1144000000')  // 마포구
  .split(',').map(s => s.trim()).filter(Boolean);
const TYPES = (process.env.TYPES || 'OR')              // 원룸
  .split(',').map(s => s.trim()).filter(Boolean);
const TRADE = (process.env.TRADE || 'B2')              // 월세
  .split(',').map(s => s.trim()).filter(Boolean);
const MAX_PAGES = parseInt(process.env.MAX_PAGES || '40', 10);

// 코드→키워드(검색어) 매핑: 필요시 추가
const CODE_TO_KEYWORD = {
  '1144000000': '마포구',
  '1168000000': '강남구',
  '1165000000': '서초구',
  // ...원하면 여기에 더 추가
};

const H = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
  'Accept-Language': 'ko-KR,ko;q=0.9',
  'Accept': 'text/html,application/json;q=0.9,*/*;q=0.8'
};

function esc(s){ return String(s==null?'':s).replace(/"/g,'""'); }
function todayStr(){ const d=new Date(); const y=d.getUTCFullYear(); const m=String(d.getUTCMonth()+1).padStart(2,'0'); const dd=String(d.getUTCDate()).padStart(2,'0'); return `${y}${m}${dd}`; }
function toCSV(arr){
  const cols=['date','articleNo','title','type','deposit','rent','area_m2','floor','address','realtor','postedYmd','updatedYmd','link'];
  const lines=[cols.join(',')].concat(arr.map(o=>cols.map(c=>`"${esc(o[c])}"`).join(',')));
  return lines.join('\n');
}

// 1) m.land 검색 결과에서 filter 블록 파싱(lat/lon/z/cortarNo)
async function getFilterByKeyword(keyword){
  const r = await fetch(`https://m.land.naver.com/search/result/${encodeURIComponent(keyword)}`, { headers: H });
  const html = await r.text();
  const m = html.match(/filter:\s*\{([\s\S]*?)\}/);
  if(!m) throw new Error('filter block not found');
  const raw = m[1].replace(/[\s'"]/g,'');
  const grab = (k) => {
    const mm = raw.match(new RegExp(`${k}:([^,}]+)`));
    return mm ? mm[1] : '';
  };
  const lat = grab('lat'), lon = grab('lon'), z = grab('z') || '12', cortarNo = grab('cortarNo');
  // 여유 margin(블로그 예제 값)
  const lat_margin = 0.118, lon_margin = 0.111;
  const btm = (parseFloat(lat)-lat_margin).toFixed(6);
  const lft = (parseFloat(lon)-lon_margin).toFixed(6);
  const top = (parseFloat(lat)+lat_margin).toFixed(6);
  const rgt = (parseFloat(lon)+lon_margin).toFixed(6);
  return { lat, lon, z, cortarNo, btm, lft, top, rgt };
}

// 2) clusterList → 원형 그룹들
async function fetchClusterList(params, rletTpCd, tradTpCd){
  const u = new URL('https://m.land.naver.com/cluster/clusterList');
  u.searchParams.set('view','atcl');
  u.searchParams.set('cortarNo', params.cortarNo);
  u.searchParams.set('rletTpCd', rletTpCd);
  u.searchParams.set('tradTpCd', tradTpCd);
  u.searchParams.set('z', params.z);
  u.searchParams.set('lat', params.lat);
  u.searchParams.set('lon', params.lon);
  u.searchParams.set('btm', params.btm);
  u.searchParams.set('lft', params.lft);
  u.searchParams.set('top', params.top);
  u.searchParams.set('rgt', params.rgt);
  const r = await fetch(u, { headers: H });
  if(!r.ok) throw new Error(`clusterList ${r.status}`);
  const j = await r.json();
  return (j && j.data && j.data.ARTICLE) ? j.data.ARTICLE : [];
}

// 3) 각 그룹의 articleList(20개씩 페이징)
async function fetchArticleList(lgeo, z, lat, lon, count, cortarNo, rletTpCd, tradTpCd, page){
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
  u.searchParams.set('cortarNo', cortarNo);
  u.searchParams.set('page', String(page));
  const r = await fetch(u, { headers: H });
  if(!r.ok) throw new Error(`articleList ${r.status}`);
  return await r.json(); // 배열 형태
}

async function main(){
  const startedAt = new Date().toISOString();
  const debug = { startedAt, mode: 'mobile-cluster', params:{DIST,TYPES,TRADE,MAX_PAGES}, combos:[], groups:0, scannedIds:0, notes:[] };

  const seen = new Set(fs.existsSync('seen_ids.json') ? JSON.parse(fs.readFileSync('seen_ids.json','utf8')).map(String) : []);
  const rows = [];
  const byId = new Map();

  for(const code of DIST){
    const keyword = CODE_TO_KEYWORD[code] || '마포구'; // 기본값
    const f = await getFilterByKeyword(keyword); // lat/lon/z/cortarNo 계산
    if(!f.cortarNo || f.cortarNo !== code){
      // 코드와 검색어 매칭이 다르면 code 우선으로 사용
      f.cortarNo = code;
    }

    for(const rlet of TYPES){
      for(const trad of TRADE){
        // 1) 그룹 목록
        const groups = await fetchClusterList(f, rlet, trad);
        debug.groups += groups.length;

        for(const g of groups){
          const lgeo = String(g.lgeo), count = Number(g.count||0), z2 = g.z || f.z, lat2 = g.lat || f.lat, lon2 = g.lon || f.lon;
          const pages = Math.min(Math.ceil(count/20), MAX_PAGES);
          for(let idx=1; idx<=pages; idx++){
            debug.combos.push({ code, rlet, trad, lgeo, page: idx, groupCount: count });
            const list = await fetchArticleList(lgeo, z2, lat2, lon2, count, f.cortarNo, rlet, trad, idx);
            for(const it of (Array.isArray(list)? list : [])){
              const id = String(it.atclNo || it.articleNo || '');
              if(!id || byId.has(id)) continue;
              byId.set(id, it);
            }
          }
        }
      }
    }
  }

  const d = todayStr();
  // 매물 행 만들기 (목록 JSON 기반)
  for(const [id, it] of byId.entries()){
    rows.push({
      date: d,
      articleNo: id,
      title: it.atclNm || it.articleName || it.cmplxNm || '',
      type: it.rletTpNm || '',
      deposit: it.hanPrc || '',
      rent: it.rentPrc || '',
      area_m2: it.spc2 || it.area2 || it.spc1 || it.area1 || '',
      floor: it.flrInfo || it.floor || '',
      address: it.ldongNm || it.ctpvNm || it.bldrNm || '',
      realtor: it.rltrNm || '',
      postedYmd: it.registYmd || '',
      updatedYmd: '',
      link: `https://m.land.naver.com/article/info/${id}`
    });
  }

  debug.scannedIds = rows.length;

  // 저장
  fs.writeFileSync('current.csv', toCSV(rows), 'utf8');
  fs.writeFileSync(`snapshot_${d}.csv`, toCSV(rows), 'utf8');
  const newOnes = rows.filter(r => !seen.has(String(r.articleNo)));
  fs.writeFileSync('new_today.csv', toCSV(newOnes), 'utf8');
  const newSeen = new Set([...seen, ...rows.map(r=>String(r.articleNo))]);
  fs.writeFileSync('seen_ids.json', JSON.stringify(Array.from(newSeen), null, 2), 'utf8');
  fs.writeFileSync('debug.json', JSON.stringify(debug, null, 2), 'utf8');

  console.log(`Saved current.csv (${rows.length}), new_today.csv (${newOnes.length}), snapshot_${d}.csv; groups=${debug.groups}`);
}

main().catch(e=>{ console.error(e); process.exit(1); });
