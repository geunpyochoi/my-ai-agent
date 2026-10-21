"""온통청년 중앙부처 청년정책을 받아 지식베이스용 마크다운으로 저장한다.

사용법: python3 scripts/fetch_policies.py
결과: data/policies_<분야>.md (분야별 1개 파일)
"""
import json
import os
import re
import urllib.request
from collections import defaultdict
from datetime import datetime

URL = "https://www.youthcenter.go.kr/pubot/search/portalPolicySearch"
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
CENTRAL_GOV = "0054001"

# 온통청년 분류명이 개편 전/후로 섞여 있어 대표 분야로 묶는다 (첫 번째 분류 기준)
CATEGORIES = [
    ("일자리", "jobs", ("일자리",)),
    ("주거", "housing", ("주거",)),
    ("교육", "education", ("교육",)),
    ("복지·문화", "welfare", ("복지", "금융")),
    ("참여·권리", "participation", ("참여",)),
]


def categorize(p):
    first = clean(p.get("USER_CLSF_NM")).split(",")[0]
    for label, name, prefixes in CATEGORIES:
        if first.startswith(prefixes):
            return label, name
    return "기타", "etc"


def fetch_all():
    body = json.dumps({
        "PVSN_INST_GROUP_CD": CENTRAL_GOV,
        "query": "",
        "pageNum": 1,
        "sortFields": "DATE/DESC",
        "listCount": 1000,
        "searchFields": "all",
    }).encode()
    req = urllib.request.Request(URL, data=body, headers={
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0",
        "Referer": "https://www.youthcenter.go.kr/youthPolicy/ythPlcyTotalSearch",
    })
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.load(res)["searchResult"]["youthpolicy"]


def clean(text):
    text = re.sub(r"\s+", " ", (text or "").replace("|", ", ")).strip()
    return text


def fmt_date(ymd):
    return f"{ymd[:4]}.{ymd[4:6]}.{ymd[6:]}" if ymd and len(ymd) == 8 else ""


def age_text(p):
    lo, hi = p.get("SPRT_TRGT_MIN_AGE"), p.get("SPRT_TRGT_MAX_AGE")
    if p.get("SPRT_TRGT_AGE_LMT_YN") == "Y" or not (lo or hi) or (lo in ("", "0") and hi in ("", "0")):
        return "제한없음"
    return f"만 {lo}세 ~ 만 {hi}세"


def period_text(p):
    status = clean(p.get("APLY_PRD_SE_CD"))
    start, end = fmt_date(p.get("APLY_PRD_BGNG_YMD")), fmt_date(p.get("APLY_PRD_END_YMD"))
    if start or end:
        return f"{status} ({start} ~ {end})" if status else f"{start} ~ {end}"
    return status or "정보 없음"


def to_markdown(p):
    lines = [f"## {clean(p['PLCY_NM'])}"]
    fields = [
        ("분야", f"{clean(p.get('USER_CLSF_NM'))} > {clean(p.get('USER_MCLSF_NM'))}"),
        ("키워드", clean(p.get("PLCY_KYWD_NM"))),
        ("주관기관", clean(p.get("SPRVSN_INST_CD_NM"))),
        ("신청기간", period_text(p)),
        ("지원 연령", age_text(p)),
        ("소득 조건", clean(p.get("EARN_ETC_CN")) or "제한없음"),
        ("학력", clean(p.get("QLFC_ACBG_NM"))),
        ("취업상태", clean(p.get("EMPM_STTS_NM"))),
        ("정책 설명", clean(p.get("PLCY_EXPLN_CN"))),
        ("지원 내용", clean(p.get("PLCY_SPRT_CN"))),
        ("추가 자격", clean(p.get("ADD_APLY_QLFC_CND_CN"))),
        ("참여 제한", clean(p.get("PTCP_PRP_TRGT_CN"))),
        ("신청 방법", clean(p.get("PLCY_APLY_MTHD_CN"))),
        ("제출 서류", clean(p.get("SBMSN_DCMNT_CN"))),
        ("신청 링크", clean(p.get("APLY_URL_ADDR")) or clean(p.get("REF_URL_ADDR1"))),
    ]
    for label, value in fields:
        if value:
            lines.append(f"- {label}: {value}")
    return "\n".join(lines)


def main():
    # 마감된 정책은 답변에 혼선을 줘서 제외한다
    policies = [p for p in fetch_all() if clean(p.get("APLY_PRD_SE_CD")) != "마감"]
    groups = defaultdict(list)
    for p in policies:
        groups[categorize(p)].append(p)

    os.makedirs(OUT_DIR, exist_ok=True)
    today = datetime.now().strftime("%Y-%m-%d")
    total_chars = 0
    for (category, name), items in sorted(groups.items()):
        header = (
            f"# 청년정책 - {category} 분야 (중앙부처)\n\n"
            f"출처: 온통청년(youthcenter.go.kr) · 기준일: {today} · {len(items)}건\n"
        )
        body = "\n\n".join(to_markdown(p) for p in items)
        text = f"{header}\n{body}\n"
        with open(os.path.join(OUT_DIR, f"policies_{name}.md"), "w", encoding="utf-8") as f:
            f.write(text)
        total_chars += len(text)
        print(f"{category}: {len(items)}건, {len(text):,}자 -> policies_{name}.md")
    print(f"총 {len(policies)}건, {total_chars:,}자")


if __name__ == "__main__":
    main()
