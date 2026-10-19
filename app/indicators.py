"""技术指标计算：纯 Python 实现，序列与 K 线日期一一对应，不足周期处为 None。"""
from __future__ import annotations


def sma(values: list[float], period: int) -> list[float | None]:
    out: list[float | None] = [None] * len(values)
    total = 0.0
    for i, v in enumerate(values):
        total += v
        if i >= period:
            total -= values[i - period]
        if i >= period - 1:
            out[i] = round(total / period, 4)
    return out


def ema(values: list[float], period: int) -> list[float]:
    k = 2 / (period + 1)
    out: list[float] = []
    prev: float | None = None
    for v in values:
        prev = v if prev is None else v * k + prev * (1 - k)
        out.append(prev)
    return out


def macd(closes: list[float], fast: int = 12, slow: int = 26, signal: int = 9) -> dict:
    fast_ema, slow_ema = ema(closes, fast), ema(closes, slow)
    dif = [round(a - b, 4) for a, b in zip(fast_ema, slow_ema)]
    dea = [round(v, 4) for v in ema(dif, signal)]
    hist = [round((a - b) * 2, 4) for a, b in zip(dif, dea)]
    return {"dif": dif, "dea": dea, "hist": hist}


def rsi(closes: list[float], period: int = 14) -> list[float | None]:
    out: list[float | None] = [None] * len(closes)
    if len(closes) <= period:
        return out
    gains = losses = 0.0
    for i in range(1, period + 1):
        delta = closes[i] - closes[i - 1]
        gains += max(delta, 0.0)
        losses += max(-delta, 0.0)
    avg_gain, avg_loss = gains / period, losses / period
    out[period] = 100.0 if avg_loss == 0 else round(100 - 100 / (1 + avg_gain / avg_loss), 2)
    for i in range(period + 1, len(closes)):
        delta = closes[i] - closes[i - 1]
        avg_gain = (avg_gain * (period - 1) + max(delta, 0.0)) / period
        avg_loss = (avg_loss * (period - 1) + max(-delta, 0.0)) / period
        out[i] = 100.0 if avg_loss == 0 else round(100 - 100 / (1 + avg_gain / avg_loss), 2)
    return out


def kdj(highs: list[float], lows: list[float], closes: list[float], n: int = 9) -> dict:
    k_list: list[float | None] = [None] * len(closes)
    d_list: list[float | None] = [None] * len(closes)
    j_list: list[float | None] = [None] * len(closes)
    k = d = 50.0
    for i in range(len(closes)):
        if i < n - 1:
            continue
        window_high = max(highs[i - n + 1: i + 1])
        window_low = min(lows[i - n + 1: i + 1])
        rsv = 50.0 if window_high == window_low else (closes[i] - window_low) / (window_high - window_low) * 100
        k = (2 * k + rsv) / 3
        d = (2 * d + k) / 3
        k_list[i], d_list[i], j_list[i] = round(k, 2), round(d, 2), round(3 * k - 2 * d, 2)
    return {"k": k_list, "d": d_list, "j": j_list}


def boll(closes: list[float], period: int = 20, width: float = 2.0) -> dict:
    mid = sma(closes, period)
    upper: list[float | None] = [None] * len(closes)
    lower: list[float | None] = [None] * len(closes)
    for i in range(period - 1, len(closes)):
        window = closes[i - period + 1: i + 1]
        mean = mid[i]
        variance = sum((x - mean) ** 2 for x in window) / period
        std = variance ** 0.5
        upper[i] = round(mean + width * std, 4)
        lower[i] = round(mean - width * std, 4)
    return {"mid": mid, "upper": upper, "lower": lower}


def atr(highs: list[float], lows: list[float], closes: list[float], period: int = 14) -> list[float | None]:
    trs: list[float] = []
    for i in range(len(closes)):
        if i == 0:
            trs.append(highs[i] - lows[i])
        else:
            trs.append(max(highs[i] - lows[i], abs(highs[i] - closes[i - 1]), abs(lows[i] - closes[i - 1])))
    return [None if v is None else round(v, 4) for v in sma(trs, period)]


def series(closes: list[float], highs: list[float], lows: list[float],
           volumes: list[float] | None = None) -> dict:
    """一次性算出看板需要的全部指标序列。"""
    result: dict = {f"ma{p}": sma(closes, p) for p in (5, 10, 20, 60, 120, 250)}
    result["macd"] = macd(closes)
    result["rsi14"] = rsi(closes, 14)
    result["kdj"] = kdj(highs, lows, closes)
    result["boll"] = boll(closes)
    result["atr14"] = atr(highs, lows, closes)
    if volumes:
        result["vol_ma5"] = sma(volumes, 5)
        result["vol_ma20"] = sma(volumes, 20)
    return result


def range_position(closes: list[float], window: int = 250) -> dict:
    """区间位置：现价在过去 window 个交易日的高低区间中所处百分位。"""
    if not closes:
        return {"high": None, "low": None, "pct": None}
    window_values = closes[-window:]
    high, low = max(window_values), min(window_values)
    latest = closes[-1]
    pct = None if high == low else round((latest - low) / (high - low) * 100, 1)
    return {"high": round(high, 2), "low": round(low, 2), "pct": pct, "latest": round(latest, 2)}


def percentile_of(series_values: list[float], current: float) -> float | None:
    """当前值在历史序列中的分位（0 表示历史最低，100 表示最高）。"""
    clean = [v for v in series_values if v is not None]
    if not clean or current is None:
        return None
    below = sum(1 for v in clean if v <= current)
    return round(below / len(clean) * 100, 1)


def median(values: list[float]) -> float | None:
    clean = sorted(v for v in values if v is not None)
    if not clean:
        return None
    mid = len(clean) // 2
    return round(clean[mid] if len(clean) % 2 else (clean[mid - 1] + clean[mid]) / 2, 2)
