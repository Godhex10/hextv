"""Lagos relay stats for the HexTV dashboard (runs on the relay server next to the API).

GET /stats with "Authorization: Bearer $RELAY_STATS_TOKEN" returns server health, bandwidth
(from vnstat), who is connected right now, and the latest MovieBox check made from this server.
The dashboard's room server reads it every 15 minutes. Standard library only.
"""
import hmac
import json
import os
import shutil
import subprocess
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = os.environ.get("RELAY_STATS_TOKEN", "")
API_BASE = os.environ.get("API_BASE", "https://streamtogether-pi.vercel.app")
# Same title the dashboard's MovieBox health check looks up
CHECK_TITLE = os.environ.get("CHECK_TITLE", "6391474290696802080")
STATE_FILE = "/opt/hextv/stats/state.json"
CHECK_EVERY = 15 * 60
SERVICES = ("hextv-relay", "caddy")

state = {"cpu": [], "checks": []}   # cpu: (time, busy %) per minute; checks: MovieBox results, 48h
lock = threading.Lock()


def load_state():
    try:
        with open(STATE_FILE) as f:
            state.update(json.load(f))
    except (OSError, ValueError):
        pass


def save_state():
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f)
    os.replace(tmp, STATE_FILE)


def cpu_times():
    with open("/proc/stat") as f:
        v = [int(x) for x in f.readline().split()[1:]]
    idle = v[3] + v[4]
    return sum(v), idle


def sample_cpu():
    # One busy-% reading per minute, kept for 24h
    prev = cpu_times()
    while True:
        time.sleep(60)
        cur = cpu_times()
        total, idle = cur[0] - prev[0], cur[1] - prev[1]
        prev = cur
        with lock:
            state["cpu"].append((int(time.time()), round(100 * (1 - idle / total), 1) if total else 0))
            state["cpu"] = state["cpu"][-1440:]


def moviebox_check():
    """Fetch the start of a real MovieBox video from here, like the relay does for a viewer."""
    t0 = time.time()
    out = {"at": int(t0), "ok": False, "status": 0, "ms": 0, "mbps": None, "detail": ""}
    try:
        req = urllib.request.Request(f"{API_BASE}/api/stream/{CHECK_TITLE}?direct=1", headers={"User-Agent": "HexTV-relay-check"})
        with urllib.request.urlopen(req, timeout=60) as r:
            streams = [s for s in json.load(r).get("streams", []) if str(s.get("format")).upper() == "MP4"]
        if not streams:
            out["detail"] = "no video links from the API"
            return out
        s = min(streams, key=lambda x: x.get("quality_value") or 9999)
        headers = dict(s.get("headers") or {})
        headers["Range"] = "bytes=0-2097151"
        t1 = time.time()
        try:
            with urllib.request.urlopen(urllib.request.Request(s["url"], headers=headers), timeout=40) as r:
                n = len(r.read())
                out["status"] = r.status
        except urllib.error.HTTPError as e:
            out["status"], n = e.code, 0
        dt = time.time() - t1
        out["ok"] = out["status"] in (200, 206) and n > 0
        if out["ok"] and dt > 0:
            out["mbps"] = round(n * 8 / dt / 1e6, 1)
        if not out["ok"]:
            out["detail"] = f"MovieBox answered {out['status']}" + (" (refusing this server)" if out["status"] in (403, 427, 429) else "")
    except Exception as e:  # noqa: BLE001 - any failure is a failed check
        out["detail"] = str(e)[:160]
    out["ms"] = int((time.time() - t0) * 1000)
    return out


def check_loop():
    while True:
        res = moviebox_check()
        with lock:
            state["checks"].append(res)
            state["checks"] = state["checks"][-192:]
            save_state()
        time.sleep(CHECK_EVERY)


def run(*cmd):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        return ""


def bandwidth():
    """Bytes in and out this month and in the last 24 hours, from vnstat (counts since it was installed)."""
    try:
        data = json.loads(run("vnstat", "--json"))
    except ValueError:
        return None
    ifaces = [i for i in data.get("interfaces", []) if i.get("name") != "lo"]
    if not ifaces:
        return None
    i = max(ifaces, key=lambda x: x.get("traffic", {}).get("total", {}).get("tx", 0))
    tr = i.get("traffic", {})
    now = time.localtime()
    month = next((m for m in tr.get("month", []) if m["date"]["year"] == now.tm_year and m["date"]["month"] == now.tm_mon), {"rx": 0, "tx": 0})
    cutoff = time.time() - 24 * 3600
    rx24 = tx24 = 0
    for h in tr.get("hour", []):
        if h.get("timestamp", 0) >= cutoff:
            rx24 += h["rx"]
            tx24 += h["tx"]
    created = i.get("created", {}).get("timestamp")
    return {"iface": i.get("name"), "monthTx": month["tx"], "monthRx": month["rx"], "tx24h": tx24, "rx24h": rx24, "since": created}


def viewers_now():
    # Distinct devices with an open https connection to the relay
    ips = set()
    for line in run("ss", "-Htn", "state", "established", "( sport = :443 )").splitlines():
        parts = line.split()
        if len(parts) >= 4:
            ips.add(parts[3].rsplit(":", 1)[0])
    return len(ips)


def meminfo():
    m = {}
    with open("/proc/meminfo") as f:
        for line in f:
            k, v = line.split(":", 1)
            m[k] = int(v.split()[0]) * 1024
    return {"total": m["MemTotal"], "used": m["MemTotal"] - m["MemAvailable"]}


def snapshot():
    with open("/proc/uptime") as f:
        uptime = float(f.read().split()[0])
    du = shutil.disk_usage("/")
    with lock:
        cpu = list(state["cpu"])
        checks = list(state["checks"])
    recent = [c for t, c in cpu if t > time.time() - 900]
    return {
        "at": int(time.time()),
        "uptimeS": int(uptime),
        "load": os.getloadavg(),
        "cpuPct": round(sum(recent) / len(recent), 1) if recent else None,
        "cpuMax24h": max((c for _, c in cpu), default=None),
        "mem": meminfo(),
        "disk": {"total": du.total, "used": du.used},
        "net": bandwidth(),
        "viewersNow": viewers_now(),
        "services": {s: run("systemctl", "is-active", s).strip() for s in SERVICES},
        "moviebox": checks[-1] if checks else None,
        "checks": [{"at": c["at"], "ok": c["ok"], "ms": c["ms"], "detail": c.get("detail", "")} for c in checks],
    }


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        auth = self.headers.get("Authorization", "")
        if self.path != "/stats" or not TOKEN or not hmac.compare_digest(auth, "Bearer " + TOKEN):
            self.send_error(404)
            return
        body = json.dumps(snapshot()).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    load_state()
    threading.Thread(target=sample_cpu, daemon=True).start()
    threading.Thread(target=check_loop, daemon=True).start()
    ThreadingHTTPServer(("127.0.0.1", 8001), Handler).serve_forever()
