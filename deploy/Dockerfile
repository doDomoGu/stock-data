FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/ \
    STOCK_TOOL_DATA=/srv/data

WORKDIR /srv/stock-data

COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY app ./app
COPY web ./web
COPY scripts ./scripts

VOLUME ["/srv/data"]
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=3)"

# SQLite 是单文件存储，保持单 worker 即可满足单机多用户读取
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
