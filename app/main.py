"""dash.awruff.org — the service.

Three jobs:
  1. hold the Proxmox credential, so the browser never sees it
  2. ask Proxmox what is going on and shape the answer
  3. serve the page

Run it:  uvicorn app.main:app --host 0.0.0.0 --port 3002
"""

from __future__ import annotations

import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import config as config_mod
from .proxmox import Proxmox
from .state import build_state

log = logging.getLogger("dash")
logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)-7s %(name)s  %(message)s",
)

STATIC = Path(__file__).parent / "static"
CONFIG_PATH = os.environ.get("DASH_CONFIG", "config.yaml")

# Proxmox is polled at most this often no matter how many browsers are open.
# Ten tabs left open on a phone should not become ten times the API load.
CACHE_SECONDS = float(os.environ.get("DASH_CACHE_SECONDS", "5"))


class Runtime:
    cfg = None
    pve: Proxmox | None = None
    http: httpx.AsyncClient | None = None
    cache: dict | None = None
    cached_at: float = 0.0
    boot_error: str | None = None
    index_html: str = ""


rt = Runtime()


def _versioned_index() -> str:
    """index.html with app.css/app.js tagged by each file's own mtime.

    Browsers have no reason to re-fetch a plain 'app.css' after a deploy —
    nothing about that URL changed. Tagging it '?v=<mtime>' means the URL
    itself changes whenever the file does, so a stale cached copy can't
    survive a deploy silently. Computed once at startup: a new file would
    mean a new container anyway, so there's no point redoing this per request.
    """
    html = (STATIC / "index.html").read_text(encoding="utf-8")
    css_v = int((STATIC / "app.css").stat().st_mtime)
    js_v = int((STATIC / "app.js").stat().st_mtime)
    html = html.replace('href="app.css"', f'href="app.css?v={css_v}"')
    html = html.replace('src="app.js"', f'src="app.js?v={js_v}"')
    return html


@asynccontextmanager
async def lifespan(app: FastAPI):
    rt.index_html = _versioned_index()
    try:
        rt.cfg = config_mod.load(CONFIG_PATH)
        rt.pve = Proxmox(
            url=rt.cfg.proxmox.url,
            node=rt.cfg.proxmox.node,
            token_id=rt.cfg.proxmox.token_id,
            token_secret=rt.cfg.proxmox.token_secret,
            verify_ssl=rt.cfg.proxmox.verify_ssl,
        )
        rt.http = httpx.AsyncClient(timeout=4.0, verify=False)
        log.info("config loaded: %d services, node %s",
                 len(rt.cfg.services), rt.cfg.proxmox.node)
    except config_mod.ConfigError as exc:
        # Start anyway and show the problem on the page. A dashboard that
        # refuses to boot tells you nothing; one that says "your token is
        # missing" tells you everything.
        rt.boot_error = str(exc)
        log.error("configuration problem: %s", exc)

    yield

    if rt.pve:
        await rt.pve.aclose()
    if rt.http:
        await rt.http.aclose()


app = FastAPI(title="dash.awruff.org", lifespan=lifespan)


@app.get("/api/state")
async def api_state():
    if rt.boot_error:
        return JSONResponse(
            {"errors": [rt.boot_error], "vitals": None, "groups": [],
             "containers": [], "workshop": {}, "generated_at": time.time()},
            status_code=200,
        )

    now = time.time()
    if rt.cache and (now - rt.cached_at) < CACHE_SECONDS:
        return rt.cache

    state = await build_state(rt.cfg, rt.pve, rt.http)
    state["site"] = {
        "title": rt.cfg.title,
        "subtitle": rt.cfg.subtitle,
        "poll_seconds": rt.cfg.poll_seconds,
    }
    rt.cache, rt.cached_at = state, now
    return state


@app.get("/api/health")
async def api_health():
    """For Uptime Kuma, and for answering 'is it the page or the data'."""
    return {"ok": rt.boot_error is None, "error": rt.boot_error}


@app.get("/", include_in_schema=False)
async def index():
    return HTMLResponse(rt.index_html)


app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")
