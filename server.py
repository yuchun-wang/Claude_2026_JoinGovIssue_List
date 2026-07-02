#!/usr/bin/env python3
"""
本機小型伺服器：
1. 提供 index.html / data.js 等靜態檔案
2. 提供 /api/refresh，伺服器端向 join.gov.tw 重新查詢最新資料，
   避開瀏覽器端直接呼叫會被 CORS 擋下的問題。

用法： python3 server.py [port]
啟動後開啟 http://localhost:8787

部署到 Render 等平台時，會改用平台注入的 PORT 環境變數，並監聽 0.0.0.0。
"""

import json
import os
import sys
import time
import threading
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT") or (sys.argv[1] if len(sys.argv) > 1 else 8787))
HOST = "0.0.0.0"

# 與整理 data.js 時使用的關鍵字一致，用來向 join.gov.tw 撈取最新狀態
KEYWORDS = [
    "女性", "性別平等", "婦女", "生理假", "生理用品", "性別歧視", "職場性別",
    "性騷擾", "育嬰假", "托育", "家暴", "家庭暴力", "單親媽媽", "產假", "陪產假",
    "女權", "月經", "墮胎", "人工流產", "哺乳室", "女力", "性別友善", "跨性別",
    "女童", "懷孕歧視", "乳房", "子宮頸", "代理孕母", "不孕",
]

SEARCH_URL = "https://join.gov.tw/idea/term/v2/search/"
CACHE_TTL_SECONDS = 6 * 60 * 60      # 一般情況下 6 小時內重用快取，避免頻繁打擾來源網站
FORCE_MIN_INTERVAL_SECONDS = 60      # 就算按「強制重新檢查」，最短也要間隔 60 秒

_cache_lock = threading.Lock()
_cache = {"data": None, "fetchedAt": 0}
_last_force_at = 0


def _fetch_keyword(kw):
    url = SEARCH_URL + urllib.parse.quote(kw)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        payload = json.load(resp)
    return payload.get("result", [])


def fetch_live_data():
    """向 join.gov.tw 依關鍵字平行查詢，合併成 {id: {title, status, endorseCount, attentionCount}}
    平行處理是為了把原本依序查詢約 20 秒的耗時壓到幾秒內，避免部署平台的請求逾時限制。"""
    items = {}
    errors = []
    with ThreadPoolExecutor(max_workers=10) as pool:
        future_to_kw = {pool.submit(_fetch_keyword, kw): kw for kw in KEYWORDS}
        for future in as_completed(future_to_kw):
            kw = future_to_kw[future]
            try:
                for it in future.result():
                    items[it["id"]] = {
                        "id": it["id"],
                        "title": it.get("title", ""),
                        "status": it.get("status", ""),
                        "endorseCount": it.get("endorseCount", 0),
                        "attentionCount": it.get("attentionCount", 0),
                        "publishDate": it.get("publishDate"),
                    }
            except Exception as e:
                errors.append(f"{kw}: {e}")
    return items, errors


def get_cached_or_fetch(force=False):
    global _last_force_at
    now = time.time()
    with _cache_lock:
        age = now - _cache["fetchedAt"]
        if force:
            if now - _last_force_at < FORCE_MIN_INTERVAL_SECONDS:
                force = False  # 太頻繁的強制重整，降級成一般快取邏輯
            else:
                _last_force_at = now

        if not force and _cache["data"] is not None and age < CACHE_TTL_SECONDS:
            return _cache["data"], age, True

    items, errors = fetch_live_data()
    result = {
        "checkedAt": time.strftime("%Y-%m-%dT%H:%M:%S+08:00", time.localtime()),
        "items": items,
        "errors": errors,
    }
    with _cache_lock:
        if items:  # 只有真的抓到資料才覆蓋快取，避免暫時性錯誤把快取洗掉
            _cache["data"] = result
            _cache["fetchedAt"] = time.time()
    return result, 0, False


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path == "/api/refresh":
            qs = urllib.parse.parse_qs(parsed.query)
            force = qs.get("force", ["0"])[0] == "1"
            try:
                data, cache_age, from_cache = get_cached_or_fetch(force=force)
            except Exception as e:
                self._send_json({"error": str(e)}, status=500)
                return
            data = dict(data)
            data["fromCache"] = from_cache
            data["cacheAgeSeconds"] = int(cache_age)
            self._send_json(data)
            return

        # 其餘一律當靜態檔案處理（index.html, data.js ...）
        return self._serve_static()

    def _serve_static(self):
        path = self.path.split("?", 1)[0]
        if path == "/":
            path = "/index.html"
        local_path = "." + urllib.parse.unquote(path)
        try:
            with open(local_path, "rb") as f:
                body = f.read()
        except (FileNotFoundError, IsADirectoryError):
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"Not found")
            return

        content_type = "application/octet-stream"
        if local_path.endswith(".html"):
            content_type = "text/html; charset=utf-8"
        elif local_path.endswith(".js"):
            content_type = "application/javascript; charset=utf-8"
        elif local_path.endswith(".css"):
            content_type = "text/css; charset=utf-8"

        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass  # 安靜一點，不要洗終端機


if __name__ == "__main__":
    print(f"伺服器啟動：http://localhost:{PORT}  (Ctrl+C 結束)")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
