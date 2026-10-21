// 청년정책 실시간 검색 MCP 서버 (Streamable HTTP, stateless JSON 응답)
// 의존성 없이 Vercel Node 함수 하나로 동작한다. 엔드포인트: POST /api/mcp

const SEARCH_URL = "https://www.youthcenter.go.kr/pubot/search/portalPolicySearch";
const DETAIL_URL = "https://www.youthcenter.go.kr/youthPolicy/ythPlcyTotalSearch/ythPlcyDetail/";
const CENTRAL_GOV = "0054001";
const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "youth-policy-mcp", version: "1.0.0" };

const REGIONS = {
  서울: "서울특별시", 부산: "부산광역시", 대구: "대구광역시", 인천: "인천광역시",
  광주: "전남광주통합특별시", 대전: "대전광역시", 울산: "울산광역시", 세종: "세종특별자치시",
  경기: "경기도", 강원: "강원특별자치도", 충북: "충청북도", 충남: "충청남도",
  전북: "전북특별자치도", 전남: "전남광주통합특별시", 경북: "경상북도", 경남: "경상남도",
  제주: "제주특별자치도",
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

function ymd(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

function fmtDate(s) {
  return s && s.length === 8 ? `${s.slice(0, 4)}.${s.slice(4, 6)}.${s.slice(6)}` : "";
}

// 검색어가 있으면 관련도순, 없으면 조회수순으로 받는다 (기본값인 등록일순은 엉뚱한 결과가 위에 온다)
async function searchPolicies({ keyword = "", region = "", listCount = 100, sortFields }) {
  const res = await fetch(SEARCH_URL, {
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
      sortFields: sortFields || (keyword ? "RANK/DESC" : "INQ_CNT/DESC"),
      listCount,
      searchFields: "all",
    }),
  });
  if (!res.ok) throw new Error(`온통청년 검색 실패 (HTTP ${res.status})`);
  const data = await res.json();
  return (data.searchResult && data.searchResult.youthpolicy) || [];
}

function isOpen(p) {
  return clean(p.APLY_PRD_SE_CD) !== "마감";
}

function fitsAge(p, age) {
  if (!age) return true;
  const lo = Number(p.SPRT_TRGT_MIN_AGE) || 0;
  const hi = Number(p.SPRT_TRGT_MAX_AGE) || 0;
  if (p.SPRT_TRGT_AGE_LMT_YN === "Y" || (!lo && !hi)) return true;
  return age >= lo && age <= (hi || 999);
}

function summarize(p) {
  const lo = p.SPRT_TRGT_MIN_AGE, hi = p.SPRT_TRGT_MAX_AGE;
  const ageText = !Number(lo) && (!Number(hi) || Number(hi) >= 999) ? "제한없음" : `만 ${lo}~${hi}세`;
  const start = fmtDate(p.APLY_PRD_BGNG_YMD), end = fmtDate(p.APLY_PRD_END_YMD);
  return {
    정책명: clean(p.PLCY_NM),
    분야: clean(p.USER_CLSF_NM),
    지역: p.PVSN_INST_GROUP_CD === CENTRAL_GOV ? "전국" : cut(p.STDG_NM.split(",")[0], 40),
    주관기관: clean(p.SPRVSN_INST_CD_NM),
    신청기간: start || end ? `${clean(p.APLY_PRD_SE_CD)} (${start} ~ ${end})` : clean(p.APLY_PRD_SE_CD) || "정보 없음",
    지원연령: ageText,
    지원내용: cut(p.PLCY_SPRT_CN || p.PLCY_EXPLN_CN, 300),
    신청방법: cut(p.PLCY_APLY_MTHD_CN, 200),
    신청링크: clean(p.APLY_URL_ADDR) || clean(p.REF_URL_ADDR1),
    상세링크: DETAIL_URL + p.DOCID,
    마감일: fmtDate(p.APLY_PRD_END_YMD),
  };
}

async function callTool(name, args = {}) {
  const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 10);

  if (name === "search_youth_policies") {
    const age = Number(args.age) || 0;
    const items = (await searchPolicies({ keyword: args.keyword, region: args.region }))
      .filter(isOpen)
      .filter((p) => fitsAge(p, age))
      .slice(0, limit)
      .map(summarize);
    return { 검색조건: { keyword: args.keyword || "", region: normalizeRegion(args.region), age: age || null }, 결과수: items.length, 정책: items };
  }

  if (name === "list_closing_soon") {
    const days = Math.min(Math.max(Number(args.days) || 7, 1), 60);
    const today = new Date();
    const until = new Date(today.getTime() + days * 86400000);
    const [from, to] = [ymd(today), ymd(until)];
    const items = (await searchPolicies({ region: args.region, listCount: 1000, sortFields: "DATE/DESC" }))
      .filter(isOpen)
      .filter((p) => p.APLY_PRD_END_YMD >= from && p.APLY_PRD_END_YMD <= to)
      .sort((a, b) => a.APLY_PRD_END_YMD.localeCompare(b.APLY_PRD_END_YMD))
      .slice(0, limit)
      .map(summarize);
    return { 기준일: fmtDate(from), 마감기한: fmtDate(to), 결과수: items.length, 정책: items };
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
