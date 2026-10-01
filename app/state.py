"""Turning Proxmox's answers into the shape the page wants.

One function, build_state(), returns the entire payload the front end
renders. Keeping it in one place means the page never has to know where a
number came from, and a new data source later is a change in here only.
"""

from __future__ import annotations

import asyncio
import time

import httpx

from .config import Config, Service
from .proxmox import Proxmox, ProxmoxError

GIB = 1024 ** 3
GB = 1000 ** 3


def _pct(used, total) -> float:
    try:
        if not total:
            return 0.0
        return round(used / total * 100, 1)
    except (TypeError, ZeroDivisionError):
        return 0.0


async def _measure(client: httpx.AsyncClient, url: str) -> dict:
    """Request a URL and report how long it took.

    Any 2xx/3xx/4xx answer counts as up: a 401 from a login page means the
    service is alive and talking, which is the question being asked. Only a
    connection failure or a timeout counts as down.
    """
    started = time.perf_counter()
    try:
        r = await client.get(url, follow_redirects=False)
    except httpx.TimeoutException:
        return {"status": "TIMEOUT", "tone": "bad", "ms": None}
    except httpx.HTTPError:
        return {"status": "DOWN", "tone": "bad", "ms": None}
    ms = int((time.perf_counter() - started) * 1000)
    if r.status_code >= 500:
        return {"status": str(r.status_code), "tone": "bad", "ms": ms}
    return {"status": "UP", "tone": "good", "ms": ms}


def _vitals(node: dict, storages: list[dict]) -> dict:
    cpu = round((node.get("cpu") or 0) * 100, 1)
    mem = node.get("memory") or {}
    mem_used = mem.get("used") or 0
    mem_total = mem.get("total") or 0
    loadavg = node.get("loadavg") or ["0", "0", "0"]
    cores = (node.get("cpuinfo") or {}).get("cpus") or 1

    pools = []
    for s in storages:
        total = s.get("total") or 0
        if not total:
            continue
        pools.append({
            "name": s.get("storage"),
            "type": s.get("type"),
            "used": s.get("used") or 0,
            "total": total,
            "pct": _pct(s.get("used"), total),
            "free_gb": round((total - (s.get("used") or 0)) / GB, 1),
            "total_gb": round(total / GB, 1),
        })
    pools.sort(key=lambda p: p["total"], reverse=True)

    def find(*names):
        for n in names:
            for p in pools:
                if p["name"] == n:
                    return p
        return None

    return {
        "cpu_pct": cpu,
        "mem_pct": _pct(mem_used, mem_total),
        "mem_free_gib": round((mem_total - mem_used) / GIB, 1),
        "mem_total_gib": round(mem_total / GIB, 1),
        "load1": float(loadavg[0]) if loadavg else 0.0,
        "load_pct": min(100.0, round(float(loadavg[0]) / max(cores, 1) * 100, 1)) if loadavg else 0.0,
        "cores": cores,
        "uptime_days": round((node.get("uptime") or 0) / 86400, 1),
        "pools": pools,
        # The two that matter most, pulled out by name so the page does not
        # have to guess. 'local-lvm' is the thin pool every container's disk
        # is carved out of; it is overcommitted and worth watching.
        "thin_pool": find("local-lvm", "local-zfs", "data"),
        "vault": find("storage-vault"),
    }


def _guest_index(guests: list[dict]) -> dict[int, dict]:
    out = {}
    for g in guests:
        vmid = g.get("vmid")
        if vmid is None:
            continue
        maxmem = g.get("maxmem") or 0
        out[int(vmid)] = {
            "vmid": int(vmid),
            "name": g.get("name") or f"CT{vmid}",
            "type": g.get("type"),
            "running": g.get("status") == "running",
            "cpu_pct": round((g.get("cpu") or 0) * 100, 1),
            "mem_pct": _pct(g.get("mem"), maxmem),
            "mem_used_gib": round((g.get("mem") or 0) / GIB, 2),
            "maxmem_gib": round(maxmem / GIB, 2),
            "uptime_days": round((g.get("uptime") or 0) / 86400, 1),
        }
    return out


def _service_payload(svc: Service, guest: dict | None, check: dict | None,
                     owns_stats: bool) -> dict:
    if check is not None:
        status, tone, ms = check["status"], check["tone"], check["ms"]
    elif guest is not None:
        status = "RUNNING" if guest["running"] else "STOPPED"
        tone = "good" if guest["running"] else "bad"
        ms = None
    else:
        status, tone, ms = "LINK", "muted", None

    bars = []
    if guest and owns_stats and svc.show_stats and guest["running"]:
        bars = [
            {"label": "CPU", "pct": guest["cpu_pct"]},
            {"label": "MEM", "pct": guest["mem_pct"]},
        ]

    return {
        "name": svc.name,
        "abbr": svc.abbr,
        "href": svc.href,
        "desc": svc.desc,
        "note": svc.note,
        "vmid": svc.vmid,
        "status": status,
        "tone": tone,
        "ms": ms,
        "bars": bars,
    }


async def build_state(cfg: Config, pve: Proxmox, http: httpx.AsyncClient) -> dict:
    errors: list[str] = []

    try:
        node, guests, storages, nextid = await asyncio.gather(
            pve.node_status(), pve.guests(), pve.storage(), pve.next_vmid()
        )
    except ProxmoxError as exc:
        # A dashboard that goes blank when one source is unhappy is worse
        # than one that says what is wrong. Render the page either way.
        return {
            "generated_at": time.time(),
            "node": cfg.proxmox.node,
            "errors": [str(exc)],
            "vitals": None,
            "groups": [],
            "containers": [],
            "workshop": {"threads": cfg.threads, "reference": cfg.reference,
                         "before_you_build": cfg.before_you_build},
        }

    index = _guest_index(guests)

    checks: dict[str, dict] = {}
    targets = [s.check for s in cfg.services if s.check]
    if targets:
        results = await asyncio.gather(*[_measure(http, t) for t in targets])
        checks = dict(zip(targets, results))

    # The first service listed for a vmid is the one that shows that
    # container's CPU and memory. Three tiles on CT105 reporting identical
    # numbers reads as a bug even though it is correct.
    claimed: set[int] = set()
    stats_owner: dict[int, str] = {}
    for svc in cfg.services:
        if svc.vmid is None:
            continue
        claimed.add(svc.vmid)
        stats_owner.setdefault(svc.vmid, svc.name)

    by_group: dict[str, list[dict]] = {g: [] for g in cfg.groups}
    for svc in cfg.services:
        guest = index.get(svc.vmid) if svc.vmid is not None else None
        if svc.vmid is not None and guest is None:
            errors.append(
                f"'{svc.name}' points at VMID {svc.vmid}, which Proxmox does not "
                "have. Renamed, destroyed, or a typo in config.yaml."
            )
        by_group[svc.group].append(
            _service_payload(
                svc, guest,
                checks.get(svc.check) if svc.check else None,
                owns_stats=(svc.vmid is not None and stats_owner.get(svc.vmid) == svc.name),
            )
        )

    # Auto-discovery: anything Proxmox knows about that no service claims.
    # This is the bit that keeps the page honest as the lab grows.
    for vmid, guest in sorted(index.items()):
        if vmid in claimed:
            continue
        by_group[cfg.unclaimed_group].append({
            "name": guest["name"],
            "abbr": str(vmid)[-2:],
            "href": "",
            "desc": f"{guest['type']} {vmid} — not in config.yaml yet",
            "note": "",
            "vmid": vmid,
            "status": "RUNNING" if guest["running"] else "STOPPED",
            "tone": "good" if guest["running"] else "muted",
            "ms": None,
            "bars": [
                {"label": "CPU", "pct": guest["cpu_pct"]},
                {"label": "MEM", "pct": guest["mem_pct"]},
            ] if guest["running"] else [],
        })

    groups = [
        {"label": label, "items": items, "count": f"{len(items):02d}"}
        for label, items in by_group.items() if items
    ]

    vitals = _vitals(node, storages)
    running = [g for g in index.values() if g["running"]]

    used_ips = sorted({int(v) for v in []})  # reserved for a later ARP sweep
    workshop = {
        "next_vmid": nextid,
        "next_ip": None,
        "ip_prefix": cfg.ip_prefix,
        "threads": cfg.threads,
        "reference": cfg.reference,
        "before_you_build": cfg.before_you_build,
        "capacity": {
            "disk_free_gb": vitals["vault"]["free_gb"] if vitals["vault"] else None,
            "mem_free_gib": vitals["mem_free_gib"],
            "thin_pool_pct": vitals["thin_pool"]["pct"] if vitals["thin_pool"] else None,
        },
    }

    return {
        "generated_at": time.time(),
        "node": cfg.proxmox.node,
        "errors": errors,
        "vitals": vitals,
        "groups": groups,
        "containers": sorted(index.values(), key=lambda g: g["vmid"]),
        "running_count": len(running),
        "total_count": len(index),
        "workshop": workshop,
    }
