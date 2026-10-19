"""全链路自检：先直连数据源核对字段，再走接口层的缓存/降级路径跑一次完整分析。

用法：
    .venv/bin/python scripts/selfcheck.py [股票代码]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import analysis, datasource, store  # noqa: E402
from app.datasource import DataSourceError  # noqa: E402
from app.main import get_financials, get_kline, get_peers, get_quote, get_valuation  # noqa: E402


def probe(label: str, fn) -> None:
    """单个数据源独立探测，失败只记录，不中断整轮自检。"""
    try:
        print(f"  [ok] {label}: {fn()}")
    except DataSourceError as exc:
        print(f"  [fail] {label}: {str(exc)[:110]}")


def main(code: str = "601021") -> int:
    store.init_db()
    print(f"== 标的 {code} ==")

    print("-- 数据源直连 --")
    probe("实时行情", lambda: "东财" if datasource.fetch_quote(code)["source"] == "eastmoney" else "新浪(备用源)")
    probe("日线", lambda: f"{len(datasource.fetch_kline(code, limit=400))} 根")
    probe("周线", lambda: f"{len(datasource.fetch_kline(code, klt=102, limit=200))} 根")
    probe("财报", lambda: f"{len(datasource.fetch_financials(code, 8))} 期")
    probe("估值历史", lambda: f"{len(datasource.fetch_valuation_history(code))} 个交易日")
    probe("同业板块", lambda: datasource.fetch_peers(code)["industry"])

    print("-- 接口层路径（含缓存与降级）--")
    quote = get_quote(code)
    rows, kline_cached = get_kline(code, 101, 1, 400)
    fin, fin_cached = get_financials(code, 8)
    valuation, val_cached = get_valuation(code)
    try:
        peers = get_peers(code)
    except DataSourceError:
        peers = {"board": None, "members": [], "industry": None}
        print("  [warn] 同业数据不可用，本次分析跳过该维度")

    print(f"  行情来源={quote.get('source')} 价={quote.get('price')} 补字段={bool(quote.get('fields_filled'))}")
    print(f"  日线={len(rows)} 根(缓存={kline_cached}) 财报={len(fin)} 期(缓存={fin_cached}) "
          f"估值={len(valuation)} 天(缓存={val_cached})")

    if not quote and not rows:
        print("!! 行情与K线均不可用，无法产出分析")
        return 1

    result = analysis.build(code, quote.get("name"), quote, rows, fin, valuation, peers)
    print(f"\n综合评分: {result['total_score']}/100（{result['rating']}）")
    print("结论:", result["conclusion"])
    if result["risks"]:
        print("风险:")
        for r in result["risks"]:
            print("  -", r)
    print("技术信号:")
    for s in result["trend"]["signals"]:
        print(f"  [{s['level']}] {s['label']}: {s['detail']}")
    if result["financial"].get("available"):
        print("财务信号:")
        for s in result["financial"]["signals"]:
            print(f"  [{s['level']}] {s['label']}: {s['detail']}")

    print("\n存储:", json.dumps(store.stats(), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "601021"))
