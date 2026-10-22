"""公开行情数据源封装。

东方财富网页接口为主，新浪行情作为实时报价的备用源；
所有出网请求都经统一限流与重试，失败重试后仍不可用则抛 DataSourceError。
"""
from __future__ import annotations

import json
import random
import re
import threading
import time
from datetime import datetime
from typing import Any

import requests

from . import config


class DataSourceError(RuntimeError):
    """数据源不可用，或返回了无法解析的结果。"""


_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
}

_session = requests.Session()
_session.headers.update(_HEADERS)

_session_lock = threading.Lock()
_rate_lock = threading.Lock()
_last_request_at = 0.0


def _rotate_session() -> None:
    """连接被对端重置后，连接池里的 keep-alive 连接已失效，必须整条换掉再重试。"""
    global _session
    with _session_lock:
        try:
            _session.close()
        except Exception:
            pass
        _session = requests.Session()
        _session.headers.update(_HEADERS)


def _throttle() -> None:
    global _last_request_at
    with _rate_lock:
        wait = config.REQUEST_INTERVAL - (time.time() - _last_request_at)
        if wait > 0:
            time.sleep(wait)
        _last_request_at = time.time()


def _get(url: str, params: dict[str, Any] | None = None, referer: str | None = None) -> Any:
    last_error: Exception | None = None
    for attempt in range(config.HTTP_RETRY):
        _throttle()
        try:
            resp = _session.get(
                url, params=params, timeout=config.HTTP_TIMEOUT,
                headers={"Referer": referer} if referer else None,
            )
            resp.raise_for_status()
            return json.loads(resp.text)
        except Exception as exc:  # 超时/连接重置/限流/非 JSON 都按可重试处理
            last_error = exc
            _rotate_session()
            time.sleep(config.HTTP_BACKOFF * (attempt + 1) + random.uniform(0, 0.3))
    raise DataSourceError(f"数据源请求失败：{url}（{last_error}）")


def _post_json(url: str, payload: dict, referer: str | None = None) -> Any:
    last_error: Exception | None = None
    for attempt in range(config.HTTP_RETRY):
        _throttle()
        try:
            resp = _session.post(
                url, json=payload, timeout=config.HTTP_TIMEOUT,
                headers={"Referer": referer} if referer else None,
            )
            resp.raise_for_status()
            return json.loads(resp.text)
        except Exception as exc:
            last_error = exc
            _rotate_session()
            time.sleep(config.HTTP_BACKOFF * (attempt + 1) + random.uniform(0, 0.3))
    raise DataSourceError(f"数据源请求失败：{url}（{last_error}）")


def _get_text(url: str, referer: str | None = None, encoding: str = "gbk") -> str:
    """纯文本接口（腾讯/新浪的行情是 GBK 文本，不是 JSON）。"""
    last_error: Exception | None = None
    for attempt in range(config.HTTP_RETRY):
        _throttle()
        try:
            resp = _session.get(
                url, timeout=config.HTTP_TIMEOUT,
                headers={"Referer": referer} if referer else None,
            )
            resp.raise_for_status()
            return resp.content.decode(encoding, errors="ignore")
        except Exception as exc:
            last_error = exc
            _rotate_session()
            time.sleep(config.HTTP_BACKOFF * (attempt + 1) + random.uniform(0, 0.3))
    raise DataSourceError(f"数据源请求失败：{url}（{last_error}）")


def _num(value: Any) -> float | None:
    if value is None or value == "" or value == "-":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------- 代码与市场

def normalize_code(code: str) -> str:
    digits = re.sub(r"\D", "", str(code or ""))
    if len(digits) != 6:
        raise ValueError(f"股票代码应为 6 位数字：{code}")
    return digits


def to_secid(code: str) -> str:
    """东方财富的市场前缀：沪市 1，深市/北交所 0。"""
    code = normalize_code(code)
    return ("1." if code[0] in "69" else "0.") + code


# ---------------------------------------------------------------- 实时行情

_QUOTE_FIELDS = "f43,f44,f45,f46,f47,f48,f50,f57,f58,f60,f116,f117,f162,f167,f168,f169,f170,f171"


def fetch_quote_eastmoney(code: str) -> dict:
    raw = _get(
        "https://push2.eastmoney.com/api/qt/stock/get",
        {"secid": to_secid(code), "fltt": 2, "invt": 2, "fields": _QUOTE_FIELDS},
    )
    data = (raw or {}).get("data") or {}
    if not data:
        raise DataSourceError(f"东方财富行情为空：{code}")
    return {
        "code": code,
        "name": data.get("f58"),
        "price": _num(data.get("f43")),
        "change": _num(data.get("f169")),
        "pct_chg": _num(data.get("f170")),
        "open": _num(data.get("f46")),
        "high": _num(data.get("f44")),
        "low": _num(data.get("f45")),
        "prev_close": _num(data.get("f60")),
        "volume": _num(data.get("f47")),
        "amount": _num(data.get("f48")),
        "volume_ratio": _num(data.get("f50")),
        "turnover": _num(data.get("f168")),
        "amplitude": _num(data.get("f171")),
        "market_cap": _num(data.get("f116")),
        "float_market_cap": _num(data.get("f117")),
        "pe_dynamic": _num(data.get("f162")),
        "pb": _num(data.get("f167")),
        "source": "eastmoney",
    }


def fetch_quote_tencent(code: str) -> dict:
    """腾讯行情：海外服务器上比东财快，且不会像东财那样被重定向到延时行情。"""
    text = _get_text(f"https://qt.gtimg.cn/q={symbol_prefix(code)}{code}", referer="https://gu.qq.com/")
    match = re.search(r'"(.*)"', text)
    if not match or not match.group(1):
        raise DataSourceError(f"腾讯行情无数据：{code}")
    f = match.group(1).split("~")
    if len(f) < 47:
        raise DataSourceError(f"腾讯行情字段异常：{code}")

    def pick(index: int) -> float | None:
        return _num(f[index]) if index < len(f) else None

    amount_wan, market_cap_yi, float_cap_yi = pick(37), pick(45), pick(44)
    return {
        "code": code,
        "name": f[1] or None,
        "price": pick(3),
        "change": pick(31),
        "pct_chg": pick(32),
        "open": pick(5),
        "high": pick(33),
        "low": pick(34),
        "prev_close": pick(4),
        # 腾讯的成交量单位已是手，成交额单位是万元，市值单位是亿元
        "volume": pick(36),
        "amount": None if amount_wan is None else round(amount_wan * 10000, 2),
        "volume_ratio": pick(49),
        "turnover": pick(38),
        "amplitude": pick(43),
        "market_cap": None if market_cap_yi is None else round(market_cap_yi * 1e8, 2),
        "float_market_cap": None if float_cap_yi is None else round(float_cap_yi * 1e8, 2),
        "pe_dynamic": pick(39),
        "pb": pick(46),
        "source": "tencent",
    }


def fetch_quote_sina(code: str) -> dict:
    text = _get_text(f"https://hq.sinajs.cn/list={symbol_prefix(code)}{code}",
                     referer="https://finance.sina.com.cn")
    match = re.search(r'"(.*)"', text)
    if not match or not match.group(1):
        raise DataSourceError(f"新浪行情无数据：{code}")
    parts = match.group(1).split(",")
    price, prev_close = _num(parts[3]), _num(parts[2])
    pct = round((price - prev_close) / prev_close * 100, 2) if price and prev_close else None
    # 新浪的成交量单位是股，统一换算成手，与主源保持一致
    sina_volume = _num(parts[8])
    return {
        "code": code, "name": parts[0], "price": price, "change": round(price - prev_close, 2) if price and prev_close else None,
        "pct_chg": pct, "open": _num(parts[1]), "high": _num(parts[4]), "low": _num(parts[5]),
        "prev_close": prev_close,
        "volume": None if sina_volume is None else round(sina_volume / 100, 2),
        "amount": _num(parts[9]),
        "volume_ratio": None, "turnover": None, "amplitude": None,
        "market_cap": None, "float_market_cap": None, "pe_dynamic": None, "pb": None,
        "source": "sina",
    }


# 默认顺序：东财 → 腾讯 → 新浪。东财对海外 IP 会重定向到 push2delay（延时行情），
# 那类服务器上把 STOCK_TOOL_QUOTE_SOURCE 设为 tencent，直接取腾讯的实时行情。
_QUOTE_PROVIDERS = {
    "eastmoney": fetch_quote_eastmoney,
    "tencent": fetch_quote_tencent,
    "sina": fetch_quote_sina,
}


def fetch_quote(code: str) -> dict:
    code = normalize_code(code)
    preferred = config.QUOTE_SOURCE.strip().lower()
    if preferred in _QUOTE_PROVIDERS:
        order = [preferred] + [name for name in _QUOTE_PROVIDERS if name != preferred]
    else:
        order = ["eastmoney", "tencent", "sina"]

    errors: list[str] = []
    for name in order:
        try:
            return _QUOTE_PROVIDERS[name](code)
        except DataSourceError as exc:
            errors.append(f"{name}: {exc}")
    raise DataSourceError("行情主备源均不可用：" + "；".join(errors))


# ---------------------------------------------------------------- 日线/周线/月线

KLT = {"day": 101, "week": 102, "month": 103, "60min": 60, "15min": 15, "5min": 5}

# 备用源（腾讯）的周期与复权参数映射，仅支持 日/周/月
_TENCENT_PERIOD = {101: "day", 102: "week", 103: "month"}
_TENCENT_FQ = {0: "", 1: "qfq", 2: "hfq"}


def symbol_prefix(code: str) -> str:
    return "sh" if code[0] in "69" else "sz"


def _fetch_kline_eastmoney(code: str, klt: int, fqt: int, limit: int) -> list[dict]:
    raw = _get(
        "https://push2his.eastmoney.com/api/qt/stock/kline/get",
        {
            "secid": to_secid(code),
            "fields1": "f1,f2,f3,f4,f5,f6",
            "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
            "klt": klt, "fqt": fqt, "beg": "0", "end": "20500101", "lmt": limit,
        },
    )
    data = (raw or {}).get("data") or {}
    out: list[dict] = []
    for line in data.get("klines") or []:
        f = line.split(",")
        if len(f) < 8:
            continue
        out.append({
            "date": f[0], "open": _num(f[1]), "close": _num(f[2]), "high": _num(f[3]), "low": _num(f[4]),
            "volume": _num(f[5]), "amount": _num(f[6]), "amplitude": _num(f[7]),
            "pct_chg": _num(f[8]), "change": _num(f[9]), "turnover": _num(f[10]) if len(f) > 10 else None,
        })
    if not out:
        raise DataSourceError(f"日线数据为空：{code}")
    # 该接口的 lmt 参数不生效，统一在本地截取最近 limit 根
    return out[-limit:]


def fetch_kline_tencent(code: str, klt: int = 101, fqt: int = 1, limit: int = 800) -> list[dict]:
    """腾讯行情作为 K 线备用源：没有成交额/换手率，涨跌幅按相邻收盘价自算。"""
    if klt not in _TENCENT_PERIOD:
        raise DataSourceError(f"备用源不支持该周期（klt={klt}）")
    symbol = symbol_prefix(code) + code
    period, fq = _TENCENT_PERIOD[klt], _TENCENT_FQ.get(fqt, "")
    param = ",".join([symbol, period, "", "", str(min(limit, 800)), fq])
    raw = _get("https://web.ifzq.gtimg.cn/appstock/app/fqkline/get", {"param": param})
    node = ((raw or {}).get("data") or {}).get(symbol) or {}
    series = node.get(f"{fq}{period}") or node.get(period) or []
    out: list[dict] = []
    prev_close: float | None = None
    for item in series:
        if len(item) < 6:
            continue
        date, close = item[0], _num(item[2])
        out.append({
            "date": date, "open": _num(item[1]), "close": close, "high": _num(item[3]), "low": _num(item[4]),
            "volume": _num(item[5]), "amount": None, "amplitude": None,
            "pct_chg": round((close - prev_close) / prev_close * 100, 2) if prev_close else None,
            "change": round(close - prev_close, 2) if prev_close else None, "turnover": None,
        })
        prev_close = close
    if not out:
        raise DataSourceError(f"备用源无K线数据：{code}")
    return out[-limit:]


def fetch_kline(code: str, klt: int = 101, fqt: int = 1, limit: int = 800) -> list[dict]:
    """fqt: 0 不复权 / 1 前复权 / 2 后复权。主源抖动时自动切备用源。"""
    code = normalize_code(code)
    try:
        return _fetch_kline_eastmoney(code, klt, fqt, limit)
    except DataSourceError as primary_error:
        try:
            return fetch_kline_tencent(code, klt, fqt, limit)
        except DataSourceError as backup_error:
            raise DataSourceError(f"K线主备源均不可用：{primary_error}；{backup_error}") from backup_error


def fetch_stock_name(code: str) -> str | None:
    raw = _get("https://push2.eastmoney.com/api/qt/stock/get",
               {"secid": to_secid(code), "fltt": 2, "fields": "f57,f58"})
    return ((raw or {}).get("data") or {}).get("f58")


# ---------------------------------------------------------------- 财报指标

_FIN_KEYS = (
    "REPORT_DATE", "REPORT_DATE_NAME", "REPORT_TYPE", "EPSJB", "BPS", "MGJYXJJE",
    "TOTALOPERATEREVE", "TOTALOPERATEREVETZ", "PARENTNETPROFIT", "PARENTNETPROFITTZ",
    "KCFJCXSYJLR", "KCFJCXSYJLRTZ", "ROEJQ", "XSMLL", "XSJLL", "ZCFZL", "ZZCJLL",
    "TOTALOPERATEREVETZ", "NOTICE_DATE",
)


def fetch_financials(code: str, limit: int = 8) -> list[dict]:
    code = normalize_code(code)
    secucode = f"{code}.{'SH' if code[0] in '69' else 'SZ'}"
    raw = _get(
        "https://datacenter-web.eastmoney.com/api/data/v1/get",
        {
            "reportName": "RPT_F10_FINANCE_MAINFINADATA", "columns": "ALL",
            "filter": f'(SECUCODE="{secucode}")',
            "pageSize": limit, "sortColumns": "REPORT_DATE", "sortTypes": "-1",
            "source": "WEB", "client": "WEB",
        },
    )
    records = ((raw or {}).get("result") or {}).get("data") or []
    out = []
    for r in records:
        item = {k.lower(): r.get(k) for k in _FIN_KEYS}
        item["report_date"] = (r.get("REPORT_DATE") or "")[:10]
        out.append(item)
    return out


# ---------------------------------------------------------------- 估值历史（PE/PB 分位用）

def fetch_valuation_history(code: str, limit: int = 1300) -> list[dict]:
    code = normalize_code(code)
    raw = _get(
        "https://datacenter-web.eastmoney.com/api/data/v1/get",
        {
            "reportName": "RPT_VALUEANALYSIS_DET", "columns": "ALL",
            "filter": f'(SECURITY_CODE="{code}")',
            "pageSize": limit, "sortColumns": "TRADE_DATE", "sortTypes": "-1",
            "source": "WEB", "client": "WEB",
        },
    )
    records = ((raw or {}).get("result") or {}).get("data") or []
    out = []
    for r in records:
        out.append({
            "trade_date": (r.get("TRADE_DATE") or "")[:10],
            "pe_ttm": _num(r.get("PE_TTM")),
            "pb_mrq": _num(r.get("PB_MRQ")),
            "close": _num(r.get("CLOSE_PRICE")),
            "total_market_cap": _num(r.get("TOTAL_MARKET_CAP")),
            "total_shares": _num(r.get("TOTAL_SHARES")),
        })
    # 接口按日期倒序返回，这里统一为时间正序（最新在末尾），与 fetch_kline 口径一致
    out.reverse()
    return out[-limit:]


# ---------------------------------------------------------------- 板块与同业

def fetch_boards(code: str) -> list[dict]:
    raw = _get("https://push2.eastmoney.com/api/qt/slist/get",
               {"secid": to_secid(code), "fields": "f12,f13,f14", "pn": 1, "pz": 30, "po": 1, "np": 1, "spt": 3, "pi": 0, "dpt": "wzchanges"})
    diff = ((raw or {}).get("data") or {}).get("diff") or []
    return [{"code": b.get("f12"), "name": b.get("f14")} for b in diff if b.get("f12")]


def fetch_board_members(board_code: str, limit: int = 12) -> list[dict]:
    raw = _get(
        "https://push2.eastmoney.com/api/qt/clist/get",
        {
            "pn": 1, "pz": limit, "po": 1, "np": 1, "fltt": 2, "invt": 2, "fid": "f20",
            "fs": f"b:{board_code}", "fields": "f12,f14,f2,f3,f20,f9,f23,f115",
        },
    )
    diff = ((raw or {}).get("data") or {}).get("diff") or []
    return [{
        "code": m.get("f12"), "name": m.get("f14"),
        "price": _num(m.get("f2")), "pct_chg": _num(m.get("f3")),
        "market_cap": _num(m.get("f20")), "pe_dynamic": _num(m.get("f9")),
        "pb": _num(m.get("f23")), "pe_ttm": _num(m.get("f115")),
    } for m in diff]


def fetch_peers(code: str, limit: int = 12) -> dict:
    """同业取自该股所属细分板块（如航空运输），板块名一并返回供前端展示。"""
    code = normalize_code(code)
    boards = fetch_boards(code)
    # 细分行业板块优先：名称含「航空/机场」的板块比「交通运输」「上海板块」更有可比性
    board = next((b for b in boards if any(k in (b["name"] or "") for k in ("航空", "机场"))), None)
    if board is None and boards:
        board = boards[0]
    if board is None:
        return {"board": None, "members": [], "industry": None}
    members = fetch_board_members(board["code"], limit)
    for m in members:
        m["is_self"] = m["code"] == code
    return {"board": board, "members": members, "industry": board["name"]}


# ---------------------------------------------------------------- 搜索联想

_SEARCH_TOKEN = "D43BF722C8E33BDC906FB84D85E326E8"


def search_stocks(keyword: str, count: int = 8) -> list[dict]:
    raw = _get(
        "https://searchapi.eastmoney.com/api/suggest/get",
        {"input": keyword, "type": 14, "token": _SEARCH_TOKEN, "count": count},
    )
    data = ((raw or {}).get("QuotationCodeTable") or {}).get("Data") or []
    out = []
    for item in data:
        if item.get("Classify") not in ("AStock", "Index", "Bond", "Fund", "ForeignExchange"):
            continue
        out.append({"code": item.get("Code"), "name": item.get("Name"), "market": item.get("SecurityTypeName")})
    return out[:count]


# ---------------------------------------------------------------- 每日热门

_POPULARITY_URL = "https://emappdata.eastmoney.com/stockrank/getAllCurrentList"
_POPULARITY_PAYLOAD = {
    "appId": "appId01",
    "globalId": "786e4c21-70dc-435a-93bb-38",
    "marketType": "",
    "pageNo": 1,
}


def fetch_popularity_rank(limit: int = 10) -> list[dict]:
    """东方财富人气榜：按 App 内关注/访问热度排序，返回 [{code, rank}]。"""
    payload = dict(_POPULARITY_PAYLOAD, pageSize=max(limit, 10))
    raw = _post_json(_POPULARITY_URL, payload, referer="https://emappdata.eastmoney.com/")
    rows = (raw or {}).get("data") or []
    out = []
    for row in rows:
        sc = str(row.get("sc") or "").upper()
        if len(sc) < 8:
            continue
        out.append({"code": sc[2:], "rank": row.get("rk")})
    return out[:limit]


def fetch_quotes_batch(codes: list[str]) -> dict[str, dict]:
    """腾讯批量报价：一个请求取多只，首页热门榜只需要 1 次出网。"""
    if not codes:
        return {}
    symbols = ",".join(symbol_prefix(c) + c for c in codes)
    text = _get_text(f"https://qt.gtimg.cn/q={symbols}", referer="https://gu.qq.com/")
    out: dict[str, dict] = {}
    for line in text.split(";"):
        match = re.search(r'v_\w+="(.*)"', line)
        if not match:
            continue
        f = match.group(1).split("~")
        if len(f) < 47:
            continue
        code = f[2]
        amount_wan, market_cap_yi = _num(f[37]), _num(f[45])
        out[code] = {
            "code": code,
            "name": f[1],
            "price": _num(f[3]),
            "pct_chg": _num(f[32]),
            "change": _num(f[31]),
            "high": _num(f[33]),
            "low": _num(f[34]),
            "amount": None if amount_wan is None else round(amount_wan * 10000, 2),
            "turnover": _num(f[38]),
            "pe_dynamic": _num(f[39]),
            "pb": _num(f[46]),
            "market_cap": None if market_cap_yi is None else round(market_cap_yi * 1e8, 2),
        }
    return out


def _hot_from_amount_ranking(limit: int) -> list[dict]:
    """兜底：按成交额取全市场前 N（东财 clist，海外 IP 会被转到延时节点）。"""
    raw = _get(
        "https://push2.eastmoney.com/api/qt/clist/get",
        {
            "pn": 1, "pz": limit, "po": 1, "np": 1, "fltt": 2, "invt": 2, "fid": "f6",
            "fs": "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23",
            "fields": "f12,f14,f2,f3,f6,f8,f9,f20",
        },
    )
    rows = ((raw or {}).get("data") or {}).get("diff") or []
    items = []
    for index, row in enumerate(rows, start=1):
        items.append({
            "rank": index,
            "code": row.get("f12"),
            "name": row.get("f14"),
            "price": _num(row.get("f2")),
            "pct_chg": _num(row.get("f3")),
            "amount": _num(row.get("f6")),
            "turnover": _num(row.get("f8")),
            "pe_dynamic": _num(row.get("f9")),
            "market_cap": _num(row.get("f20")),
        })
    return items


def fetch_hot_stocks(limit: int = 10) -> dict:
    """每日热门榜：人气榜优先，失败时退回成交额榜。

    返回里带 source 说明口径，前端据此决定标题文案。
    """
    try:
        ranked = fetch_popularity_rank(limit)
        if ranked:
            quotes = fetch_quotes_batch([r["code"] for r in ranked])
            items = []
            for row in ranked:
                quote = quotes.get(row["code"]) or {}
                items.append({
                    "rank": row.get("rank"),
                    "code": row["code"],
                    "name": quote.get("name"),
                    "price": quote.get("price"),
                    "pct_chg": quote.get("pct_chg"),
                    "change": quote.get("change"),
                    "amount": quote.get("amount"),
                    "turnover": quote.get("turnover"),
                    "pe_dynamic": quote.get("pe_dynamic"),
                    "pb": quote.get("pb"),
                    "market_cap": quote.get("market_cap"),
                })
            if any(item.get("name") for item in items):
                return {"source": "popularity", "items": items}
    except DataSourceError:
        pass

    items = _hot_from_amount_ranking(limit)
    if not items:
        raise DataSourceError("热门榜数据不可用")
    return {"source": "amount", "items": items}


# ---------------------------------------------------------------- 大盘

MARKET_INDICES = [
    ("sh000001", "上证指数"),
    ("sz399001", "深证成指"),
    ("sz399006", "创业板指"),
    ("sh000300", "沪深300"),
    ("sh000905", "中证500"),
    ("sh000688", "科创50"),
]


def fetch_market_indices() -> list[dict]:
    """主要指数实时行情：腾讯一次批量取完。"""
    symbols = ",".join(sym for sym, _ in MARKET_INDICES)
    text = _get_text(f"https://qt.gtimg.cn/q={symbols}", referer="https://gu.qq.com/")
    parsed: dict[str, dict] = {}
    for line in text.split(";"):
        match = re.search(r'v_(\w+)="(.*)"', line)
        if not match:
            continue
        f = match.group(2).split("~")
        if len(f) < 40:
            continue
        amount_wan = _num(f[37])
        parsed[match.group(1)] = {
            "price": _num(f[3]),
            "change": _num(f[31]),
            "pct_chg": _num(f[32]),
            "high": _num(f[33]),
            "low": _num(f[34]),
            "volume": _num(f[36]),
            "amount": None if amount_wan is None else round(amount_wan * 10000, 2),
        }
    out = []
    for symbol, fallback_name in MARKET_INDICES:
        item = {"symbol": symbol, "name": parsed.get(symbol, {}).get("name") or fallback_name}
        item.update(parsed.get(symbol) or {})
        out.append(item)
    if not any(item.get("price") for item in out):
        raise DataSourceError("指数行情不可用")
    return out


def fetch_index_kline(symbol: str = "sh000001", limit: int = 400) -> list[dict]:
    """指数日线：腾讯的 day 数据（指数不做复权）。"""
    raw = _get(
        "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get",
        {"param": f"{symbol},day,,,{min(limit, 640)},"},
    )
    node = ((raw or {}).get("data") or {}).get(symbol) or {}
    rows = node.get("day") or []
    out = []
    for row in rows:
        if len(row) < 6:
            continue
        out.append({
            "date": row[0], "open": _num(row[1]), "close": _num(row[2]),
            "high": _num(row[3]), "low": _num(row[4]), "volume": _num(row[5]),
        })
    if not out:
        raise DataSourceError(f"指数日线为空：{symbol}")
    return out


def _limit_pool_count(kind: str, date_str: str) -> int:
    """涨停/跌停家数：东财涨停池、跌停池接口返回的 tc 字段。"""
    url = ("https://push2ex.eastmoney.com/getTopicZTPool" if kind == "up"
           else "https://push2ex.eastmoney.com/getTopicDTPool")
    raw = _get(url, {
        "ut": "7eea3edcaed734bea9cbfc24409ed989", "dpt": "wz.ztzt", "Pageindex": 0,
        "pagesize": 1, "sort": "fbt:asc" if kind == "up" else "fund:asc", "date": date_str,
    }, referer="https://quote.eastmoney.com/")
    return int(((raw or {}).get("data") or {}).get("tc") or 0)


def fetch_market_overview() -> dict:
    indices = fetch_market_indices()
    kline = fetch_index_kline("sh000001", 400)
    today = datetime.now().strftime("%Y%m%d")
    limit_up = limit_down = None
    try:
        limit_up = _limit_pool_count("up", today)
        limit_down = _limit_pool_count("down", today)
    except DataSourceError:
        pass
    return {
        "indices": indices,
        "sh_kline": kline,
        "limit_up": limit_up,
        "limit_down": limit_down,
        "trade_date": kline[-1]["date"],
    }
