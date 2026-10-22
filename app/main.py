"""HTTP 接口层：对外提供行情/财务/同业/分析数据，并托管移动端页面。"""
from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone

from fastapi import BackgroundTasks, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import analysis, config, datasource, indicators, store
from .datasource import DataSourceError

CN_TZ = timezone(timedelta(hours=8))

app = FastAPI(title="股票分析看板", docs_url="/api/docs", openapi_url="/api/openapi.json")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "POST", "DELETE"], allow_headers=["*"])


@app.on_event("startup")
def _startup() -> None:
    store.init_db()


@app.middleware("http")
async def _token_guard(request: Request, call_next):
    if config.ACCESS_TOKEN and request.url.path.startswith("/api/"):
        supplied = (request.query_params.get("token")
                    or request.headers.get("x-access-token")
                    or request.cookies.get("stock_token"))
        if supplied != config.ACCESS_TOKEN:
            return JSONResponse({"ok": False, "error": "未授权：缺少或错误的口令"}, status_code=401)
    return await call_next(request)


@app.middleware("http")
async def _no_cache_frontend(request: Request, call_next):
    """前端文件每次都校验：改了样式或脚本后刷新即可生效，不会卡在旧缓存上。

    /vendor/ 下是带版本号的第三方库，交给 Nginx 长缓存，这里不动。
    """
    response = await call_next(request)
    path = request.url.path
    if not path.startswith("/vendor/") and (path == "/" or path.endswith((".html", ".css", ".js"))):
        response.headers["Cache-Control"] = "no-cache"
    return response


def _ok(data, **extra):
    return {"ok": True, "data": data, "server_time": datetime.now(CN_TZ).strftime("%Y-%m-%d %H:%M:%S"), **extra}


def _today() -> str:
    return datetime.now(CN_TZ).strftime("%Y-%m-%d")


# ---------------------------------------------------------------- 缓存友好的取数

FILLABLE_QUOTE_FIELDS = ("change", "open", "high", "low", "prev_close", "volume", "amount",
                         "volume_ratio", "turnover", "amplitude", "market_cap", "float_market_cap",
                         "pe_dynamic", "pb")


def _fill_missing_quote(code: str, data: dict) -> dict:
    """备用源字段少，用最近一次完整报价和估值历史把空缺补齐，并标记为补充数据。"""
    filled = False
    if any(data.get(f) is None for f in FILLABLE_QUOTE_FIELDS):
        previous = store.cache_get(f"quote:{code}", -1)
        if previous:
            for field in FILLABLE_QUOTE_FIELDS:
                if data.get(field) is None and previous.get(field) is not None:
                    data[field] = previous[field]
                    filled = True
    if data.get("market_cap") is None:
        valuation = store.latest_valuation(code)
        if valuation and valuation.get("total_market_cap"):
            data["market_cap"] = valuation["total_market_cap"]
            data["float_market_cap"] = data.get("float_market_cap") or valuation["total_market_cap"]
            filled = True
        if valuation and valuation.get("pe_ttm") and data.get("pe_dynamic") is None:
            data["pe_dynamic"] = round(valuation["pe_ttm"], 2)
            filled = True
    if filled:
        data["fields_filled"] = True
    return data


def get_quote(code: str, force: bool = False) -> dict:
    key = f"quote:{code}"
    cached = None if force else store.cache_get(key, config.TTL_QUOTE)
    if cached:
        return cached
    try:
        data = _fill_missing_quote(code, datasource.fetch_quote(code))
    except DataSourceError:
        # 主备源都不可用时，宁可展示上一次的报价也不要空屏
        stale = store.cache_get(key, -1)
        if stale:
            stale = dict(stale)
            stale["stale"] = True
            return stale
        raise
    store.cache_set(key, data)
    return data


def get_kline(code: str, klt: int, fqt: int, limit: int, force: bool = False) -> tuple[list[dict], bool]:
    """返回 (K线, 是否来自缓存)。force=True 时忽略同步 TTL，立即回源。"""
    sync_key = f"kline_sync:{code}:{klt}:{fqt}"
    need_sync = force or store.cache_get(sync_key, config.TTL_KLINE) is None
    rows = store.load_kline(code, klt, fqt, limit)
    if need_sync or not rows:
        try:
            fresh = datasource.fetch_kline(code, klt=klt, fqt=fqt, limit=config.MAX_KLINE)
        except DataSourceError:
            if rows:
                return rows, True
            raise
        store.save_kline(code, klt, fqt, fresh)
        store.cache_set(sync_key, True)
        rows = store.load_kline(code, klt, fqt, limit)
        return rows, False
    return rows, True


def get_financials(code: str, limit: int = 8) -> tuple[list[dict], bool]:
    updated = store.financials_updated_at(code)
    cached = store.load_financials(code, limit)
    if cached and updated and time.time() - updated < config.TTL_FINANCIAL:
        return cached, True
    try:
        fresh = datasource.fetch_financials(code, limit=max(limit, 8))
    except DataSourceError:
        if cached:
            return cached, True
        raise
    store.save_financials(code, fresh)
    return store.load_financials(code, limit), False


def get_valuation(code: str) -> tuple[list[dict], bool]:
    key = f"valuation_sync:{code}"
    cached = store.load_valuation(code)
    if cached and store.cache_get(key, config.TTL_VALUATION):
        return cached, True
    try:
        fresh = datasource.fetch_valuation_history(code)
    except DataSourceError:
        if cached:
            return cached, True
        raise
    store.save_valuation(code, fresh)
    store.cache_set(key, True)
    return store.load_valuation(code), False


def get_peers(code: str, force: bool = False) -> dict:
    key = f"peers:{code}"
    cached = None if force else store.cache_get(key, config.TTL_PEERS)
    if cached:
        return cached
    try:
        data = datasource.fetch_peers(code)
    except DataSourceError:
        stale = store.cache_get(key, -1)
        if stale:
            return stale
        raise
    store.cache_set(key, data)
    return data


# ---------------------------------------------------------------- 接口

@app.get("/api/health")
def health():
    return _ok({"status": "ok", "store": store.stats(), "today": _today(), "token_required": bool(config.ACCESS_TOKEN)})


@app.get("/api/search")
def search(q: str = Query(..., min_length=1), count: int = 8):
    try:
        return _ok(datasource.search_stocks(q, count=max(1, min(count, 20))))
    except DataSourceError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/api/stock/{code}/quote")
def quote(code: str, refresh: int = 0):
    try:
        norm = datasource.normalize_code(code)
        return _ok(get_quote(norm, force=bool(refresh)))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except DataSourceError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/api/stock/{code}/kline")
def kline(code: str, period: str = "day", adjust: int = 1,
          limit: int = Query(520, ge=30, le=config.MAX_KLINE), refresh: int = 0):
    if period not in datasource.KLT:
        raise HTTPException(status_code=400, detail=f"period 仅支持 {list(datasource.KLT)}")
    if adjust not in (0, 1, 2):
        raise HTTPException(status_code=400, detail="adjust 仅支持 0(不复权)/1(前复权)/2(后复权)")
    try:
        code = datasource.normalize_code(code)
        rows, from_cache = get_kline(code, datasource.KLT[period], adjust, limit, force=bool(refresh))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except DataSourceError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    closes = [r["close"] for r in rows]
    highs = [r["high"] for r in rows]
    lows = [r["low"] for r in rows]
    volumes = [r["volume"] or 0 for r in rows]
    return _ok({"code": code, "period": period, "adjust": adjust, "rows": rows,
                "indicators": indicators.series(closes, highs, lows, volumes),
                "cached": from_cache})


@app.get("/api/stock/{code}/financials")
def financials(code: str, limit: int = Query(8, ge=1, le=12)):
    try:
        code = datasource.normalize_code(code)
        rows, cached = get_financials(code, limit)
        return _ok({"code": code, "records": rows, "cached": cached})
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except DataSourceError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/api/stock/{code}/peers")
def peers(code: str, refresh: int = 0):
    try:
        code = datasource.normalize_code(code)
        return _ok(get_peers(code, force=bool(refresh)))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except DataSourceError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


def _collect(code: str, period: str, adjust: int, limit: int, force: bool = False) -> tuple[dict, list[str]]:
    """按依赖顺序取数；单个数据源失败就降级，不拖垮整页。

    force=True 用于手动刷新：行情、K 线、同业立即回源，不看缓存 TTL。
    财报与估值历史变化慢（6~12 小时）、体积也大，仍按原 TTL 走。
    """
    quote_data: dict = {}
    rows: list[dict] = []
    fin_rows: list[dict] = []
    valuation_rows: list[dict] = []
    peer_data: dict = {"board": None, "members": [], "industry": None}
    degraded: list[str] = []

    steps = [
        ("行情", lambda: get_quote(code, force=force), "quote"),
        ("K线", lambda: get_kline(code, datasource.KLT[period], adjust, limit, force=force), "rows"),
        ("财报", lambda: get_financials(code, 8), "financials"),
        ("估值", lambda: get_valuation(code), "valuation"),
        ("同业", lambda: get_peers(code, force=force), "peers"),
    ]
    for label, fn, target in steps:
        try:
            value = fn()
        except DataSourceError as exc:
            degraded.append(f"{label}: {exc}")
            continue
        if target == "quote":
            quote_data = value
        elif target == "rows":
            rows = value[0]
        elif target == "financials":
            fin_rows = value[0]
        elif target == "valuation":
            valuation_rows = value[0]
        else:
            peer_data = value
    return {
        "quote": quote_data, "rows": rows, "financials": fin_rows,
        "valuation": valuation_rows, "peers": peer_data, "degraded": degraded,
    }, degraded


@app.get("/api/stock/{code}/analysis")
def analyze(code: str, period: str = "day", adjust: int = 1,
            limit: int = Query(520, ge=60, le=config.MAX_KLINE), refresh: int = 0):
    if period not in datasource.KLT:
        raise HTTPException(status_code=400, detail=f"period 仅支持 {list(datasource.KLT)}")
    try:
        code = datasource.normalize_code(code)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    bundle, degraded = _collect(code, period, adjust, limit, force=bool(refresh))
    if not bundle["quote"] and not bundle["rows"]:
        raise HTTPException(status_code=503, detail="；".join(degraded) or "数据源不可用")
    result = analysis.build(code, bundle["quote"].get("name"), bundle["quote"], bundle["rows"],
                            bundle["financials"], bundle["valuation"], bundle["peers"])
    result["degraded"] = degraded
    return _ok(result)


@app.get("/api/stock/{code}/overview")
def overview(code: str, refresh: int = 0):
    """首页一次性拿齐：行情 + 分析结论，减少移动端请求数。refresh=1 时行情/K线/同业立即回源。"""
    try:
        code = datasource.normalize_code(code)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    bundle, degraded = _collect(code, "day", 1, 750, force=bool(refresh))
    if not bundle["quote"] and not bundle["rows"]:
        raise HTTPException(status_code=503, detail="；".join(degraded) or "数据源不可用")
    result = analysis.build(code, bundle["quote"].get("name"), bundle["quote"], bundle["rows"],
                            bundle["financials"], bundle["valuation"], bundle["peers"])
    result["degraded"] = degraded
    return _ok({"quote": bundle["quote"], "analysis": result, "degraded": degraded,
                "is_favorite": store.is_favorite(code), "forced": bool(refresh)})


# ---------------------------------------------------------------- 自选股

class FavoriteIn(BaseModel):
    code: str


def _cached_analysis(code: str) -> dict | None:
    """只读本地缓存算推荐指数：首页列表不能为 N 只股票各打一遍上游接口。"""
    rows = store.load_kline(code, 101, 1, 750)
    if len(rows) < 300:
        return None
    quote = store.cache_get(f"quote:{code}", -1) or {}
    fin = store.load_financials(code, 8)
    valuation = store.load_valuation(code)
    peers = store.cache_get(f"peers:{code}", -1) or {"board": None, "members": [], "industry": None}
    return analysis.build(code, quote.get("name"), quote, rows, fin, valuation, peers)


@app.get("/api/market")
def market_overview(refresh: int = 0):
    """A 股大盘：主要指数行情 + 上证趋势/量能/涨跌停宽度，缓存 5 分钟。"""
    key = "market:overview"
    ttl = 5 * 60
    if not refresh:
        cached = store.cache_get(key, ttl)
        if cached:
            return _ok(cached)
    try:
        data = datasource.fetch_market_overview()
    except DataSourceError as exc:
        stale = store.cache_get(key, -1)
        if stale:
            stale = dict(stale)
            stale["stale"] = True
            return _ok(stale)
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    payload = {
        "indices": data["indices"],
        "limit_up": data["limit_up"],
        "limit_down": data["limit_down"],
        "trade_date": data["trade_date"],
        "analysis": analysis.market_module(data["sh_kline"], data["limit_up"], data["limit_down"]),
    }
    store.cache_set(key, payload)
    return _ok(payload)


@app.get("/api/hot")
def hot_stocks(limit: int = Query(10, ge=5, le=20), refresh: int = 0):
    """每日热门榜：东财人气榜 + 腾讯批量报价，10 分钟内走缓存。"""
    key = f"hot:{limit}"

    def annotate(data: dict) -> dict:
        # 收藏状态实时算，不受榜单缓存影响
        for item in data.get("items", []):
            item["is_favorite"] = store.is_favorite(item.get("code") or "")
        data["server_time"] = datetime.now(CN_TZ).strftime("%Y-%m-%d %H:%M:%S")
        return data

    if not refresh:
        cached = store.cache_get(key, config.TTL_HOT)
        if cached:
            return _ok(annotate(cached))
    try:
        data = datasource.fetch_hot_stocks(limit)
    except DataSourceError as exc:
        stale = store.cache_get(key, -1)
        if stale:
            stale = dict(stale)
            stale["stale"] = True
            return _ok(annotate(stale))
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    store.cache_set(key, data)
    return _ok(annotate(data))


@app.get("/api/favorites")
def list_favorites(refresh: int = 0):
    items = []
    for fav in store.list_favorites():
        code = fav["code"]
        try:
            quote = get_quote(code, force=bool(refresh))
        except DataSourceError:
            quote = store.cache_get(f"quote:{code}", -1) or {}
        store.update_favorite_name(code, quote.get("name"))
        cached = _cached_analysis(code)
        rec = (cached or {}).get("recommendation") or {}
        position = (cached or {}).get("position") or {}
        items.append({
            "code": code,
            "name": quote.get("name") or fav.get("name"),
            "price": quote.get("price"),
            "change": quote.get("change"),
            "pct_chg": quote.get("pct_chg"),
            "pe_dynamic": quote.get("pe_dynamic"),
            "pb": quote.get("pb"),
            "market_cap": quote.get("market_cap"),
            "index": rec.get("index"),
            "rating": rec.get("rating"),
            "rating_level": rec.get("rating_level"),
            "bias": position.get("bias"),
            "bias_percentile": position.get("bias_percentile"),
            "quote_source": quote.get("source"),
            "scored": bool(cached),
        })
    return _ok({"items": items, "count": len(items)})


def _warm_stock(code: str) -> None:
    """加自选后后台补齐数据，让列表里的推荐指数在下次打开时就能显示。"""
    try:
        get_kline(code, 101, 1, 750)
        get_financials(code, 8)
        get_valuation(code)
        get_peers(code)
    except DataSourceError:
        pass


@app.post("/api/favorites")
def add_favorite(payload: FavoriteIn, background: BackgroundTasks):
    try:
        code = datasource.normalize_code(payload.code)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    name = None
    try:
        name = datasource.fetch_quote(code).get("name")
    except DataSourceError:
        name = store.cache_get(f"quote:{code}", -1) or None
        name = name.get("name") if isinstance(name, dict) else None
    store.add_favorite(code, name)
    background.add_task(_warm_stock, code)
    return _ok({"code": code, "name": name})


@app.delete("/api/favorites/{code}")
def delete_favorite(code: str):
    try:
        code = datasource.normalize_code(code)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not store.remove_favorite(code):
        raise HTTPException(status_code=404, detail="该股票不在自选列表中")
    return _ok({"code": code, "removed": True})


app.mount("/", StaticFiles(directory=str(config.WEB_DIR), html=True), name="web")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=False)
