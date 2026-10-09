"""The agent's only connection to the outside: Supabase RPC calls with the device token.

The agent never holds a service key and cannot read any table directly. The
database functions it calls check the token and only touch this device's jobs.
"""

from __future__ import annotations

from typing import Any

import httpx

from . import VERSION


class ApiError(Exception):
    pass


class DeviceApi:
    def __init__(self, url: str, key: str, token: str, timeout: float = 20.0):
        self._token = token
        self._http = httpx.Client(
            base_url=f"{url}/rest/v1/rpc/",
            headers={"apikey": key, "Content-Type": "application/json", "User-Agent": f"jarvis-agent/{VERSION}"},
            timeout=timeout,
        )

    def _call(self, fn: str, payload: dict[str, Any]) -> Any:
        try:
            res = self._http.post(fn, json={"p_token": self._token, **payload})
        except httpx.HTTPError as exc:
            raise ApiError(f"network: {exc.__class__.__name__}") from exc
        if res.status_code >= 400:
            try:
                message = res.json().get("message", res.text)
            except ValueError:
                message = res.text
            if "invalid device token" in message:
                raise ApiError("This device was removed or its token is wrong. Pair it again from Settings > Devices.")
            raise ApiError(f"{fn} failed ({res.status_code}): {message[:300]}")
        return res.json() if res.content else None

    def hello(self, platform: str, manifest: list[dict[str, Any]]) -> dict[str, Any]:
        return self._call("agent_hello", {"p_platform": platform, "p_version": VERSION, "p_manifest": manifest})

    def claim(self, max_jobs: int) -> list[dict[str, Any]]:
        return self._call("agent_claim", {"p_max": max_jobs}) or []

    def log(self, job_id: str, kind: str, text: str) -> None:
        self._call("agent_log", {"p_job_id": job_id, "p_kind": kind, "p_text": text[:4000]})

    def finish(self, job_id: str, ok: bool, result: Any = None, error: str | None = None) -> None:
        self._call("agent_finish", {"p_job_id": job_id, "p_ok": ok, "p_result": result, "p_error": error})

    def status(self, job_id: str) -> str | None:
        return self._call("agent_job_status", {"p_job_id": job_id})

    def close(self) -> None:
        self._http.close()
