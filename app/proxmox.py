"""A very small read-only Proxmox API client.

Only the four endpoints the dashboard needs. The token this uses has the
PVEAuditor role, which cannot start, stop, or change anything — so the worst
a bug in here can do is show you a wrong number.
"""

from __future__ import annotations

import httpx


class ProxmoxError(Exception):
    pass


class Proxmox:
    def __init__(self, url: str, node: str, token_id: str, token_secret: str,
                 verify_ssl: bool = False, timeout: float = 6.0):
        self.url = url.rstrip("/")
        self.node = node
        self._client = httpx.AsyncClient(
            base_url=f"{self.url}/api2/json",
            headers={"Authorization": f"PVEAPIToken={token_id}={token_secret}"},
            verify=verify_ssl,
            timeout=timeout,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _get(self, path: str, **params):
        try:
            r = await self._client.get(path, params=params or None)
        except httpx.HTTPError as exc:
            # httpx connection errors often stringify to nothing at all, which
            # produces a message ending in a colon and no cause. The class name
            # is the useful part: ConnectError means no route or nothing
            # listening, ConnectTimeout means something swallowed the packets.
            detail = str(exc).strip() or type(exc).__name__
            raise ProxmoxError(
                f"could not reach Proxmox at {self.url} — {detail}"
            ) from exc

        if r.status_code == 401:
            raise ProxmoxError(
                "Proxmox rejected the token (401). The id or secret is wrong."
            )
        if r.status_code == 403:
            raise ProxmoxError(
                "Proxmox accepted the token but refused this request (403). "
                "The token is probably missing its PVEAuditor grant: "
                "pveum acl modify / --tokens '<id>' --roles PVEAuditor"
            )
        if r.status_code >= 400:
            raise ProxmoxError(f"Proxmox returned {r.status_code} for {path}")

        return r.json().get("data")

    async def node_status(self) -> dict:
        """CPU, memory and uptime for the host itself."""
        return await self._get(f"/nodes/{self.node}/status") or {}

    async def guests(self) -> list[dict]:
        """Every VM and container, running or not.

        This is the auto-discovery. Nothing here is configured anywhere —
        if it exists in Proxmox, it turns up.

        An empty list from a token that authenticated usually means the ACL
        is missing rather than that you have no containers; see _get's 403
        note, which Proxmox does not always bother to send.
        """
        data = await self._get("/cluster/resources", type="vm") or []
        return [g for g in data if g.get("type") in ("lxc", "qemu")]

    async def storage(self) -> list[dict]:
        """Every storage pool with used/total bytes."""
        return await self._get(f"/nodes/{self.node}/storage") or []

    async def next_vmid(self) -> int | None:
        """The ID Proxmox itself would hand out next."""
        try:
            value = await self._get("/cluster/nextid")
            return int(value) if value is not None else None
        except (ProxmoxError, TypeError, ValueError):
            return None
