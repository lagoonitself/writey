import hashlib
import hmac
import secrets
import time

from .store import Store

MAX_FAILURES = 5


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class Pairing:
    """
    The browser pairs once by typing a six-digit code that the Helper shows on screen.
    It gets back a token it sends on every request. Only token hashes are stored.
    """

    def __init__(self, store: Store) -> None:
        self.store = store
        self.failures = 0
        self.code = self._new_code()

    @staticmethod
    def _new_code() -> str:
        return f"{secrets.randbelow(10**6):06d}"

    @property
    def locked(self) -> bool:
        return self.failures >= MAX_FAILURES

    def pair(self, code: str, origin: str) -> str | None:
        if self.locked:
            return None
        if not hmac.compare_digest(code.strip().replace(" ", ""), self.code):
            self.failures += 1
            return None
        token = secrets.token_urlsafe(32)
        data = self.store.read("pairing") or {"tokens": []}
        data["tokens"].append({"hash": _hash(token), "origin": origin, "created": int(time.time())})
        self.store.write("pairing", data)
        self.code = self._new_code()  # one use per code
        return token

    def check(self, token: str) -> bool:
        if not token:
            return False
        want = _hash(token)
        tokens = (self.store.read("pairing") or {}).get("tokens", [])
        return any(hmac.compare_digest(t.get("hash", ""), want) for t in tokens)
