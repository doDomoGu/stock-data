"""运行时配置：路径、缓存时长、数据源参数。"""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.getenv("STOCK_TOOL_DATA", str(BASE_DIR / "data")))
DATA_DIR.mkdir(parents=True, exist_ok=True)

DB_PATH = DATA_DIR / "market.db"
WEB_DIR = BASE_DIR / "web"

# 部署到公网时设置访问口令；留空表示不校验。
ACCESS_TOKEN = os.getenv("STOCK_TOOL_TOKEN", "").strip()

HTTP_TIMEOUT = float(os.getenv("STOCK_TOOL_TIMEOUT", "12"))
HTTP_RETRY = 3
HTTP_BACKOFF = float(os.getenv("STOCK_TOOL_BACKOFF", "0.8"))  # 重试间隔基数（秒）
# 公开接口没有配额说明，留出间隔降低被限流的概率。
REQUEST_INTERVAL = float(os.getenv("STOCK_TOOL_INTERVAL", "0.35"))

TTL_QUOTE = 60            # 行情快照：盘中一分钟一次足够
TTL_KLINE = 30 * 60       # 日线序列
TTL_FINANCIAL = 6 * 3600  # 财报指标
TTL_VALUATION = 12 * 3600 # 估值历史
TTL_PEERS = 10 * 60       # 同业对比
TTL_BOARDS = 24 * 3600    # 板块归属

DEFAULT_CODE = "601021"
MAX_KLINE = 1500
