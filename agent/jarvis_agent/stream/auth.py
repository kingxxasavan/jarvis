"""Short-lived passes for the stream, signed by the website and checked here.

A pass is base64url(json payload) + "." + base64url(HMAC-SHA256(secret, payload)).
The secret is created fresh each time the agent starts and published only to the
owner's device row, so a leaked pass expires in minutes and a restart revokes all.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time


def new_secret() -> str:
    return secrets.token_urlsafe(32)


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def sign(secret: str, scope: str, ttl: int = 600) -> str:
    """Only used by tests; the website mints passes in web/src/lib/stream.ts."""
    payload = _b64(json.dumps({"s": scope, "e": int(time.time()) + ttl, "n": secrets.token_hex(6)}).encode())
    mac = _b64(hmac.new(secret.encode(), payload.encode(), hashlib.sha256).digest())
    return f"{payload}.{mac}"


def verify(secret: str, token: str | None, scope: str) -> bool:
    if not token or token.count(".") != 1:
        return False
    payload, mac = token.split(".")
    expected = _b64(hmac.new(secret.encode(), payload.encode(), hashlib.sha256).digest())
    if not hmac.compare_digest(expected, mac):
        return False
    try:
        data = json.loads(_unb64(payload))
    except (ValueError, json.JSONDecodeError):
        return False
    return data.get("s") == scope and isinstance(data.get("e"), int) and data["e"] >= time.time()
