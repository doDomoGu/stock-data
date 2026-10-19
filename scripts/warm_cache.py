"""预热缓存：收盘后定时跑一次，让手机端打开即是数据。

用法：
    .venv/bin/python scripts/warm_cache.py 601021 600029 601111
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config, datasource, store  # noqa: E402
from app.main import get_financials, get_kline, get_peers, get_quote, get_valuation  # noqa: E402

DEFAULT_CODES = [config.DEFAULT_CODE, "601111", "600029", "600115", "603885"]


def warm(code: str) -> None:
    started = time.time()
    quote = get_quote(code)
    get_kline(code, datasource.KLT["day"], 1, 750)
    get_kline(code, datasource.KLT["week"], 1, 520)
    get_financials(code, 8)
    get_valuation(code)
    get_peers(code)
    print(f"[ok] {code} {quote.get('name')} 现价 {quote.get('price')} 用时 {time.time() - started:.1f}s")


def main(codes: list[str]) -> int:
    store.init_db()
    failed = 0
    for code in codes:
        try:
            warm(datasource.normalize_code(code))
        except Exception as exc:  # 单个标的失败不影响其余标的
            failed += 1
            print(f"[fail] {code}: {exc}")
    print("存储统计:", store.stats())
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:] or DEFAULT_CODES))
