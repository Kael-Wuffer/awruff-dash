"""Loading and validating config.yaml.

Everything the dashboard shows that a machine cannot work out for itself
lives in config.yaml. Everything it CAN work out — which containers exist,
how much memory they are using — comes from the Proxmox API at runtime.

That split is deliberate. It is what stops this dashboard rotting as the
lab grows: build a new container and it appears on the page by itself.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

import yaml


class ConfigError(Exception):
    """Raised with a message meant to be read by a human at 11pm."""


@dataclass
class ProxmoxConfig:
    url: str
    node: str
    token_id: str
    token_secret: str
    verify_ssl: bool = False


@dataclass
class Service:
    """One tile on the LAB tab."""

    name: str
    group: str
    abbr: str = "??"
    href: str = ""
    desc: str = ""
    # Which container this service runs in. Several services may share one
    # vmid (Grafana, Netdata and Prometheus all live in CT105); only the
    # first one listed shows the container's CPU and memory, so the same
    # numbers are not repeated across three tiles.
    vmid: int | None = None
    # URL to request to measure response time. Empty means no check at all,
    # which is the right answer for things like iLO that cannot be reached
    # from in here — see the vault.
    check: str = ""
    note: str = ""
    show_stats: bool = True


@dataclass
class Config:
    title: str
    subtitle: str
    proxmox: ProxmoxConfig
    groups: list[str]
    services: list[Service]
    unclaimed_group: str
    threads: list[dict] = field(default_factory=list)
    reference: list[dict] = field(default_factory=list)
    before_you_build: list[dict] = field(default_factory=list)
    ip_prefix: str = ""
    poll_seconds: int = 10


def _require(mapping: dict, key: str, where: str):
    if key not in mapping:
        raise ConfigError(f"config.yaml: {where} is missing required key '{key}'")
    return mapping[key]


def load(path: str | Path = "config.yaml") -> Config:
    path = Path(path)
    if not path.exists():
        raise ConfigError(
            f"No config file at {path.resolve()}. "
            "Copy config.example.yaml to config.yaml and edit it."
        )

    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}

    site = raw.get("site") or {}
    pve_raw = _require(raw, "proxmox", "top level")

    # Credentials come from the environment, never the config file. The
    # config file is in git; the environment is not.
    token_id = os.environ.get("PROXMOX_TOKEN_ID", "")
    token_secret = os.environ.get("PROXMOX_TOKEN_SECRET", "")
    if not token_id or not token_secret:
        raise ConfigError(
            "PROXMOX_TOKEN_ID and PROXMOX_TOKEN_SECRET must both be set in the "
            "environment. See .env.example. The token id looks like "
            "'root@pam!homepage'; the secret is in Bitwarden."
        )

    proxmox = ProxmoxConfig(
        url=_require(pve_raw, "url", "proxmox").rstrip("/"),
        node=_require(pve_raw, "node", "proxmox"),
        token_id=token_id,
        token_secret=token_secret,
        verify_ssl=bool(pve_raw.get("verify_ssl", False)),
    )

    groups = list(raw.get("groups") or [])
    unclaimed = raw.get("unclaimed_group", "UNSORTED")
    if unclaimed not in groups:
        groups.append(unclaimed)

    services: list[Service] = []
    for i, entry in enumerate(raw.get("services") or []):
        if not isinstance(entry, dict):
            raise ConfigError(f"config.yaml: services[{i}] is not a mapping")
        name = _require(entry, "name", f"services[{i}]")
        group = entry.get("group", unclaimed)
        if group not in groups:
            raise ConfigError(
                f"config.yaml: service '{name}' is in group '{group}', which is "
                f"not in the groups list. Known groups: {', '.join(groups)}"
            )
        vmid = entry.get("vmid")
        services.append(
            Service(
                name=name,
                group=group,
                abbr=str(entry.get("abbr", name[:2].upper()))[:3],
                href=entry.get("href", ""),
                desc=entry.get("desc", ""),
                vmid=int(vmid) if vmid is not None else None,
                check=entry.get("check", ""),
                note=entry.get("note", ""),
                show_stats=bool(entry.get("show_stats", True)),
            )
        )

    workshop = raw.get("workshop") or {}

    return Config(
        title=site.get("title", "AWRUFF"),
        subtitle=site.get("subtitle", "HOMELAB CONTROL"),
        proxmox=proxmox,
        groups=groups,
        services=services,
        unclaimed_group=unclaimed,
        threads=list(workshop.get("threads") or []),
        reference=list(workshop.get("reference") or []),
        before_you_build=list(workshop.get("before_you_build") or []),
        ip_prefix=str(raw.get("ip_prefix", "")),
        poll_seconds=int(site.get("poll_seconds", 10)),
    )
