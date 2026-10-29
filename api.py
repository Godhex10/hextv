import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sys
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Dict, List, Optional
from urllib.parse import urlsplit

import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask

try:
    from curl_cffi import requests as cr
except ImportError:
    cr = None
    import httpx

if sys.stdout and hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
if sys.stderr and hasattr(sys.stderr, "reconfigure"):
    try:
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

def _load_dotenv(path: str) -> None:
    """Read KEY=value lines from a .env file without overriding real environment variables."""
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip().strip("\"'"))
    except FileNotFoundError:
        pass

_load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

app = FastAPI(
    title="MovieBox 1080p API",
    description="REST API for MovieBox with 1080p Stream & Subtitle Extraction",
    version="2.5.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

class UnhandledErrorsAsJSON:
    """Turn unhandled exceptions into a JSON 502 the browser can read.

    Starlette's default 500 is produced outside the CORS middleware, so browsers block it and the
    frontend only sees "Failed to fetch". Plain ASGI (not BaseHTTPMiddleware) so /proxy streaming
    is passed through untouched.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        started = False

        async def send_tracking(message):
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, receive, send_tracking)
        except Exception as e:
            if started:
                raise
            traceback.print_exc()
            response = JSONResponse(
                {"detail": f"Upstream error: {type(e).__name__}: {e}"},
                status_code=502,
                headers={"Access-Control-Allow-Origin": "*"},
            )
            await response(scope, receive, send)

app.add_middleware(UnhandledErrorsAsJSON)

SECRET_KEY_DEFAULT_B64 = "NzZpUmwwN3MweFNOOWpxbUVXQXQ3OUVCSlp1bElRSXNWNjRGWnIyTw=="
SECRET_KEY_ALT_B64 = "WHFuMm5uTzQxL0w5Mm8xaXVYaFNMSFRiWHZZNFo1Wlo2Mm04bVNMQQ=="
MODERN_USER_AGENT = "com.community.mbox.in/50020130 (Linux; U; Android 14; en_IN; Pixel 8; Build/UD1A.230803.041; Cronet/145.0.7582.0)"
WEB_USER_AGENT = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36"
API_BASE = "https://h5-api.aoneroom.com/wefeed-h5api-bff"
NATIVE_API_BASE = "https://api3.aoneroom.com"
BOOTSTRAP_HOST = "https://apig.inmoviebox.com"
BOOTSTRAP_URL = f"{BOOTSTRAP_HOST}/wefeed-mobile-bff/tab/ranking-list?tabId=0&categoryType=4516404531735022304&page=1&perPage=1"

MIN_STREAM_SEC = 60  # anything shorter is a placeholder/ad clip, not the title
STREAM_POOL = ThreadPoolExecutor(max_workers=16, thread_name_prefix="streams")
STREAM_CACHE_TTL = 300  # seconds; stream URLs are signed, so keep this short

def _has_mp4(streams: List[Dict[str, Any]]) -> bool:
    return any(str(s.get("format", "")).upper() == "MP4" for s in streams)

# The video CDN answers 429 to an aoneroom.com Referer (the API hosts) but accepts the
# mirror sites, so playback headers always name a mirror site.
PLAYBACK_SITE = "https://moviebox.ph"

def playback_headers(domain: str) -> Dict[str, str]:
    site = PLAYBACK_SITE if "aoneroom.com" in domain else domain
    return {"User-Agent": "Mozilla/5.0", "Referer": f"{site}/", "Origin": site}

WEB_DOMAINS = [
    "https://123moviesfree.club",
    "https://movie-box.co",
    "https://movieboxonline.net",
    "https://sflix.film",
    "https://h5-api.aoneroom.com",
    "https://netnaija.film",
    "https://movieboxhd.net",
]

def _b64decode(s: str) -> bytes:
    s = s.replace("-", "+").replace("_", "/")
    s += "=" * (-len(s) % 4)
    return base64.b64decode(s)

def get_secret_bytes(use_alt_key: bool = False) -> bytes:
    outer = SECRET_KEY_ALT_B64 if use_alt_key else SECRET_KEY_DEFAULT_B64
    inner = _b64decode(outer).decode("utf-8")
    return _b64decode(inner)

def md5_hex(data: bytes) -> str:
    return hashlib.md5(data).hexdigest()

def generate_device_id() -> str:
    return secrets.token_hex(16)

def generate_x_client_token(timestamp: int) -> str:
    ts_str = str(timestamp)
    reversed_ts = ts_str[::-1].encode("utf-8")
    return f"{ts_str},{md5_hex(reversed_ts)}"

def generate_client_info(device_id: str) -> str:
    return json.dumps(
        {
            "package_name": "com.community.mbox.in",
            "version_name": "4.0.03.0920.03",
            "version_code": 50020130,
            "os": "android",
            "os_version": "14",
            "device_id": device_id,
            "install_store": "official",
            "gaid": "1b2212c1-dadf-43c3-a0c8-bd6ce48ae22d",
            "brand": "Google",
            "model": "Pixel 8",
            "system_language": "en",
            "net": "NETWORK_WIFI",
            "region": "IN",
            "timezone": "Asia/Calcutta",
            "sp_code": "",
        },
        separators=(",", ":"),
    )

def build_canonical_string(method: str, accept: str | None, content_type: str | None, url: str, body: str | None, timestamp: int) -> str:
    parsed = urlsplit(url)
    path = parsed.path or "/"
    if parsed.query:
        pairs = []
        for segment in parsed.query.split("&"):
            if not segment:
                continue
            pieces = segment.split("=", 1)
            pairs.append((pieces[0], pieces[1] if len(pieces) > 1 else ""))
        pairs.sort(key=lambda kv: kv[0])
        canonical_query = "&".join(f"{k}={v}" for k, v in pairs)
        canonical_url = f"{path}?{canonical_query}"
    else:
        canonical_url = path

    body_bytes = body.encode("utf-8") if body is not None else None
    if body_bytes:
        body_length = str(len(body_bytes))
        body_hash = md5_hex(body_bytes[:102400])
    else:
        body_length = ""
        body_hash = ""

    return "\n".join(
        [
            method.upper(),
            accept or "",
            content_type or "",
            body_length,
            str(timestamp),
            body_hash,
            canonical_url,
        ]
    )

def generate_x_tr_signature(method: str, accept: str | None, content_type: str | None, url: str, body: str | None, timestamp: int, use_alt_key: bool = False) -> str:
    canonical = build_canonical_string(method, accept, content_type, url, body, timestamp)
    key = get_secret_bytes(use_alt_key)
    digest = hmac.new(key, canonical.encode("utf-8"), hashlib.md5).digest()
    sig_b64 = base64.b64encode(digest).decode("ascii")
    return f"{timestamp}|2|{sig_b64}"

def build_auth_headers(method: str, url: str, body: str | None = None, token: str | None = None, device_id: str | None = None, use_alt_key: bool = False, content_type: str = "application/json", accept: str = "application/json") -> Dict[str, str]:
    ts = int(time.time() * 1000)
    dev_id = device_id or generate_device_id()
    headers = {
        "user-agent": MODERN_USER_AGENT,
        "accept": accept,
        "content-type": content_type,
        "connection": "keep-alive",
        "x-client-token": generate_x_client_token(ts),
        "x-tr-signature": generate_x_tr_signature(method, accept, content_type, url, body, ts, use_alt_key),
        "x-client-info": generate_client_info(dev_id),
        "x-client-status": "0",
    }
    if token:
        headers["authorization"] = f"Bearer {token}"
    return headers

def extract_policy_resource(sign_cookie: str | None) -> str | None:
    if not sign_cookie:
        return None
    m_edge = re.search(r"Edge-Cache-Cookie=urlprefix=([^:;\s]+)", sign_cookie)
    if m_edge:
        try:
            decoded = _b64decode(m_edge.group(1)).decode("utf-8").rstrip("/")
            return decoded + "/index.mpd"
        except Exception:
            pass
    m_cf = re.search(r"CloudFront-Policy=([^;]+)", sign_cookie)
    if m_cf:
        raw = m_cf.group(1)
        for t in ("cf", "std"):
            try:
                b = raw.replace("-", "+").replace("_", "=") if t == "cf" else raw
                b += "=" * (-len(b) % 4)
                data = json.loads(base64.b64decode(b).decode("utf-8"))
                for s in data.get("Statement", []):
                    res = s.get("Resource")
                    if res:
                        return res.rstrip("*").rstrip("/") + "/index.mpd"
            except Exception:
                pass
    return None

class MovieBoxEngine:
    _instance = None

    def __init__(self):
        self.device_id = generate_device_id()
        self.bearer_token: Optional[str] = None
        self._local = threading.local()
        self._stream_cache: Dict[tuple, tuple] = {}

    # Sessions are per thread: stream lookups run in parallel and curl_cffi sessions aren't thread-safe.
    @property
    def session(self):
        s = getattr(self._local, "session", None)
        if s is None:
            s = cr.Session(impersonate="chrome120") if cr else httpx.Client(timeout=25, follow_redirects=True)
            self._local.session = s
        return s

    @property
    def native_session(self):
        # The native API doesn't need browser impersonation, and with it each new
        # connection to api3/apig takes ~10s to establish (vs ~0.7s without).
        if not cr:
            return self.session
        s = getattr(self._local, "native_session", None)
        if s is None:
            s = cr.Session()
            self._local.native_session = s
        return s

    @classmethod
    def get_instance(cls) -> "MovieBoxEngine":
        if cls._instance is None:
            cls._instance = MovieBoxEngine()
        return cls._instance

    def bootstrap_token(self, force: bool = False) -> str:
        if self.bearer_token and not force:
            return self.bearer_token
        headers = build_auth_headers("GET", BOOTSTRAP_URL, device_id=self.device_id)
        resp = self.native_session.get(BOOTSTRAP_URL, headers=headers, timeout=20)
        x_user = resp.headers.get("x-user")
        if not x_user:
            raise HTTPException(status_code=502, detail=f"Failed to bootstrap MovieBox token (upstream HTTP {resp.status_code}: {resp.text[:120]})")
        token_data = json.loads(x_user)
        token = token_data.get("token")
        if not token:
            raise HTTPException(status_code=502, detail="Empty token in upstream header")
        self.bearer_token = token
        return token

    def api_request(self, method: str, path_or_url: str, body_dict: Optional[Dict[str, Any]] = None, use_token: bool = True, retry_auth: bool = True) -> Dict[str, Any]:
        if path_or_url.startswith("http://") or path_or_url.startswith("https://"):
            full_url = path_or_url
        else:
            full_url = f"{NATIVE_API_BASE}{path_or_url}"
        if use_token and not self.bearer_token:
            self.bootstrap_token()
        body_str = json.dumps(body_dict, separators=(",", ":")) if body_dict is not None else None
        headers = build_auth_headers(
            method=method,
            url=full_url,
            body=body_str,
            token=self.bearer_token if use_token else None,
            device_id=self.device_id,
        )
        data_bytes = body_str.encode("utf-8") if body_str is not None else None
        if method.upper() == "POST":
            resp = self.native_session.post(full_url, headers=headers, data=data_bytes, timeout=25)
        else:
            resp = self.native_session.get(full_url, headers=headers, timeout=25)
        if resp.status_code in (401, 441) and retry_auth:
            self.bootstrap_token(force=True)
            return self.api_request(method, path_or_url, body_dict, use_token, retry_auth=False)
        if resp.status_code != 200:
            raise HTTPException(status_code=502, detail=f"API returned HTTP {resp.status_code}")
        return resp.json()

    def search(self, query: str, page: int = 1, per_page: int = 20) -> List[Dict[str, Any]]:
        payload = {"keyword": query, "page": page, "perPage": per_page}
        url = "/wefeed-mobile-bff/subject-api/search"
        data = self.api_request("POST", url, body_dict=payload).get("data", {})
        raw_items = data.get("items", []) or data.get("list", [])
        results = []
        for item in raw_items:
            sub = item.get("subject", item)
            results.append({
                "subject_id": str(sub.get("subjectId")),
                "title": sub.get("title"),
                "type": "Movie" if sub.get("subjectType") == 1 else "Series",
                "subject_type": sub.get("subjectType"),
                "release_date": sub.get("releaseDate"),
                "imdb_rating": sub.get("imdbRatingValue"),
                "genre": sub.get("genre"),
                "cover": sub.get("cover", {}).get("url") if isinstance(sub.get("cover"), dict) else None,
                "detail_path": sub.get("detailPath"),
                "language": sub.get("language")
            })
        return results

    def get_details(self, subject_id: str) -> Dict[str, Any]:
        url = f"/wefeed-mobile-bff/subject-api/get?subjectId={subject_id}"
        data = self.api_request("GET", url).get("data")
        if not data:
            raise HTTPException(status_code=404, detail=f"No title found for subject_id {subject_id}")
        detail_url_str = data.get("detailUrl", "")
        detail_path = detail_url_str.split("/")[-1] if "/" in detail_url_str else detail_url_str
        return {
            "subject_id": str(data.get("subjectId")),
            "title": data.get("title"),
            "subject_type": data.get("subjectType"),
            "type": "Movie" if data.get("subjectType") == 1 else "Series",
            "description": data.get("description"),
            "release_date": data.get("releaseDate"),
            "duration": data.get("duration"),
            "imdb_rating": data.get("imdbRatingValue"),
            "genre": data.get("genre"),
            "country": data.get("countryName"),
            "language": data.get("language"),
            "cover": data.get("cover", {}).get("url") if isinstance(data.get("cover"), dict) else None,
            "detail_path": detail_path,
            "dubs": [
                {
                    "subject_id": str(d.get("subjectId")),
                    "lang_name": d.get("lanName"),
                    "language": d.get("language"),
                }
                for d in data.get("dubs", [])
                if isinstance(d, dict)
            ]
        }

    def get_episodes(self, subject_id: str) -> List[Dict[str, Any]]:
        url = f"/wefeed-mobile-bff/subject-api/season-info?subjectId={subject_id}"
        res = self.api_request("GET", url)
        seasons = res.get("data", {}).get("seasons", [])
        season_list = []
        for s in seasons:
            season_list.append({
                "season": s.get("se", 1),
                "episode_count": s.get("maxEp", 1),
                "resolutions": s.get("resolutions", [])
            })
        return season_list

    def get_streams(self, subject_id: str, season: int = 0, episode: int = 0, detail_path: Optional[str] = None) -> List[Dict[str, Any]]:
        key = (subject_id, season, episode)
        cached = self._stream_cache.get(key)
        if cached and time.time() - cached[0] < STREAM_CACHE_TTL:
            return cached[1]

        if not detail_path:
            try:
                details = self.get_details(subject_id)
                detail_path = details.get("detail_path", "")
            except Exception:
                detail_path = ""
        token = self.bootstrap_token()

        # Every mirror and the native API are queried at once; the first mirror with an MP4 wins,
        # since some mirrors only return DASH, which the CDN refuses.
        native_future = STREAM_POOL.submit(self._native_streams, subject_id, season, episode)
        web_futures = [
            STREAM_POOL.submit(self._web_streams, domain, subject_id, season, episode, detail_path, token)
            for domain in WEB_DOMAINS
        ]
        web: List[Dict[str, Any]] = []
        for fut in as_completed(web_futures):
            result = fut.result()
            if _has_mp4(result):
                web = result
                break
            web = web or result
        native = native_future.result()

        streams: List[Dict[str, Any]] = []
        seen_urls = set()
        for st in web + native:
            # The native API pads results with the same ~23s placeholder clip for every title.
            if st.get("duration_sec") and st["duration_sec"] < MIN_STREAM_SEC:
                continue
            if st["url"] not in seen_urls:
                seen_urls.add(st["url"])
                streams.append(st)
        streams.sort(key=lambda s: s["quality_value"], reverse=True)
        if _has_mp4(streams):
            self._stream_cache[key] = (time.time(), streams)
        return streams

    def _web_streams(self, domain: str, subject_id: str, season: int, episode: int, detail_path: str, token: str) -> List[Dict[str, Any]]:
        play_url = (
            f"{domain}/wefeed-h5api-bff/subject/play?"
            f"subjectId={subject_id}&se={season}&ep={episode}&detailPath={detail_path}&"
            f"streamSignType=1&supportCodecs%5Bhevc%5D=1&supportCodecs%5Bh264%5D=1"
        )
        referer = f"{domain}/movies/{detail_path}?id={subject_id}&type=/movie/detail&detailSe=&detailEp=&lang=en"
        headers = {
            "User-Agent": WEB_USER_AGENT,
            "Referer": referer,
            "Accept": "application/json",
            "x-client-info": '{"timezone":"Asia/Calcutta"}',
            "x-request-lang": "en",
            "x-vip-restrict": "0",
            "x-no-high-risk-restrict": "0",
            "x-source": "moviebox",
            "Authorization": f"Bearer {token}",
        }
        streams: List[Dict[str, Any]] = []
        try:
            resp = self.session.get(play_url, headers=headers, timeout=12)
            if resp.status_code != 200:
                return []
            data = resp.json().get("data", {})
        except Exception:
            return []

        for st in data.get("streams", []):
            url = st.get("url")
            if not url:
                continue
            res_str = str(st.get("resolutions", "unknown"))
            size_bytes = int(st.get("size") or 0)
            size_mb = size_bytes / (1024 * 1024) if size_bytes else 0
            quality_val = 0
            for q in (2160, 1440, 1080, 720, 480, 360, 240):
                if str(q) in res_str:
                    quality_val = q
                    break
            streams.append({
                "source": f"Web CDN ({domain})",
                "format": st.get("format", "MP4"),
                "quality": f"{quality_val}p" if quality_val else res_str,
                "quality_value": quality_val,
                "resolution_tag": res_str,
                "url": url,
                "size_mb": round(size_mb, 1),
                "codec": st.get("codecName"),
                "duration_sec": st.get("duration"),
                "headers": playback_headers(domain),
            })

        for d in data.get("dash", []):
            url = d.get("url")
            cookie = d.get("signCookie")
            extracted_mpd = extract_policy_resource(cookie) if cookie else None
            final_url = extracted_mpd or url
            if final_url:
                res_tag = str(d.get("resolutions", "adaptive"))
                streams.append({
                    "source": f"Web DASH ({domain})",
                    "format": "DASH",
                    "quality": "1080p (Adaptive)" if "1080" in res_tag else "Adaptive",
                    "quality_value": 1080 if "1080" in res_tag else 999,
                    "resolution_tag": res_tag,
                    "url": final_url,
                    "size_mb": 0,
                    "codec": "hevc/h264",
                    "duration_sec": None,
                    "cookie": cookie,
                    "headers": playback_headers(domain),
                })
        return streams

    def _native_streams(self, subject_id: str, season: int, episode: int) -> List[Dict[str, Any]]:
        streams: List[Dict[str, Any]] = []
        try:
            native_url = f"/wefeed-mobile-bff/subject-api/play-info?subjectId={subject_id}&se={season}&ep={episode}"
            native_data = self.api_request("GET", native_url).get("data", {})
            for st in native_data.get("streams", []):
                raw_url = st.get("url")
                if not raw_url or "b164fbfb4347792950bdfbfb563d39d9" in raw_url:
                    continue
                cookie = st.get("signCookie")
                policy_url = extract_policy_resource(cookie) if cookie else None
                final_url = policy_url or raw_url
                res_str = str(st.get("resolutions", ""))
                quality_val = 0
                for q in (2160, 1440, 1080, 720, 480, 360, 240):
                    if str(q) in res_str:
                        quality_val = q
                        break
                size_bytes = int(st.get("size") or 0)
                size_mb = size_bytes / (1024 * 1024) if size_bytes else 0
                streams.append({
                    "source": "Mobile Native CDN",
                    "format": "DASH" if (policy_url or ".mpd" in final_url) else st.get("format", "MP4"),
                    "quality": f"{quality_val}p" if quality_val else (res_str or "Default"),
                    "quality_value": quality_val,
                    "resolution_tag": res_str,
                    "url": final_url,
                    "size_mb": round(size_mb, 1),
                    "codec": st.get("codecName"),
                    "duration_sec": st.get("duration"),
                    "headers": {
                        "User-Agent": MODERN_USER_AGENT,
                        "Referer": "https://api3.aoneroom.com/",
                    }
                })
        except Exception:
            pass
        return streams

    def get_subtitles(self, subject_id: str, stream_id: Optional[str] = None, season: int = 0, episode: int = 0) -> List[Dict[str, Any]]:
        subs: List[Dict[str, Any]] = []
        seen_urls = set()

        if not stream_id:
            try:
                native_url = f"/wefeed-mobile-bff/subject-api/play-info?subjectId={subject_id}&se={season}&ep={episode}"
                raw_streams = self.api_request("GET", native_url).get("data", {}).get("streams", [])
                if raw_streams and raw_streams[0].get("id"):
                    stream_id = str(raw_streams[0]["id"])
            except Exception:
                pass

        def _add_sub(item: Dict[str, Any]):
            u = item.get("url")
            if u and u not in seen_urls:
                seen_urls.add(u)
                subs.append({
                    "id": str(item.get("id", "")),
                    "language": item.get("lanName") or item.get("language") or "English",
                    "code": item.get("lan", ""),
                    "url": u,
                    "size": item.get("size")
                })

        if stream_id:
            try:
                url = f"/wefeed-mobile-bff/subject-api/get-stream-captions?subjectId={subject_id}&streamId={stream_id}"
                data = self.api_request("GET", url).get("data", {})
                captions = data if isinstance(data, list) else data.get("extCaptions") or data.get("captions") or []
                for s in captions:
                    if isinstance(s, dict):
                        _add_sub(s)
            except Exception:
                pass

        try:
            res_id = stream_id or "0"
            url = f"/wefeed-mobile-bff/subject-api/get-ext-captions?subjectId={subject_id}&resourceId={res_id}&episode={episode}"
            data = self.api_request("GET", url).get("data", {})
            ext = data if isinstance(data, list) else data.get("extCaptions") or data.get("captions") or []
            for s in ext:
                if isinstance(s, dict):
                    _add_sub(s)
        except Exception:
            pass

        return subs

engine = MovieBoxEngine.get_instance()

@app.get("/", response_class=HTMLResponse)
async def dashboard():
    html_content = """<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MovieBox API</title>
    <style>
        :root {
            --bg: #09090b;
            --surface: #121215;
            --surface-hover: #18181b;
            --border: #27272a;
            --text: #fafafa;
            --text-dim: #71717a;
            --accent: #3b82f6;
            --accent-soft: rgba(59, 130, 246, 0.12);
            --green: #10b981;
            --green-soft: rgba(16, 185, 129, 0.12);
            --radius: 8px;
            --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            background: var(--bg);
            color: var(--text);
            font-family: var(--sans);
            font-size: 14px;
            line-height: 1.5;
            padding: 32px 20px;
        }
        .wrap {
            max-width: 980px;
            margin: 0 auto;
            display: flex;
            flex-direction: column;
            gap: 28px;
        }
        header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding-bottom: 20px;
            border-bottom: 1px solid var(--border);
        }
        .brand {
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .brand h1 {
            font-size: 18px;
            font-weight: 600;
            letter-spacing: -0.3px;
        }
        .pill {
            font-size: 11px;
            font-family: var(--mono);
            padding: 2px 7px;
            border-radius: 4px;
            background: var(--border);
            color: var(--text-dim);
        }
        .pill.active {
            background: var(--green-soft);
            color: var(--green);
        }
        .section-title {
            font-size: 13px;
            text-transform: uppercase;
            letter-spacing: 0.6px;
            color: var(--text-dim);
            margin-bottom: 12px;
            font-weight: 600;
        }
        .box {
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: var(--radius);
            padding: 18px;
        }
        .search-bar {
            display: flex;
            gap: 8px;
            position: relative;
        }
        .input-text {
            flex: 1;
            background: var(--bg);
            border: 1px solid var(--border);
            color: var(--text);
            padding: 10px 14px;
            border-radius: var(--radius);
            font-size: 14px;
            font-family: inherit;
            outline: none;
        }
        .input-text:focus {
            border-color: var(--accent);
        }
        .input-num {
            width: 80px;
            background: var(--bg);
            border: 1px solid var(--border);
            color: var(--text);
            padding: 10px 12px;
            border-radius: var(--radius);
            font-size: 14px;
            outline: none;
        }
        .btn-action {
            background: var(--text);
            color: var(--bg);
            border: none;
            padding: 10px 18px;
            border-radius: var(--radius);
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            white-space: nowrap;
        }
        .btn-action:hover {
            opacity: 0.9;
        }
        .btn-ghost {
            background: transparent;
            color: var(--text);
            border: 1px solid var(--border);
            padding: 6px 12px;
            border-radius: 6px;
            font-size: 12px;
            font-weight: 500;
            cursor: pointer;
            text-decoration: none;
            display: inline-flex;
            align-items: center;
        }
        .btn-ghost:hover {
            background: var(--surface-hover);
        }
        .dropdown {
            position: absolute;
            top: 100%;
            left: 0;
            right: 0;
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: var(--radius);
            margin-top: 4px;
            max-height: 240px;
            overflow-y: auto;
            z-index: 50;
            display: none;
        }
        .dropdown-item {
            padding: 10px 14px;
            cursor: pointer;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid #1c1c20;
        }
        .dropdown-item:hover {
            background: var(--surface-hover);
        }
        .media-row {
            display: flex;
            gap: 14px;
            align-items: center;
            margin-top: 16px;
            padding-top: 16px;
            border-top: 1px solid var(--border);
        }
        .media-poster {
            width: 44px;
            height: 62px;
            border-radius: 4px;
            object-fit: cover;
            background: var(--border);
        }
        .stream-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 12px 14px;
            border-bottom: 1px solid var(--border);
            font-size: 13px;
        }
        .stream-row:last-child {
            border-bottom: none;
        }
        .stream-spec {
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .stream-badge {
            font-family: var(--mono);
            font-weight: 600;
            font-size: 11px;
            padding: 2px 6px;
            border-radius: 4px;
            background: var(--accent-soft);
            color: var(--accent);
        }
        .stream-badge.hd {
            background: var(--green-soft);
            color: var(--green);
        }
        .video-box {
            display: none;
            flex-direction: column;
            gap: 10px;
            margin-top: 16px;
        }
        video {
            width: 100%;
            max-height: 480px;
            background: #000;
            border-radius: var(--radius);
            border: 1px solid var(--border);
        }
        .endpoint-table {
            width: 100%;
            border-collapse: collapse;
        }
        .endpoint-table th, .endpoint-table td {
            padding: 12px 14px;
            text-align: left;
            border-bottom: 1px solid var(--border);
            font-size: 13px;
        }
        .endpoint-table tr:last-child td {
            border-bottom: none;
        }
        .endpoint-method {
            font-family: var(--mono);
            font-size: 11px;
            font-weight: 700;
            color: var(--accent);
        }
        .endpoint-path {
            font-family: var(--mono);
            color: var(--text);
        }
    </style>
</head>
<body>
    <div class="wrap">
        <header>
            <div class="brand">
                <h1>MovieBox API</h1>
                <span class="pill">v2.5.0</span>
                <span class="pill active">1080p Online</span>
            </div>
            <div>
                <a class="btn-ghost" href="/docs" target="_blank">Swagger Docs</a>
            </div>
        </header>

        <div>
            <div class="section-title">Stream & Subtitle Resolver</div>
            <div class="box">
                <div class="search-bar">
                    <input type="text" id="searchInput" class="input-text" placeholder="Search title or paste Subject ID (e.g. Avatar, 8906247916759695608)..." autocomplete="off">
                    <input type="number" id="seasonInput" class="input-num" placeholder="S" title="Season" value="0">
                    <input type="number" id="episodeInput" class="input-num" placeholder="E" title="Episode" value="0">
                    <button class="btn-action" onclick="resolveStreams()">Resolve</button>
                    <div id="dropdownList" class="dropdown"></div>
                </div>

                <div id="mediaHeader" style="display: none;" class="media-row">
                    <img id="mediaPoster" class="media-poster">
                    <div>
                        <div id="mediaTitle" style="font-weight: 600; font-size: 15px;"></div>
                        <div id="mediaMeta" style="font-size: 12px; color: var(--text-dim); margin-top: 2px;"></div>
                    </div>
                </div>

                <div class="video-box" id="playerContainer">
                    <video id="player" controls playsinline></video>
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <span id="playerStatus" style="font-size: 12px; color: var(--text-dim); font-family: var(--mono);"></span>
                        <select id="subPicker" onchange="switchSubtitle(this.value)" class="input-text" style="max-width: 220px; padding: 6px 10px; font-size: 12px;">
                            <option value="">Subtitles Off</option>
                        </select>
                    </div>
                </div>

                <div id="streamList" style="margin-top: 14px;"></div>
            </div>
        </div>

        <div>
            <div class="section-title">Endpoints (Click Test to Open Raw JSON)</div>
            <div class="box" style="padding: 0;">
                <table class="endpoint-table">
                    <thead>
                        <tr style="color: var(--text-dim); font-size: 11px; text-transform: uppercase;">
                            <th style="width: 70px;">Method</th>
                            <th>Endpoint Path</th>
                            <th>Description</th>
                            <th style="width: 110px; text-align: right;">Action</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td><span class="endpoint-method">GET</span></td>
                            <td class="endpoint-path"><span class="pill" style="margin-right: 6px;">Movie</span>/api/stream/8906247916759695608</td>
                            <td style="color: var(--text-dim);">Movie Streams 1080p, 720p, 480p (Avatar)</td>
                            <td style="text-align: right;"><a href="/api/stream/8906247916759695608" target="_blank" class="btn-ghost">Test</a></td>
                        </tr>
                        <tr>
                            <td><span class="endpoint-method">GET</span></td>
                            <td class="endpoint-path"><span class="pill" style="margin-right: 6px;">Movie</span>/api/stream/8906247916759695608/captions</td>
                            <td style="color: var(--text-dim);">Movie Subtitle Tracks .srt (Avatar)</td>
                            <td style="text-align: right;"><a href="/api/stream/8906247916759695608/captions" target="_blank" class="btn-ghost">Test</a></td>
                        </tr>
                        <tr>
                            <td><span class="endpoint-method">GET</span></td>
                            <td class="endpoint-path"><span class="pill active" style="margin-right: 6px;">Series</span>/episodes/6207982430134357800</td>
                            <td style="color: var(--text-dim);">TV Seasons & Episode Counts (Breaking Bad)</td>
                            <td style="text-align: right;"><a href="/episodes/6207982430134357800" target="_blank" class="btn-ghost">Test</a></td>
                        </tr>
                        <tr>
                            <td><span class="endpoint-method">GET</span></td>
                            <td class="endpoint-path"><span class="pill active" style="margin-right: 6px;">Series</span>/api/stream/6207982430134357800?se=1&ep=1</td>
                            <td style="color: var(--text-dim);">TV Episode Stream: Season 1, Episode 1</td>
                            <td style="text-align: right;"><a href="/api/stream/6207982430134357800?se=1&ep=1" target="_blank" class="btn-ghost">Test</a></td>
                        </tr>
                        <tr>
                            <td><span class="endpoint-method">GET</span></td>
                            <td class="endpoint-path"><span class="pill active" style="margin-right: 6px;">Series</span>/api/stream/6207982430134357800?se=1&ep=2</td>
                            <td style="color: var(--text-dim);">TV Episode Stream: Season 1, Episode 2</td>
                            <td style="text-align: right;"><a href="/api/stream/6207982430134357800?se=1&ep=2" target="_blank" class="btn-ghost">Test</a></td>
                        </tr>
                        <tr>
                            <td><span class="endpoint-method">GET</span></td>
                            <td class="endpoint-path"><span class="pill active" style="margin-right: 6px;">Series</span>/api/stream/6207982430134357800/captions?se=1&ep=1</td>
                            <td style="color: var(--text-dim);">TV Episode Subtitles: Season 1, Episode 1</td>
                            <td style="text-align: right;"><a href="/api/stream/6207982430134357800/captions?se=1&ep=1" target="_blank" class="btn-ghost">Test</a></td>
                        </tr>
                        <tr>
                            <td><span class="endpoint-method">GET</span></td>
                            <td class="endpoint-path">/search?q=Avatar</td>
                            <td style="color: var(--text-dim);">Search catalog with metadata & IDs</td>
                            <td style="text-align: right;"><a href="/search?q=Avatar" target="_blank" class="btn-ghost">Test</a></td>
                        </tr>
                        <tr>
                            <td><span class="endpoint-method">GET</span></td>
                            <td class="endpoint-path">/search/suggest?q=Avatar</td>
                            <td style="color: var(--text-dim);">Real-time search autocomplete suggestions</td>
                            <td style="text-align: right;"><a href="/search/suggest?q=Avatar" target="_blank" class="btn-ghost">Test</a></td>
                        </tr>
                        <tr>
                            <td><span class="endpoint-method">GET</span></td>
                            <td class="endpoint-path">/detail/8906247916759695608</td>
                            <td style="color: var(--text-dim);">Deep metadata, audio dubs, and plot summary</td>
                            <td style="text-align: right;"><a href="/detail/8906247916759695608" target="_blank" class="btn-ghost">Test</a></td>
                        </tr>
                        <tr>
                            <td><span class="endpoint-method">GET</span></td>
                            <td class="endpoint-path">/movies?page=1</td>
                            <td style="color: var(--text-dim);">Paginated movie feed</td>
                            <td style="text-align: right;"><a href="/movies?page=1" target="_blank" class="btn-ghost">Test</a></td>
                        </tr>
                        <tr>
                            <td><span class="endpoint-method">GET</span></td>
                            <td class="endpoint-path">/tv-series?page=1</td>
                            <td style="color: var(--text-dim);">Paginated TV series feed</td>
                            <td style="text-align: right;"><a href="/tv-series?page=1" target="_blank" class="btn-ghost">Test</a></td>
                        </tr>
                        <tr>
                            <td><span class="endpoint-method">GET</span></td>
                            <td class="endpoint-path">/home</td>
                            <td style="color: var(--text-dim);">Banners, hot sections, and operating feeds</td>
                            <td style="text-align: right;"><a href="/home" target="_blank" class="btn-ghost">Test</a></td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>
    </div>

    <script>
        let searchTimer = null;
        let activeSubjectId = "";
        const searchInput = document.getElementById("searchInput");
        const dropdownList = document.getElementById("dropdownList");

        searchInput.addEventListener("input", (e) => {
            clearTimeout(searchTimer);
            const val = e.target.value.trim();
            if (val.length < 2) {
                dropdownList.style.display = "none";
                return;
            }
            if (/^\\d{15,}$/.test(val)) {
                activeSubjectId = val;
                dropdownList.style.display = "none";
                return;
            }
            searchTimer = setTimeout(async () => {
                try {
                    const res = await fetch(`/search/suggest?q=${encodeURIComponent(val)}`);
                    const data = await res.json();
                    const list = data.suggestions || [];
                    if (!list.length) {
                        dropdownList.style.display = "none";
                        return;
                    }
                    dropdownList.innerHTML = list.map(item => `
                        <div class="dropdown-item" onclick="selectItem('${item.subject_id}', '${item.title.replace(/'/g, "\\\\'")}')">
                            <span style="font-weight: 500;">${item.title}</span>
                            <span style="font-family: var(--mono); font-size: 11px; color: var(--text-dim);">${item.subject_id}</span>
                        </div>
                    `).join("");
                    dropdownList.style.display = "block";
                } catch (err) {}
            }, 200);
        });

        function selectItem(id, title) {
            activeSubjectId = id;
            searchInput.value = title;
            dropdownList.style.display = "none";
            resolveStreams();
        }

        async function resolveStreams() {
            const val = searchInput.value.trim();
            const subjectId = /^\\d{15,}$/.test(val) ? val : (activeSubjectId || val);
            const se = parseInt(document.getElementById("seasonInput").value) || 0;
            const ep = parseInt(document.getElementById("episodeInput").value) || 0;

            if (!subjectId) {
                alert("Please enter a title or Subject ID");
                return;
            }

            const streamList = document.getElementById("streamList");
            streamList.innerHTML = '<div style="padding: 12px; color: var(--text-dim); font-size: 13px;">Resolving streams...</div>';

            try {
                const [streamRes, capRes, detailRes] = await Promise.all([
                    fetch(`/api/stream/${subjectId}?se=${se}&ep=${ep}`).then(r => r.json()),
                    fetch(`/api/stream/${subjectId}/captions?se=${se}&ep=${ep}`).then(r => r.json()),
                    fetch(`/detail/${subjectId}`).then(r => r.json()).catch(() => null)
                ]);

                if (detailRes && detailRes.title) {
                    document.getElementById("mediaHeader").style.display = "flex";
                    document.getElementById("mediaTitle").textContent = `${detailRes.title} (${detailRes.type})`;
                    document.getElementById("mediaMeta").textContent = `${detailRes.release_date || ""} • IMDb: ${detailRes.imdb_rating || "N/A"} • ${detailRes.genre || ""}`;
                    if (detailRes.cover) {
                        const p = document.getElementById("mediaPoster");
                        p.src = detailRes.cover;
                        p.style.display = "block";
                    }
                }

                const streams = streamRes.streams || [];
                if (!streams.length) {
                    streamList.innerHTML = '<div style="padding: 12px; color: var(--text-dim); font-size: 13px;">No streams found for this request.</div>';
                    return;
                }

                streamList.innerHTML = streams.map((s, idx) => `
                    <div class="stream-row">
                        <div class="stream-spec">
                            <span class="stream-badge ${s.quality.includes('1080') ? 'hd' : ''}">${s.quality}</span>
                            <span style="font-weight: 500;">${s.format}</span>
                            <span style="color: var(--text-dim); font-size: 12px;">${s.size_mb ? s.size_mb + ' MB' : 'DASH Master'}</span>
                            <span style="color: var(--text-dim); font-size: 12px;">${s.codec || ''}</span>
                        </div>
                        <div style="display: flex; gap: 6px;">
                            <button class="btn-ghost" onclick="play('${encodeURIComponent(JSON.stringify(s))}')">Play</button>
                            <a class="btn-ghost" href="${s.url}" target="_blank">Open Raw</a>
                            <button class="btn-ghost" onclick="copyUrl('${s.url}')">Copy</button>
                        </div>
                    </div>
                `).join("");

                const subs = capRes.captions || [];
                const subPicker = document.getElementById("subPicker");
                subPicker.innerHTML = '<option value="">Subtitles Off</option>' + subs.map(sub => `
                    <option value="${sub.url}">${sub.language}</option>
                `).join("");

            } catch (err) {
                streamList.innerHTML = `<div style="padding: 12px; color: #ef4444; font-size: 13px;">Failed: ${err.message}</div>`;
            }
        }

        function play(encoded) {
            const stream = JSON.parse(decodeURIComponent(encoded));
            const player = document.getElementById("player");
            const container = document.getElementById("playerContainer");
            container.style.display = "flex";
            document.getElementById("playerStatus").textContent = `Playing: ${stream.quality} ${stream.format}`;
            player.src = stream.url;
            player.play().catch(() => {});
        }

        function copyUrl(url) {
            navigator.clipboard.writeText(url).then(() => alert("Stream URL copied to clipboard!"));
        }

        function switchSubtitle(url) {
            const player = document.getElementById("player");
            player.querySelectorAll("track").forEach(t => t.remove());
            if (!url) return;
            const t = document.createElement("track");
            t.kind = "captions";
            t.label = "Selected";
            t.srclang = "en";
            t.src = url;
            t.default = true;
            player.appendChild(t);
        }
    </script>
</body>
</html>
"""
    return HTMLResponse(content=html_content)

@app.get("/search")
def search(q: str = Query(..., min_length=1), page: int = 1, per_page: int = 20):
    return {"query": q, "page": page, "results": engine.search(q, page=page, per_page=per_page)}

@app.get("/search/suggest")
def search_suggest(q: str = Query(..., min_length=1)):
    url = f"{API_BASE}/subject/search-suggest"
    headers = {"User-Agent": WEB_USER_AGENT, "Referer": "https://moviebox.ph/"}
    try:
        resp = engine.session.post(url, headers=headers, json={"keyword": q, "perPage": 10}, timeout=15)
        raw = resp.json().get("data", {}).get("items", [])
    except Exception:
        raw = []
    suggestions = []
    for item in raw:
        sub = item.get("subject") or {}
        sid = sub.get("subjectId") or item.get("subjectId")
        suggestions.append({
            "title": sub.get("title") or item.get("word") or item.get("title"),
            "slug": sub.get("detailPath") or item.get("detailPath"),
            "subject_id": str(sid) if sid else None
        })
    return {"suggestions": suggestions}

@app.get("/detail/{subject_id}")
def get_detail(subject_id: str):
    return engine.get_details(subject_id)

@app.get("/episodes/{subject_id}")
def get_episodes(subject_id: str):
    return {"subject_id": subject_id, "seasons": engine.get_episodes(subject_id)}

@app.get("/api/stream/{subject_id}")
def get_streams(subject_id: str, se: int = 0, ep: int = 0, detail_path: Optional[str] = None):
    streams = engine.get_streams(subject_id, season=se, episode=ep, detail_path=detail_path)
    # Copies, so the cached entries never carry a token that later expires
    signed = [{**st, "proxy_token": sign_media(st["url"])} for st in streams]
    return {
        "subject_id": subject_id,
        "season": se,
        "episode": ep,
        "count": len(signed),
        "streams": signed
    }

# The media relay only serves links this API handed out (signed, time-limited) and only to
# pages on this site, so others can't run their streaming through it on our bandwidth.
PROXY_TOKEN_TTL = 6 * 3600
PROXY_REQUIRE_SIG = os.environ.get("PROXY_REQUIRE_SIG", "1" if os.environ.get("VERCEL") else "0") == "1"

def _proxy_secret() -> bytes:
    base = os.environ.get("PROXY_SECRET") or os.environ.get("ABLY_API_KEY") or ""
    return hashlib.sha256(("proxy:" + base).encode()).digest() if base else b""

def _media_sig(url: str, exp: int) -> str:
    return hmac.new(_proxy_secret(), f"{url}\n{exp}".encode(), hashlib.sha256).hexdigest()[:32]

def sign_media(url: str) -> Dict[str, Any]:
    exp = int(time.time()) + PROXY_TOKEN_TTL
    return {"exp": exp, "sig": _media_sig(url, exp)}

def _proxy_allowed(request: Request, url: str, exp: Optional[int], sig: Optional[str]) -> Optional[str]:
    """Returns why a relay request is refused, or None when it may proceed."""
    referer = request.headers.get("referer") or request.headers.get("origin")
    if referer:
        ref_host = (urlsplit(referer).hostname or "").lower()
        own_host = (request.headers.get("host") or "").split(":")[0].lower()
        extra = {h.strip().lower() for h in os.environ.get("ALLOWED_SITE_HOSTS", "").split(",") if h.strip()}
        if ref_host not in {own_host, "localhost", "127.0.0.1"} | extra:
            return "Requests from other sites are not allowed"
    if PROXY_REQUIRE_SIG:
        if not _proxy_secret():
            return "Relay is not configured"
        if not exp or not sig or exp < time.time() or not hmac.compare_digest(sig, _media_sig(url, exp)):
            return "Missing or expired link signature"
    return None

@app.get("/api/stream/{subject_id}/captions")
def get_captions(subject_id: str, se: int = 0, ep: int = 0, stream_id: Optional[str] = None):
    subs = engine.get_subtitles(subject_id, stream_id=stream_id, season=se, episode=ep)
    return {
        "subject_id": subject_id,
        "season": se,
        "episode": ep,
        "count": len(subs),
        "captions": subs
    }

# Browsers can't set Referer/Origin on <video> requests and the CDN answers 429 without them,
# so media is relayed through here with the headers returned alongside each stream.
PROXY_HOST_SUFFIXES = ("hakunaymatata.com", "aoneroom.com")
PROXY_HEADER_KEYS = {"user-agent", "referer", "origin", "cookie"}
PROXY_PASSTHROUGH = ("content-type", "content-length", "content-range", "accept-ranges", "content-encoding")
# Serverless hosts cap request time (~30s) and response size (~4.5MB), so there each media
# response is one bounded chunk. A long-running server streams whole ranges instead.
PROXY_CHUNK_BYTES = int(os.environ.get("PROXY_CHUNK_BYTES") or (4 * 1024 * 1024 if os.environ.get("VERCEL") else 0))

@app.get("/proxy")
async def proxy_stream(request: Request, url: str, h: Optional[str] = None, exp: Optional[int] = None, sig: Optional[str] = None):
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    if parts.scheme not in ("http", "https") or not any(host == s or host.endswith("." + s) for s in PROXY_HOST_SUFFIXES):
        raise HTTPException(status_code=400, detail="Host not allowed")
    refused = _proxy_allowed(request, url, exp, sig)
    if refused:
        raise HTTPException(status_code=403, detail=refused)
    headers = {}
    if h:
        try:
            raw = json.loads(_b64decode(h).decode("utf-8"))
            headers = {k: str(v) for k, v in raw.items() if k.lower() in PROXY_HEADER_KEYS}
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid headers parameter")
    rng = request.headers.get("range")
    if PROXY_CHUNK_BYTES:
        # Answer at most one chunk per request; the player simply asks for the next range
        m = re.fullmatch(r"bytes=(\d+)-(\d*)", rng or "bytes=0-")
        if m:
            start = int(m.group(1))
            cap = start + PROXY_CHUNK_BYTES - 1
            rng = f"bytes={start}-{min(int(m.group(2)), cap) if m.group(2) else cap}"
    if rng:
        headers["Range"] = rng

    client = _proxy_client()
    upstream = await client.send(client.build_request("GET", url, headers=headers), stream=True)

    async def body():
        # Browsers abort and re-request ranges on every seek; release the pooled connection either way
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        finally:
            await upstream.aclose()

    return StreamingResponse(
        body(),
        status_code=upstream.status_code,
        headers={k: upstream.headers[k] for k in PROXY_PASSTHROUGH if k in upstream.headers},
        background=BackgroundTask(upstream.aclose),
    )

# One pooled client for all media requests: a seek then reuses an open CDN connection
# instead of paying for a new TLS handshake every time.
_PROXY_CLIENT: Optional[httpx.AsyncClient] = None

def _proxy_client() -> httpx.AsyncClient:
    global _PROXY_CLIENT
    if _PROXY_CLIENT is None:
        _PROXY_CLIENT = httpx.AsyncClient(
            follow_redirects=True,
            timeout=httpx.Timeout(30.0, read=None),
            limits=httpx.Limits(max_connections=64, max_keepalive_connections=16, keepalive_expiry=60),
        )
    return _PROXY_CLIENT

@app.get("/movies")
def get_movies(page: int = 1, per_page: int = 24, sort: str = "RECOMMEND"):
    url = f"{API_BASE}/subject/filter"
    payload = {"tabId": 2, "filter": {"sort": sort, "genre": "ALL", "country": "ALL", "year": "ALL", "language": "ALL"}, "page": page, "perPage": per_page}
    resp = engine.session.post(url, headers={"User-Agent": WEB_USER_AGENT, "Referer": "https://moviebox.ph/"}, json=payload, timeout=20)
    data = resp.json().get("data", {})
    raw = data.get("items") or data.get("subjects") or []
    return {
        "page": page,
        "per_page": per_page,
        "total": data.get("pager", {}).get("totalCount") or len(raw),
        "items": [
            {
                "title": s.get("title"),
                "subject_id": str(s.get("subjectId")),
                "detail_path": s.get("detailPath"),
                "cover": s.get("cover", {}).get("url") if isinstance(s.get("cover"), dict) else None,
                "rating": s.get("imdbRatingValue"),
                "year": s.get("releaseDate", "")[:4] if s.get("releaseDate") else None
            }
            for s in raw
        ]
    }

@app.get("/tv-series")
def get_tv_series(page: int = 1, per_page: int = 24, sort: str = "RECOMMEND"):
    url = f"{API_BASE}/subject/filter"
    payload = {"tabId": 5, "filter": {"sort": sort, "genre": "ALL", "country": "ALL", "year": "ALL", "language": "ALL"}, "page": page, "perPage": per_page}
    resp = engine.session.post(url, headers={"User-Agent": WEB_USER_AGENT, "Referer": "https://moviebox.ph/"}, json=payload, timeout=20)
    data = resp.json().get("data", {})
    raw = data.get("items") or data.get("subjects") or []
    return {
        "page": page,
        "per_page": per_page,
        "total": data.get("pager", {}).get("totalCount") or len(raw),
        "items": [
            {
                "title": s.get("title"),
                "subject_id": str(s.get("subjectId")),
                "detail_path": s.get("detailPath"),
                "cover": s.get("cover", {}).get("url") if isinstance(s.get("cover"), dict) else None,
                "rating": s.get("imdbRatingValue"),
                "year": s.get("releaseDate", "")[:4] if s.get("releaseDate") else None
            }
            for s in raw
        ]
    }

@app.get("/home")
def get_home():
    url = f"{API_BASE}/home?host=moviebox.ph"
    resp = engine.session.get(url, headers={"User-Agent": WEB_USER_AGENT, "Referer": "https://moviebox.ph/"}, timeout=20)
    return resp.json()

# ── Watch-party site support ─────────────────────────────────────────────

# Row titles from MovieBox carry decorative emoji ("🔥Hot Short TV"); the site renders icons instead
EMOJI_RE = re.compile("[\U0001F000-\U0001FAFF☀-➿️‍]+")
PLAYABLE_TYPES = {1: "movie", 2: "series"}
HOME_CACHE_TTL = 600
_home_cache: Dict[str, Any] = {}

def _catalog_card(s: Dict[str, Any]) -> Dict[str, Any]:
    cover = s.get("cover")
    return {
        "subject_id": str(s.get("subjectId")),
        "title": EMOJI_RE.sub("", s.get("title") or "").strip(),
        "type": PLAYABLE_TYPES[s.get("subjectType")],
        "cover": cover.get("url") if isinstance(cover, dict) else None,
        "year": (s.get("releaseDate") or "")[:4] or None,
        "rating": s.get("imdbRatingValue") or None,
        "detail_path": s.get("detailPath"),
    }

def _playable(s: Dict[str, Any]) -> bool:
    # Music videos, short TV and "coming soon" entries have no full-length stream
    return s.get("subjectType") in PLAYABLE_TYPES and s.get("hasResource") is not False and not s.get("isPornographic")

@app.get("/catalog/home")
def catalog_home():
    """The MovieBox home feed as clean rows of movies and series."""
    if _home_cache and time.time() - _home_cache["at"] < HOME_CACHE_TTL:
        return _home_cache["data"]
    data = get_home().get("data") or {}
    rows = []
    for op in data.get("operatingList") or []:
        if op.get("type") != "SUBJECTS_MOVIE":
            continue
        title = EMOJI_RE.sub("", op.get("title") or "").strip()
        items = [_catalog_card(s) for s in op.get("subjects") or [] if _playable(s)]
        if title and items:
            rows.append({"title": title, "items": items})
    result = {"rows": rows}
    if rows:
        _home_cache.update(at=time.time(), data=result)
    return result

@app.get("/ably/token")
def ably_token(clientId: str = Query(..., min_length=1, max_length=80)):
    """Signed Ably token request, so the API key never reaches the browser.

    Ably's client exchanges this for a one-hour token scoped to room channels.
    """
    key = os.environ.get("ABLY_API_KEY", "")
    if ":" not in key:
        raise HTTPException(status_code=503, detail="ABLY_API_KEY is not set on the server")
    key_name, key_secret = key.split(":", 1)
    ttl = 60 * 60 * 1000
    capability = json.dumps({"room:*": ["publish", "subscribe", "presence"]}, separators=(",", ":"))
    timestamp = int(time.time() * 1000)
    nonce = secrets.token_hex(16)
    sign_text = "\n".join([key_name, str(ttl), capability, clientId, str(timestamp), nonce]) + "\n"
    mac = base64.b64encode(hmac.new(key_secret.encode(), sign_text.encode(), hashlib.sha256).digest()).decode()
    return {"keyName": key_name, "ttl": ttl, "capability": capability, "clientId": clientId,
            "timestamp": timestamp, "nonce": nonce, "mac": mac}

_public_url_cache: Dict[str, Any] = {"at": 0.0, "url": None}

@app.get("/public-url")
def public_url():
    """The address friends can reach this server on, for invite links made on localhost.

    PUBLIC_URL wins if set; otherwise ask a running Cloudflare quick tunnel, whose local
    metrics server (ports 20241-20245 by default) reports the tunnel hostname.
    """
    if os.environ.get("PUBLIC_URL"):
        return {"url": os.environ["PUBLIC_URL"].rstrip("/")}
    if time.time() - _public_url_cache["at"] < 30:
        return {"url": _public_url_cache["url"]}
    found = None
    for port in range(20241, 20246):
        try:
            host = httpx.get(f"http://127.0.0.1:{port}/quicktunnel", timeout=0.5).json().get("hostname")
        except Exception:
            continue
        if host:
            found = f"https://{host}"
            break
    _public_url_cache.update(at=time.time(), url=found)
    return {"url": found}

# Serve the watch-party site from this server too, so one public URL (e.g. a tunnel) covers both
SITE_DIR = os.environ.get("SITE_DIR") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "streaming platform", "v2")
if os.path.isdir(SITE_DIR):
    app.mount("/app", StaticFiles(directory=SITE_DIR, html=True), name="site")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("api:app", host="0.0.0.0", port=8000, reload=True)
