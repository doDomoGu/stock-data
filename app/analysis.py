"""分析层：把行情、财务、估值、同业数据整理成可解释的判断。

所有结论都由明确规则算出，并同时输出信号明细，便于人工复核；
评分只是把多个维度归一化后的排序参考，不构成投资建议。
"""
from __future__ import annotations

from . import indicators as ind

# 航空运输等重资产行业的财务阈值与制造业不同，这里用中性阈值并在提示中说明。
FIN_THRESHOLDS = {
    "revenue_growth": (10.0, 0.0),
    "profit_growth": (10.0, 0.0),
    "roe": (10.0, 5.0),
    "gross_margin": (20.0, 10.0),
    "debt_ratio": (50.0, 70.0),
}


def _pct_rank(values: list[float]) -> list[float]:
    """同业排序用：返回每个值在组内的分位（0 最差，100 最好，值越小越好时不适用）。"""
    clean = sorted(v for v in values if v is not None)
    if not clean:
        return []
    return [sum(1 for v in clean if v <= x) / len(clean) * 100 for x in values]


def trend_module(kline: list[dict]) -> dict:
    closes = [r["close"] for r in kline]
    highs = [r["high"] for r in kline]
    lows = [r["low"] for r in kline]
    volumes = [r["volume"] or 0 for r in kline]
    if len(closes) < 30:
        return {"available": False, "reason": "日线样本不足 30 个交易日"}

    s = ind.series(closes, highs, lows, volumes)
    last = -1
    ma = {p: (s[f"ma{p}"][last] if s[f"ma{p}"][last] is not None else None) for p in (5, 10, 20, 60, 120, 250)}
    close = closes[last]
    dif, dea, hist = s["macd"]["dif"][last], s["macd"]["dea"][last], s["macd"]["hist"][last]
    rsi14 = s["rsi14"][last]
    boll = s["boll"]
    position = ind.range_position(closes, 250)
    vol5, vol20 = s.get("vol_ma5", [None])[last], s.get("vol_ma20", [None])[last]

    # 均线排列
    alignment_pair = [ma[5], ma[10], ma[20], ma[60]]
    if all(v is not None for v in alignment_pair):
        if alignment_pair[0] > alignment_pair[1] > alignment_pair[2] > alignment_pair[3]:
            alignment, alignment_level = "多头排列（短期均线在长期均线之上）", "good"
        elif alignment_pair[0] < alignment_pair[1] < alignment_pair[2] < alignment_pair[3]:
            alignment, alignment_level = "空头排列（短期均线在长期均线之下）", "bad"
        else:
            alignment, alignment_level = "均线缠绕（方向不明）", "neutral"
    else:
        alignment, alignment_level = "均线数据不足", "neutral"

    # MACD 最近 5 根内有交叉时单独提示
    cross = None
    for i in range(max(1, len(closes) - 5), len(closes)):
        prev_diff = s["macd"]["dif"][i - 1] - s["macd"]["dea"][i - 1]
        cur_diff = s["macd"]["dif"][i] - s["macd"]["dea"][i]
        if prev_diff <= 0 < cur_diff:
            cross = f"{kline[i]['date']} MACD 金叉"
        elif prev_diff >= 0 > cur_diff:
            cross = f"{kline[i]['date']} MACD 死叉"

    signals = [
        {"label": "均线结构", "level": alignment_level, "detail": alignment},
        {"label": "价格 vs 年线",
         "level": "good" if ma[250] and close > ma[250] else "bad" if ma[250] else "neutral",
         "detail": f"现价 {close:.2f}，" + (f"年线(MA250) {ma[250]:.2f}，" + ("在其上方" if close > ma[250] else "在其下方") if ma[250] else "年线数据不足")},
        {"label": "MACD",
         "level": "good" if (dif or 0) > (dea or 0) and (hist or 0) > 0 else "bad" if (dif or 0) < (dea or 0) else "neutral",
         "detail": f"DIF {dif:.3f} / DEA {dea:.3f}，柱状 {hist:+.3f}" + (f"；{cross}" if cross else "")},
        {"label": "RSI(14)",
         "level": "bad" if (rsi14 or 50) > 70 else "good" if (rsi14 or 50) < 30 else "neutral",
         "detail": f"RSI {rsi14}" + ("，进入超买区" if (rsi14 or 50) > 70 else "，进入超卖区" if (rsi14 or 50) < 30 else "，处于中性区间") if rsi14 else "RSI 数据不足"},
        {"label": "布林带位置",
         "level": "neutral",
         "detail": (f"上轨 {boll['upper'][last]:.2f} / 中轨 {boll['mid'][last]:.2f} / 下轨 {boll['lower'][last]:.2f}，"
                    f"现价处于{'上轨附近' if boll['upper'][last] and close >= boll['upper'][last] * 0.99 else '下轨附近' if boll['lower'][last] and close <= boll['lower'][last] * 1.01 else '通道中部'}")
         if boll["upper"][last] else "布林带数据不足"},
        {"label": "区间位置", "level": "neutral",
         "detail": f"近 250 个交易日区间 {position['low']} ~ {position['high']}，现价位于 {position['pct']}% 分位"
         if position["pct"] is not None else "区间数据不足"},
        {"label": "量能",
         "level": "neutral" if not (vol5 and vol20) else "good" if vol5 > vol20 * 1.15 else "bad" if vol5 < vol20 * 0.85 else "neutral",
         "detail": f"5 日均量 {vol5:,.0f} 手，20 日均量 {vol20:,.0f} 手，" + ("近期放量" if vol5 > vol20 * 1.15 else "近期缩量" if vol5 < vol20 * 0.85 else "量能平稳")
         if (vol5 and vol20) else "量能数据不足"},
    ]

    score = 0
    score += 12 if alignment_level == "good" else 6 if alignment_level == "neutral" else 0
    score += 8 if ma[250] and close > ma[250] else 0
    score += 6 if (dif or 0) > (dea or 0) and (hist or 0) > 0 else 0
    score += 4 if ma[20] and close > ma[20] else 0

    return {
        "available": True,
        "score": score,
        "max_score": 30,
        "close": round(close, 2),
        "ma": {f"ma{p}": (round(v, 2) if v is not None else None) for p, v in ma.items()},
        "alignment": alignment,
        "macd": {"dif": dif, "dea": dea, "hist": hist, "cross": cross},
        "rsi14": rsi14,
        "atr14": s["atr14"][last],
        "position_250d": position,
        "signals": signals,
    }


def valuation_module(history: list[dict]) -> dict:
    if not history:
        return {"available": False, "reason": "估值历史缺失"}
    pe_series = [h["pe_ttm"] for h in history if h.get("pe_ttm") and h["pe_ttm"] > 0]
    pb_series = [h["pb_mrq"] for h in history if h.get("pb_mrq") and h["pb_mrq"] > 0]
    latest = history[-1]
    pe, pb = latest.get("pe_ttm"), latest.get("pb_mrq")
    pe_positive = bool(pe and pe > 0)
    pe_pct = ind.percentile_of(pe_series, pe) if pe_positive else None
    pb_pct = ind.percentile_of(pb_series, pb) if pb and pb > 0 else None

    parts = [p for p in (pe_pct, pb_pct) if p is not None]
    avg_pct = round(sum(parts) / len(parts), 1) if parts else None
    score = None if avg_pct is None else round(25 * (1 - avg_pct / 100), 1)

    pe_note = None if pe_positive else "PE(TTM) 为非正值（滚动口径下处于亏损状态），估值判断以 PB 分位为主"
    used = "PE 与 PB" if (pe_pct is not None and pb_pct is not None) else "PB" if pb_pct is not None else "PE"

    if avg_pct is None:
        level, text = "neutral", "估值分位不可用（估值序列缺失或指标无效）"
    elif avg_pct <= 20:
        level, text = "good", f"按 {used} 分位看，当前估值处于近 {len(history)} 个交易日的最低 {avg_pct}% 分位，偏低估区间"
    elif avg_pct <= 45:
        level, text = "good", f"按 {used} 分位看，当前估值分位 {avg_pct}%，位于历史中低位"
    elif avg_pct <= 70:
        level, text = "neutral", f"按 {used} 分位看，当前估值分位 {avg_pct}%，处于历史中枢附近"
    else:
        level, text = "bad", f"按 {used} 分位看，当前估值分位 {avg_pct}%，处于历史高位区间"

    return {
        "available": True,
        "score": score,
        "max_score": 25,
        "pe_ttm": pe,
        "pe_positive": pe_positive,
        "pe_note": pe_note,
        "pe_percentile": pe_pct,
        "pb": pb,
        "pb_percentile": pb_pct,
        "pe_median": ind.median(pe_series),
        "pb_median": ind.median(pb_series),
        "avg_percentile": avg_pct,
        "sample_days": len(history),
        "span": f"{history[0]['trade_date']} ~ {history[-1]['trade_date']}",
        "level": level,
        "summary": text,
    }


def financial_module(records: list[dict]) -> dict:
    if not records:
        return {"available": False, "reason": "财报数据缺失"}
    latest = records[0]
    rev_growth = latest.get("totaloperaterevetz")
    profit_growth = latest.get("parentnetprofittz")
    roe = latest.get("roejq")
    gross = latest.get("xsmll")
    net_margin = latest.get("xsjll")
    debt = latest.get("zcfzl")
    eps = latest.get("epsjb")
    cash_per_share = latest.get("mgjyxjje")

    # 现金流含金量：每股经营现金流 / 每股收益，>1 说明利润有现金支撑
    cash_quality = round(cash_per_share / eps, 2) if eps and cash_per_share is not None and eps != 0 else None

    rev_hi, rev_lo = FIN_THRESHOLDS["revenue_growth"]
    profit_hi, profit_lo = FIN_THRESHOLDS["profit_growth"]
    roe_hi, roe_lo = FIN_THRESHOLDS["roe"]
    gross_hi, gross_lo = FIN_THRESHOLDS["gross_margin"]
    debt_hi, debt_lo = FIN_THRESHOLDS["debt_ratio"]

    score = 0.0
    signals = []

    def grade(value, hi, lo, reverse=False):
        if value is None:
            return None, "neutral"
        if reverse:
            return ("good" if value < hi else "neutral" if value < lo else "bad")
        return ("good" if value > hi else "neutral" if value > lo else "bad")

    if rev_growth is not None:
        level = grade(rev_growth, rev_hi, rev_lo)
        score += 8 if level == "good" else 5 if level == "neutral" else 0
        signals.append({"label": "营收增速", "level": level, "detail": f"{latest['report_date_name']} 营收同比 {rev_growth:+.1f}%"})
    if profit_growth is not None:
        level = grade(profit_growth, profit_hi, profit_lo)
        score += 8 if level == "good" else 5 if level == "neutral" else 0
        signals.append({"label": "净利增速", "level": level, "detail": f"归母净利同比 {profit_growth:+.1f}%"})
    if roe is not None:
        level = grade(roe, roe_hi, roe_lo)
        score += 6 if level == "good" else 4 if level == "neutral" else 2
        signals.append({"label": "ROE", "level": level, "detail": f"净资产收益率 {roe:.2f}%"})
    if gross is not None:
        level = grade(gross, gross_hi, gross_lo)
        score += 4 if level == "good" else 2 if level == "neutral" else 1
        signals.append({"label": "毛利率", "level": level, "detail": f"销售毛利率 {gross:.2f}%，销售净利率 {net_margin:.2f}%" if net_margin is not None else f"销售毛利率 {gross:.2f}%"})
    if debt is not None:
        level = grade(debt, debt_hi, debt_lo, reverse=True)
        score += 4 if level == "good" else 2 if level == "neutral" else 0
        signals.append({"label": "资产负债率", "level": level, "detail": f"{debt:.2f}%（重资产行业普遍偏高，需结合同业看）"})
    if cash_quality is not None:
        level = "good" if cash_quality > 1 else "neutral" if cash_quality > 0.6 else "bad"
        signals.append({"label": "利润含金量", "level": level, "detail": f"每股经营现金流 / 每股收益 = {cash_quality}，{'利润有现金支撑' if cash_quality > 1 else '需关注现金回流'}"})

    trend = [{
        "报告期": r.get("report_date_name") or r.get("report_date"),
        "营业收入": r.get("totaloperatereve"),
        "营收同比": r.get("totaloperaterevetz"),
        "归母净利": r.get("parentnetprofit"),
        "净利同比": r.get("parentnetprofittz"),
        "毛利率": r.get("xsmll"),
        "净利率": r.get("xsjll"),
        "ROE": r.get("roejq"),
        "资产负债率": r.get("zcfzl"),
    } for r in records]

    return {
        "available": True,
        "score": round(min(score, 30), 1),
        "max_score": 30,
        "latest": {
            "report_date": latest.get("report_date"),
            "report_name": latest.get("report_date_name"),
            "revenue": latest.get("totaloperatereve"),
            "net_profit": latest.get("parentnetprofit"),
            "eps": eps,
            "bps": latest.get("bps"),
            "roe": roe,
            "gross_margin": gross,
            "net_margin": net_margin,
            "debt_ratio": debt,
            "cash_quality": cash_quality,
        },
        "trend": list(reversed(trend)),
        "signals": signals,
    }


def peer_module(peers: dict, self_quote: dict) -> dict:
    members = peers.get("members") or []
    if len(members) < 2:
        return {"available": False, "reason": "同业样本不足", "board": peers.get("board")}

    def clean(key):
        return [m[key] for m in members if m.get(key) is not None]

    pe_list = [m["pe_ttm"] if (m.get("pe_ttm") or 0) > 0 else None for m in members]
    pb_list = [m["pb"] if (m.get("pb") or 0) > 0 else None for m in members]
    pe_median = ind.median([v for v in pe_list if v])
    pb_median = ind.median([v for v in pb_list if v])

    self_member = next((m for m in members if m.get("is_self")), None)
    score = 0.0
    signals = []
    if self_member:
        if pe_median and self_member.get("pe_ttm") and self_member["pe_ttm"] > 0:
            cheaper = self_member["pe_ttm"] < pe_median
            score += 5 if cheaper else 1
            signals.append({"label": "相对 PE(TTM)", "level": "good" if cheaper else "neutral",
                            "detail": f"自身 {self_member['pe_ttm']:.2f} vs 同业中位数 {pe_median:.2f}"})
        if pb_median and self_member.get("pb"):
            cheaper = self_member["pb"] < pb_median
            score += 5 if cheaper else 1
            signals.append({"label": "相对 PB", "level": "good" if cheaper else "neutral",
                            "detail": f"自身 {self_member['pb']:.2f} vs 同业中位数 {pb_median:.2f}"})
        pcts = clean("pct_chg")
        if pcts:
            avg_pct = round(sum(pcts) / len(pcts), 2)
            diff = round((self_member.get("pct_chg") or 0) - avg_pct, 2)
            score += 5 if diff > 0 else 2
            signals.append({"label": "当日相对强度", "level": "good" if diff > 0 else "neutral",
                            "detail": f"自身 {self_member.get('pct_chg')}% vs 板块均值 {avg_pct}%（{diff:+.2f}pct）"})

    return {
        "available": True,
        "score": round(score, 1),
        "max_score": 15,
        "board": peers.get("board"),
        "industry": peers.get("industry"),
        "members": members,
        "pe_median": pe_median,
        "pb_median": pb_median,
        "signals": signals,
    }


def rating_of(total: float) -> tuple[str, str]:
    if total >= 80:
        return "强", "good"
    if total >= 65:
        return "偏强", "good"
    if total >= 45:
        return "中性", "neutral"
    if total >= 30:
        return "偏弱", "bad"
    return "弱", "bad"


def _fmt(value, unit: str = "", digits: int = 1, signed: bool = False) -> str:
    if value is None:
        return "—"
    fmt = f"{{:{'+' if signed else ''}.{digits}f}}{unit}"
    return fmt.format(value)


def build(code: str, name: str | None, quote: dict, kline: list[dict], financials: list[dict],
          valuation: list[dict], peers: dict) -> dict:
    trend = trend_module(kline)
    valuation_mod = valuation_module(valuation)
    financial = financial_module(financials)
    peer = peer_module(peers, quote)

    total = sum(m.get("score") or 0 for m in (trend, valuation_mod, financial, peer))
    rating, rating_level = rating_of(total)

    sentences = []
    if trend.get("available"):
        above_year = bool(trend["ma"]["ma250"]) and trend["close"] > trend["ma"]["ma250"]
        sentences.append(f"技术上，{trend['alignment']}，现价 {trend['close']} 元位于年线"
                         f"{'上方' if above_year else '下方'}，近一年区间分位 {trend['position_250d']['pct']}%。")
    if valuation_mod.get("available"):
        sentences.append(f"估值上，PE(TTM) {_fmt(valuation_mod['pe_ttm'], '', 2)}"
                         f"（历史分位 {_fmt(valuation_mod['pe_percentile'], '%', 1)}）、"
                         f"PB {_fmt(valuation_mod['pb'], '', 2)}"
                         f"（历史分位 {_fmt(valuation_mod['pb_percentile'], '%', 1)}），{valuation_mod['summary']}。")
        if valuation_mod.get("pe_note"):
            sentences.append(valuation_mod["pe_note"] + "。")
    if financial.get("available"):
        lat = financial["latest"]
        latest_row = financial["trend"][-1]
        sentences.append(f"财务上，{lat['report_name']} 营收同比 {_fmt(latest_row.get('营收同比'), '%', 1, True)}、"
                         f"归母净利同比 {_fmt(latest_row.get('净利同比'), '%', 1, True)}，"
                         f"ROE {_fmt(lat['roe'], '%', 2)}、资产负债率 {_fmt(lat['debt_ratio'], '%', 2)}。")
    if peer.get("available"):
        sentences.append(f"同业维度，所属板块「{peer['industry']}」共 {len(peer['members'])} 只标的。")

    risks: list[str] = []
    if financial.get("available"):
        lat = financial["latest"]
        if lat.get("debt_ratio") and lat["debt_ratio"] > 65:
            risks.append(f"资产负债率 {lat['debt_ratio']:.1f}%，杠杆偏高，利率与融资环境变化会放大利润波动。")
        if lat.get("net_margin") is not None and lat["net_margin"] < 5:
            risks.append(f"销售净利率仅 {lat['net_margin']:.2f}%，对成本端波动敏感。")
        rev = financial["trend"][-1].get("营收同比")
        profit = financial["trend"][-1].get("净利同比")
        if rev is not None and profit is not None and rev > 0 > profit:
            risks.append("增收未增利：营收增长但净利下滑，需核查成本与费用变化。")
    if valuation_mod.get("available") and (valuation_mod.get("avg_percentile") or 0) > 70:
        risks.append(f"估值处于历史 {(valuation_mod['avg_percentile'])}% 分位，向上空间受估值约束。")
    if trend.get("available") and (trend["position_250d"].get("pct") or 0) > 85:
        risks.append(f"股价位于近一年 {trend['position_250d']['pct']}% 分位，短期涨幅较大，注意回撤风险。")
    if trend.get("available") and (trend["rsi14"] or 50) > 70:
        risks.append(f"RSI 达 {trend['rsi14']}，短线超买。")

    notices = [
        "数据来自东方财富/新浪公开接口，非交易所授权数据，仅供研究参考。",
        "财报为报告期口径，同比数据受季节性与会计准则影响，需结合连续多期观察。",
        "航油价格、人民币汇率、客座率与单位收益等经营指标不在本数据源内，需结合公司月度经营公告补充。",
        "本页面为数据整理与规则化判断，不构成任何投资建议。",
    ]

    return {
        "code": code,
        "name": name,
        "total_score": round(total, 1),
        "max_score": 100,
        "rating": rating,
        "rating_level": rating_level,
        "dimensions": {
            "trend": {"score": trend.get("score"), "max": 30, "available": trend.get("available")},
            "valuation": {"score": valuation_mod.get("score"), "max": 25, "available": valuation_mod.get("available")},
            "financial": {"score": financial.get("score"), "max": 30, "available": financial.get("available")},
            "peer": {"score": peer.get("score"), "max": 15, "available": peer.get("available")},
        },
        "trend": trend,
        "valuation": valuation_mod,
        "financial": financial,
        "peer": peer,
        "conclusion": " ".join(sentences),
        "risks": risks,
        "notices": notices,
    }
