// 청년정책 실시간 검색 MCP 서버 (Streamable HTTP, stateless JSON 응답)
// 의존성 없이 Vercel Node 함수 하나로 동작한다. 엔드포인트: POST /api/mcp
//
// 데이터 경로
// - YOUTHCENTER_API_KEY 환경변수가 있으면 온통청년 공식 Open API(getPlcy)로 전체 정책을 받아 1시간 캐시하고,
//   검색·지역·나이 필터와 관련도 정렬을 이 서버에서 직접 한다.
// - 키가 없으면 온통청년 사이트의 통합검색을 예비 경로로 쓴다.

const OFFICIAL_URL = "https://www.youthcenter.go.kr/go/ythip/getPlcy";
const PORTAL_URL = "https://www.youthcenter.go.kr/pubot/search/portalPolicySearch";
const DETAIL_URL = "https://www.youthcenter.go.kr/youthPolicy/ythPlcyTotalSearch/ythPlcyDetail/";
const CENTRAL_GOV = "0054001";
const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "youth-policy-mcp", version: "1.1.0" };
const CACHE_TTL_MS = 60 * 60 * 1000;
const NATIONWIDE_SIDO_COUNT = 15; // 대상 시·도가 이만큼 넓으면 전국 정책으로 본다

const REGIONS = {
  서울: "서울특별시", 부산: "부산광역시", 대구: "대구광역시", 인천: "인천광역시",
  광주: "전남광주통합특별시", 대전: "대전광역시", 울산: "울산광역시", 세종: "세종특별자치시",
  경기: "경기도", 강원: "강원특별자치도", 충북: "충청북도", 충남: "충청남도",
  전북: "전북특별자치도", 전남: "전남광주통합특별시", 경북: "경상북도", 경남: "경상남도",
  제주: "제주특별자치도",
};

// 법정동 코드 앞 두 자리 → 시·도
const SIDO_BY_CODE = {
  11: "서울특별시", 26: "부산광역시", 27: "대구광역시", 28: "인천광역시", 29: "전남광주통합특별시",
  30: "대전광역시", 31: "울산광역시", 36: "세종특별자치시", 41: "경기도", 42: "강원특별자치도",
  51: "강원특별자치도", 43: "충청북도", 44: "충청남도", 45: "전북특별자치도", 52: "전북특별자치도",
  46: "전남광주통합특별시", 47: "경상북도", 48: "경상남도", 50: "제주특별자치도",
};

// 화면의 분야 버튼처럼 넓은 단어는 관련어까지 함께 찾는다
const SYNONYMS = {
  주거: ["주거", "월세", "전세", "임대", "주택", "보증금"],
  취업: ["취업", "일자리", "구직", "창업", "인턴", "채용", "일경험"],
  교육: ["교육", "훈련", "자격증", "장학", "강좌", "역량"],
  금융: ["금융", "적금", "자산", "생활비", "저축", "대출", "통장"],
};

const TOOLS = [
  {
    name: "search_youth_policies",
    description:
      "온통청년에서 지금 신청 가능한 청년정책을 실시간으로 검색한다. 사용자의 나이, 거주 시·도, 관심 키워드로 걸러서 정책명, 지원내용, 신청기간, 신청방법을 돌려준다.",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "검색어. 예: 월세, 취업, 창업, 교통비, 자격증" },
        region: { type: "string", description: "거주 시·도. 예: 서울, 경기, 부산 (생략하면 전국)" },
        age: { type: "integer", description: "사용자 만 나이. 지원 연령 범위로 거른다" },
        limit: { type: "integer", description: "돌려줄 정책 수 (기본 5, 최대 10)" },
      },
    },
  },
  {
    name: "list_closing_soon",
    description:
      "신청 마감이 임박한 청년정책을 마감일 순으로 보여준다. '이번 주 마감', '곧 끝나는 정책' 같은 질문에 쓴다.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "integer", description: "오늘부터 며칠 안에 마감되는지 (기본 7)" },
        region: { type: "string", description: "거주 시·도. 예: 서울, 경기 (생략하면 전국)" },
        limit: { type: "integer", description: "돌려줄 정책 수 (기본 5, 최대 10)" },
      },
    },
  },
];

function clean(text) {
  return String(text || "").replace(/<[^>]*>/g, "").replace(/\|/g, ", ").replace(/\s+/g, " ").trim();
}

function cut(text, max) {
  const t = clean(text);
  return t.length > max ? t.slice(0, max) + "…" : t;
}

function normalizeRegion(region) {
  if (!region) return "";
  const r = clean(region);
  const key = Object.keys(REGIONS).find((k) => r.startsWith(k));
  return key ? REGIONS[key] : r;
}

function shortRegion(sido) {
  return Object.keys(REGIONS).find((k) => REGIONS[k] === sido && k !== "전남") || sido;
}

// 한국 시간 기준 오늘(YYYYMMDD)
function todayYmd(offsetDays = 0) {
  const kst = new Date(Date.now() + 9 * 3600000 + offsetDays * 86400000);
  return kst.toISOString().slice(0, 10).replace(/-/g, "");
}

function fmtDate(s) {
  return s && s.length === 8 ? `${s.slice(0, 4)}.${s.slice(4, 6)}.${s.slice(6)}` : "";
}

// 상시 정책은 날짜 자리에 "0" 같은 값이 들어오므로 8자리 날짜만 인정한다
function ymdOrEmpty(value) {
  const s = String(value || "").replace(/\D/g, "");
  return s.length === 8 ? s : "";
}

function uniq(list) {
  return [...new Set(list.filter(Boolean))];
}

// ---------- 두 데이터 경로를 같은 모양으로 맞춘다 ----------

function fromPortal(p) {
  const sidos = uniq(clean(p.STDG_NM).split(",").map((s) => s.trim().split(" ")[0]));
  const status = clean(p.APLY_PRD_SE_CD);
  return {
    id: p.DOCID,
    name: clean(p.PLCY_NM),
    category: clean(p.USER_CLSF_NM),
    subcategory: clean(p.USER_MCLSF_NM),
    keywords: clean(p.PLCY_KYWD_NM),
    explain: p.PLCY_EXPLN_CN,
    support: p.PLCY_SPRT_CN,
    institution: clean(p.SPRVSN_INST_CD_NM),
    minAge: Number(p.SPRT_TRGT_MIN_AGE) || 0,
    maxAge: Number(p.SPRT_TRGT_MAX_AGE) || 0,
    noAgeLimit: p.SPRT_TRGT_AGE_LMT_YN === "Y",
    start: ymdOrEmpty(p.APLY_PRD_BGNG_YMD),
    end: ymdOrEmpty(p.APLY_PRD_END_YMD),
    status,
    applyMethod: p.PLCY_APLY_MTHD_CN,
    applyUrl: clean(p.APLY_URL_ADDR) || clean(p.REF_URL_ADDR1),
    sidos,
    central: p.PVSN_INST_GROUP_CD === CENTRAL_GOV,
    national: p.PVSN_INST_GROUP_CD === CENTRAL_GOV || sidos.length >= NATIONWIDE_SIDO_COUNT,
    views: Number(p.INQ_CNT) || 0,
  };
}

function fromOfficial(p) {
  const codes = clean(p.zipCd).split(",").map((c) => c.trim()).filter(Boolean);
  const sidos = uniq(codes.map((c) => SIDO_BY_CODE[c.slice(0, 2)]));
  const [start, end] = [...clean(p.aplyYmd).split("~"), "", ""].slice(0, 2).map(ymdOrEmpty);
  return {
    id: p.plcyNo,
    name: clean(p.plcyNm),
    category: clean(p.lclsfNm),
    subcategory: clean(p.mclsfNm),
    keywords: clean(p.plcyKywdNm),
    explain: p.plcyExplnCn,
    support: p.plcySprtCn,
    institution: clean(p.sprvsnInstCdNm),
    minAge: Number(p.sprtTrgtMinAge) || 0,
    maxAge: Number(p.sprtTrgtMaxAge) || 0,
    noAgeLimit: p.sprtTrgtAgeLmtYn === "Y",
    start,
    end,
    status: start || end ? "" : "상시",
    applyMethod: p.plcyAplyMthdCn,
    applyUrl: clean(p.aplyUrlAddr) || clean(p.refUrlAddr1),
    sidos,
    central: p.pvsnInstGroupCd === CENTRAL_GOV,
    national: p.pvsnInstGroupCd === CENTRAL_GOV || sidos.length >= NATIONWIDE_SIDO_COUNT,
    views: Number(p.inqCnt) || 0,
  };
}

// ---------- 공식 Open API (키가 있을 때) ----------

let officialCache = { at: 0, items: null, pending: null };

function findPolicyList(data) {
  if (!data || typeof data !== "object") return null;
  if (Array.isArray(data.youthPolicyList)) return data;
  for (const value of Object.values(data)) {
    const found = findPolicyList(value);
    if (found) return found;
  }
  return null;
}

async function fetchOfficialPage(apiKey, pageNum, pageSize) {
  const url = `${OFFICIAL_URL}?apiKeyNm=${encodeURIComponent(apiKey)}&pageNum=${pageNum}&pageSize=${pageSize}&rtnType=json`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (youth-policy-mcp)" } });
  if (!res.ok) throw new Error(`공식 API 호출 실패 (HTTP ${res.status})`);
  const data = await res.json();
  if (data.errorCode) throw new Error(`공식 API 오류: ${data.errorMsg || data.errorCode}`);
  const holder = findPolicyList(data);
  if (!holder) throw new Error("공식 API 응답에서 정책 목록을 찾지 못했어요");
  const paging = findPaging(data);
  return { list: holder.youthPolicyList, total: paging ? Number(paging.totCount) : null };
}

function findPaging(data) {
  if (!data || typeof data !== "object") return null;
  if ("totCount" in data) return data;
  for (const value of Object.values(data)) {
    const found = findPaging(value);
    if (found) return found;
  }
  return null;
}

async function loadOfficialAll(apiKey) {
  if (officialCache.items && Date.now() - officialCache.at < CACHE_TTL_MS) return officialCache.items;
  if (officialCache.pending) return officialCache.pending;

  officialCache.pending = (async () => {
    const pageSize = 100;
    const first = await fetchOfficialPage(apiKey, 1, pageSize);
    const pages = first.total ? Math.min(Math.ceil(first.total / pageSize), 60) : 1;
    const rest = [];
    for (let page = 2; page <= pages; page += 6) {
      const batch = [];
      for (let p = page; p < page + 6 && p <= pages; p++) batch.push(fetchOfficialPage(apiKey, p, pageSize));
      rest.push(...(await Promise.all(batch)));
    }
    const items = [first, ...rest].flatMap((r) => r.list).map(fromOfficial);
    officialCache = { at: Date.now(), items, pending: null };
    return items;
  })();

  try {
    return await officialCache.pending;
  } catch (err) {
    officialCache.pending = null;
    throw err;
  }
}

// ---------- 온통청년 통합검색 (예비 경로) ----------

async function searchPortal({ keyword = "", region = "", listCount = 100, sortFields }) {
  const res = await fetch(PORTAL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (youth-policy-mcp)",
      Referer: "https://www.youthcenter.go.kr/youthPolicy/ythPlcyTotalSearch",
    },
    body: JSON.stringify({
      query: keyword,
      STDG_CTPV_NM: normalizeRegion(region),
      pageNum: 1,
      // 검색어가 있으면 관련도순, 없으면 조회수순 (기본값인 등록일순은 엉뚱한 결과가 위에 온다)
      sortFields: sortFields || (keyword ? "RANK/DESC" : "INQ_CNT/DESC"),
      listCount,
      searchFields: "all",
    }),
  });
  if (!res.ok) throw new Error(`온통청년 검색 실패 (HTTP ${res.status})`);
  const data = await res.json();
  return ((data.searchResult && data.searchResult.youthpolicy) || []).map(fromPortal);
}

// ---------- 공통 필터 · 정렬 ----------

function isOpen(p, today = todayYmd()) {
  if (p.status === "마감") return false;
  if (p.end && p.end < today) return false;
  return true;
}

function fitsAge(p, age) {
  if (!age || p.noAgeLimit || (!p.minAge && !p.maxAge)) return true;
  return age >= p.minAge && age <= (p.maxAge || 999);
}

function fitsRegion(p, sido) {
  if (!sido) return true;
  return p.national || p.sidos.includes(sido);
}

function expandTerms(keyword) {
  return uniq(
    clean(keyword)
      .split(/[\s,]+/)
      .flatMap((term) => SYNONYMS[term] || [term])
  );
}

// 공식 API 경로는 전체 목록을 직접 정렬해야 해서 간단한 관련도 점수를 매긴다
function relevance(p, terms) {
  let score = 0;
  for (const term of terms) {
    if (p.name.includes(term)) score += 5;
    if (p.keywords.includes(term) || p.subcategory.includes(term) || p.category.includes(term)) score += 3;
    if (clean(p.support).includes(term) || clean(p.explain).includes(term)) score += 1;
  }
  return score;
}

// 전국 대상은 아니지만 대상 시·도가 둘 이상인 정책 (예: 다른 지역 기관이 여러 시·도를 대상으로 등록한 정책)
function isMultiRegion(p) {
  return !p.national && p.sidos.length > 1;
}

// 지역을 골랐을 때 보여줄 순서: 그 지역 전용 정책 → 중앙부처 정책 → 여러 지역 대상 정책 → 다른 지역이 낸 전국 대상 정책
function regionTier(p, sido) {
  if (!sido) return 0;
  if (!p.national && p.sidos.length === 1 && p.sidos[0] === sido) return 0;
  if (p.central) return 1;
  if (isMultiRegion(p)) return 2;
  return 3;
}

function regionLabel(p, sido) {
  if (p.national) return "전국";
  if (isMultiRegion(p)) return "여러 지역";
  if (sido && p.sidos.includes(sido)) return shortRegion(sido);
  return p.sidos.length ? shortRegion(p.sidos[0]) : "";
}

function statusLabel(p, today = todayYmd()) {
  if (p.status === "상시" || (!p.start && !p.end)) return "상시";
  if (p.start && p.start > today) return "예정";
  return p.status && p.status !== "" ? p.status : "진행중";
}

function summarize(p, sido) {
  const ageText = p.noAgeLimit || (!p.minAge && (!p.maxAge || p.maxAge >= 999)) ? "제한없음" : `만 ${p.minAge}~${p.maxAge}세`;
  const status = statusLabel(p);
  const start = fmtDate(p.start), end = fmtDate(p.end);
  return {
    정책명: p.name,
    분야: p.category,
    지역: regionLabel(p, sido),
    주관기관: p.institution,
    신청기간: start || end ? `${status} (${start} ~ ${end})` : status,
    지원연령: ageText,
    지원내용: cut(p.support || p.explain, 300),
    신청방법: cut(p.applyMethod, 200),
    신청링크: p.applyUrl,
    상세링크: DETAIL_URL + p.id,
    마감일: end,
  };
}

async function callTool(name, args = {}) {
  const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 10);
  const sido = normalizeRegion(args.region);
  const apiKey = process.env.YOUTHCENTER_API_KEY;
  const today = todayYmd();

  if (name === "search_youth_policies") {
    const age = Number(args.age) || 0;
    const keyword = clean(args.keyword);
    let items;
    let source;

    if (apiKey) {
      const terms = expandTerms(keyword);
      items = (await loadOfficialAll(apiKey))
        .filter((p) => isOpen(p, today) && fitsAge(p, age) && fitsRegion(p, sido))
        .map((p) => ({ p, score: terms.length ? relevance(p, terms) : 0 }))
        .filter(({ score }) => !terms.length || score > 0)
        // 같은 점수라면 지역 순서(regionTier), 그다음 조회수순
        .sort((a, b) => b.score - a.score || regionTier(a.p, sido) - regionTier(b.p, sido) || b.p.views - a.p.views)
        .map(({ p }) => p);
      source = "온통청년 공식 Open API";
    } else {
      // 관련도순은 유지하되, 지역을 골랐다면 regionTier 순서로 묶어서 보여준다
      items = (await searchPortal({ keyword, region: args.region }))
        .filter((p) => isOpen(p, today) && fitsAge(p, age) && fitsRegion(p, sido))
        .map((p, rank) => ({ p, rank }))
        .sort((a, b) => regionTier(a.p, sido) - regionTier(b.p, sido) || a.rank - b.rank)
        .map(({ p }) => p);
      source = "온통청년 통합검색";
    }

    const picked = items.slice(0, limit).map((p) => summarize(p, sido));
    return { 데이터출처: source, 검색조건: { keyword, region: sido, age: age || null }, 결과수: picked.length, 정책: picked };
  }

  if (name === "list_closing_soon") {
    const days = Math.min(Math.max(Number(args.days) || 7, 1), 60);
    const until = todayYmd(days);
    const pool = apiKey
      ? await loadOfficialAll(apiKey)
      : await searchPortal({ region: args.region, listCount: 1000, sortFields: "DATE/DESC" });
    const picked = pool
      .filter((p) => isOpen(p, today) && fitsRegion(p, sido) && p.end && p.end >= today && p.end <= until)
      .sort((a, b) => a.end.localeCompare(b.end))
      .slice(0, limit)
      .map((p) => summarize(p, sido));
    return {
      데이터출처: apiKey ? "온통청년 공식 Open API" : "온통청년 통합검색",
      기준일: fmtDate(today),
      마감기한: fmtDate(until),
      결과수: picked.length,
      정책: picked,
    };
  }

  throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
}

async function handleMessage(msg) {
  const { id, method, params } = msg;
  const reply = (result) => ({ jsonrpc: "2.0", id, result });

  switch (method) {
    case "initialize":
      return reply({
        protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: "온통청년 청년정책을 실시간으로 검색하는 도구 모음입니다.",
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      try {
        const result = await callTool(params.name, params.arguments);
        return reply({ content: [{ type: "text", text: JSON.stringify(result, null, 1) }] });
      } catch (err) {
        if (err.code === -32602) return { jsonrpc: "2.0", id, error: { code: -32602, message: err.message } };
        return reply({ content: [{ type: "text", text: `검색 중 오류: ${err.message}` }], isError: true });
      }
    }
    default:
      if (id === undefined) return null; // 알림(notifications/*)은 응답하지 않는다
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Mcp-Session-Id, Mcp-Protocol-Version");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Use POST" } });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  if (!body) return res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });

  // MCP를 지원하지 않는 클라이언트(ElevenLabs 웹훅 도구 등)는 ?tool=이름 으로 같은 도구를 바로 호출한다
  if (req.query && req.query.tool && !body.jsonrpc) {
    try {
      return res.status(200).json(await callTool(req.query.tool, body));
    } catch (err) {
      return res.status(err.code === -32602 ? 404 : 502).json({ error: err.message });
    }
  }

  const messages = Array.isArray(body) ? body : [body];
  const replies = (await Promise.all(messages.map(handleMessage))).filter(Boolean);
  if (!replies.length) return res.status(202).end();
  return res.status(200).json(Array.isArray(body) ? replies : replies[0]);
};

// 로컬 테스트용 (Vercel은 module.exports만 사용)
module.exports._internal = { fromPortal, fromOfficial, fitsRegion, fitsAge, isOpen, relevance, expandTerms, summarize, regionLabel, regionTier, findPolicyList, findPaging, todayYmd };
