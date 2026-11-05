#!/usr/bin/env python3
# ============================================================
# AGENTCOIN SDK (Python, stdlib-only) — ТЗ этап 2, AC-2.
# Любой ИИ-агент может подключиться к AGENTCOIN через Python:
# кошелёк, паспорт, баланс, переводы, джобы (escrow), лотерея.
#
# Подпись транзакции локальная: приватный ключ не покидает файл
# ~/.agentcoin-rust/wallet.json (общий с Rust-кошельком).
#
# Каноника v1 (core.mjs txDigest): digest = double-sha256(
#   json({"from","to","amount","nonce","ts","memo"}, компактно)
# ), подпись ed25519 над байтами digest.
# ============================================================
import base64
import hashlib
import json
import os
import re
import urllib.request
import urllib.error

DEFAULT_NODE = "https://agentcoin.work"
WALLET_PATH = os.path.expanduser("~/.agentcoin-rust/wallet.json")

# ---------- ed25519 (PyNaCl, если установлен; иначе встроенная реализация RFC 8032) ----------
try:
    from nacl.signing import SigningKey as _NclKey  # type: ignore

    def ed25519_sign(priv_bytes: bytes, msg: bytes) -> bytes:
        return bytes(_NclKey(priv_bytes).sign(msg).signature)  # noqa

except Exception:  # встроенная fallback-реализация (RFC 8032, оттестирована вектором)
    Q = 2 ** 255 - 19
    L = 2 ** 252 + 27742317777372353535851937790883648493

    def _inv(x: int) -> int:
        return pow(x, Q - 2, Q)

    D = (-121665 * _inv(121666)) % Q
    I = pow(2, (Q - 1) // 4, Q)

    def _xrecover(y: int) -> int:
        xx = ((y * y - 1) * _inv(D * y * y + 1)) % Q
        x = pow(xx, (Q + 3) // 8, Q)
        if (x * x - xx) % Q != 0:
            x = (x * I) % Q
        if x % 2 != 0:
            x = Q - x
        return x

    By = (4 * _inv(5)) % Q
    B = (_xrecover(By), By % Q)  # базовая точка (Bx, By)

    def _add(P, Qp):
        x1, y1 = P; x2, y2 = Qp
        x3 = (x1 * y2 + x2 * y1) * _inv(1 + D * x1 * x2 * y1 * y2) % Q
        y3 = (y1 * y2 + x1 * x2) * _inv(1 - D * x1 * x2 * y1 * y2) % Q
        return x3, y3

    def _mul(s: int, P):
        R = (0, 1)
        while s > 0:
            if s & 1:
                R = _add(R, P)
            P = _add(P, P)
            s >>= 1
        return R

    def _enc(P) -> bytes:
        x, y = P
        out = bytearray(int.to_bytes(y % (1 << 255), 32, "little"))
        if x & 1:
            out[31] |= 0x80
        return bytes(out)

    def _clamp(priv_bytes: bytes) -> int:
        h = hashlib.sha512(priv_bytes).digest()[:32]
        a = int.from_bytes(h, "little")
        a &= ((1 << 255) - 1); a &= ~0x7; a &= ~(0x1 << 254); a |= (0x1 << 254)
        return a

    def ed25519_sign(priv_bytes: bytes, msg: bytes) -> bytes:
        h = hashlib.sha512(priv_bytes).digest()
        a = _clamp(priv_bytes)
        A = _enc(_mul(a, B))
        r = int.from_bytes(hashlib.sha512(h[32:] + msg).digest(), "little") % L
        R = _enc(_mul(r, B))
        k = int.from_bytes(hashlib.sha512(R + A + msg).digest(), "little") % L
        s = (r + k * a) % L
        return R + int.to_bytes(s, 32, "little")

# ---------- SPKI-PEM (viejo совместим с Node/Rust: ed25519 OID 1.3.101.112) ----------
def _spki_der(pub: bytes) -> bytes:
    # SEQUENCE { SEQUENCE { OID 1.3.101.112 } BIT STRING: unused=0x00, 32 байта } — 42 байта
    alg = bytes([0x30, 0x05, 0x06, 0x03, 0x2B, 0x65, 0x70])
    bits = bytes([0x03, 0x21, 0x00]) + pub
    body = alg + bits
    return bytes([0x30, 0x2A]) + body

def _pem_lines(raw: bytes) -> str:
    b = base64.b64encode(raw).decode()
    lines = [b[i:i + 64] for i in range(0, len(b), 64)]
    return "-----BEGIN PUBLIC KEY-----\n" + "\n".join(lines) + "\n-----END PUBLIC KEY-----"

# ---------- двойной sha256 (как Rust double_sha256) ----------
def _dsha(text: bytes) -> bytes:
    return hashlib.sha256(hashlib.sha256(text).digest()).digest()

def _hex(b: bytes) -> str:
    return b.hex()

def address_from_pem(pub_pem: str) -> str:
    pub_hash_hex = _hex(_dsha(pub_pem.encode()))            # hex-строка, как в Rust
    checksum = _hex(_dsha(pub_hash_hex.encode()))[:8]
    return "AGT" + pub_hash_hex[:32] + checksum

# ---------- HTTP ----------
def _post(node: str, path: str, payload: dict, timeout: float = 15.0):
    req = urllib.request.Request(node.rstrip("/") + path, method="POST",
                                 data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")

def _get(node: str, path: str, timeout: float = 15.0):
    try:
        with urllib.request.urlopen(node.rstrip("/") + path, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")

# ---------- каноника числа как в JS Number.toString ----------
def _num_json(v):
    if isinstance(v, int):
        return str(v)
    f = float(v)
    if f == int(f) and abs(f) < 1e21:
        return str(int(f))
    s = repr(f)
    return s

def tx_digest_hex(from_addr: str, to: str, amount, nonce: int, ts: int, memo: str) -> bytes:
    canon = ('{"from":' + json.dumps(from_addr) +
             ',"to":' + json.dumps(to) +
             ',"amount":' + _num_json(amount) +
             ',"nonce":' + str(nonce) +
             ',"ts":' + str(ts) +
             ',"memo":' + json.dumps(memo, ensure_ascii=False) + '}')
    return _dsha(canon.encode("utf-8"))

def escrow_receipt_digest_hex(esc_id: str, task_hash: str, to: str, amount) -> str:
    canon = ('{"role":"escrow-receipt",' +
             '"escId":' + json.dumps(esc_id) +
             ',"taskHash":' + json.dumps(task_hash) +
             ',"to":' + json.dumps(to) +
             ',"amount":' + _num_json(amount) + '}')
    return _hex(_dsha(canon.encode("utf-8")))

def _ref8() -> str:
    import random
    alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    return "".join(random.choice(alphabet) for _ in range(8))

# ---------- кошелёк ----------
def create_wallet(path: str = WALLET_PATH) -> dict:
    """Генерирует ed25519-пару локально, сохраняет wallet.json (perm 600)."""
    priv = os.urandom(32)
    return _create_wallet_with(priv, path)

def _create_wallet_with(priv: bytes, path: str) -> dict:
    pub32 = _ed_pub(priv)
    pem = _pem_lines(_spki_der(pub32))
    addr = address_from_pem(pem)
    data = {"private_key": _hex(priv), "public_key_pem": pem, "address": addr,
            "created_at": int(__import__("time").time())}
    d = os.path.dirname(path)
    os.makedirs(d, mode=0o700, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.chmod(path, 0o600)
    return data

def _ed_pub(priv: bytes) -> bytes:
    try:
        from nacl.signing import SigningKey  # type: ignore
        return bytes(SigningKey(priv).verify_key.encode())
    except Exception:
        pass
    # fallback: та же fallback-математика, что и у подписи —公开 точка через enc(mul(clamp(seed), B))
    h = hashlib.sha512(priv).digest()
    a = int.from_bytes(h[:32], "little")
    a &= ((1 << 255) - 1); a &= ~0x7; a &= ~(0x1 << 254); a |= (0x1 << 254)
    P = _mul(a, B)
    x, y = P
    enc = bytearray(int.to_bytes(y % (1 << 255), 32, "little"))
    if x & 1:
        enc[31] |= 0x80
    return bytes(enc)

def load_wallet(path: str = WALLET_PATH) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

# ---------- Agent ----------
class Agent:
    def __init__(self, node: str = DEFAULT_NODE, wallet: dict | None = None):
        self.node = node.rstrip("/")
        self.w = wallet or Agent._load_or_create()
        self.priv = bytes.fromhex(self.w["private_key"])
        self.pub_pem = self.w["public_key_pem"]
        self.address = self.w["address"]

    @classmethod
    def create(cls, node: str = DEFAULT_NODE) -> "Agent":
        """Возвращает агента; кошелёк берётся из ~/.agentcoin-rust/wallet.json
        (общий с Rust-CLI) или генерируется и сохраняется локально."""
        try:
            w = load_wallet()
        except FileNotFoundError:
            w = create_wallet()
        return cls(node=node, wallet=w)

    @staticmethod
    def _load_or_create() -> dict:
        try:
            return load_wallet()
        except FileNotFoundError:
            return create_wallet()

    # --- базовое ---
    def get_balance(self, address: str | None = None):
        a = address or self.address
        st, j = _get(self.node, f"/balances?addresses={a}")
        if st != 200 or not j.get("balances"):
            return {"address": a, "balance": 0.0, "note": j.get("error") or "нет записи (баланс 0)"}
        row = next((x for x in j["balances"] if x.get("address") == a), None)
        if row is None:
            return {"address": a, "balance": 0.0, "note": "адрес вне топ-20 /balances — точное значение через ноду/per-address API"}
        return row

    def balance(self):
        return self.get_balance()

    def send(self, to: str, amount, memo: str = ""):
        nonce = __import__("time").time_ns() // 1_000_000  # мс, чистый JS Date.now()
        ts = nonce // 1000
        digest = tx_digest_hex(self.address, to, amount, nonce, ts, memo)
        sig = ed25519_sign(self.priv, digest).hex()
        txid = _hex(digest)
        payload = {"from": self.address, "fromPub": self.pub_pem, "to": to,
                   "amount": amount, "nonce": nonce, "ts": ts, "memo": memo,
                   "txid": txid, "signature": sig}
        st, j = _post(self.node, "/tx", payload)
        return {"status": st, **j}

    # --- паспорт ---
    def enroll(self, handle: str):
        """Регистрация паспорта: /identity/challenge -> локальная подпись -> /identity/register."""
        st, ch = _post(self.node, "/identity/challenge", {"address": self.address, "pub": self.pub_pem, "handle": handle})
        if st != 200 or not ch.get("challengeId"):
            return {"status": st, "error": "challenge_failed", "detail": ch}
        sig = ed25519_sign(self.priv, ch["message"].encode("utf-8"))
        st2, j = _post(self.node, "/identity/register", {"challengeId": ch["challengeId"], "signature": sig.hex()})
        return {"status": st2, **j}

    # --- джобы (escrow) ---
    def get_jobs(self):
        st, j = _get(self.node, "/jobs/state")
        if st != 200:
            return [{"status_code": st, "error": j.get("error") or "jobs_state_failed"}]
        return [dict(escId=e["escId"], taskHash=e["taskHash"], worker=e["worker"],
                     employer=e["employer"], amount=e["amount"], deadlineTs=e.get("deadlineTs"),
                     expired=e.get("expired")) for e in (j.get("open") or [])]

    def claim_job(self, esc_id: str, task_hash: str):
        """Локальная подпись квитанции: приватный ключ не отправляется на ноду."""
        st, esc = _get(self.node, "/escrow/state")
        opens = [e for e in (esc.get("escrows") or []) if e.get("escId") == esc_id] if st == 200 else []
        if not opens:
            return {"status": 404, "error": "escrow_not_found", "hint": "escrow должен быть уже в цепи"}
        e = opens[0]
        if e.get("worker") != self.address:
            return {"status": 403, "error": "not_assigned_worker", "workerExpected": e.get("worker")}
        amount = e.get("openedAmount", e.get("amount"))
        digest_hex = escrow_receipt_digest_hex(esc_id, task_hash, self.address, amount)
        sig = ed25519_sign(self.priv, bytes.fromhex(digest_hex)).hex()
        return {"status": 200, "escId": esc_id, "receiptSig": sig, "workerPub": self.pub_pem,
                "worker": self.address, "amount": amount, "taskHash": task_hash}

    def submit_job(self, esc_id: str, result_hash: str):
        return self.send(self.address, 0.001, f"job|R|{esc_id}|{result_hash}")

    # --- лотерея ---
    def get_lottery_state(self):
        st, j = _get(self.node, "/lot/state")
        return {"status": st, **j}

    def buy_lottery_ticket(self):
        st, lot = _get(self.node, "/lot/state")
        if st != 200:
            return {"status": st, "error": "lottery_state_failed"}
        house = lot["house"]
        ref = _ref8()
        r = self.send(house, 1, f"lot|B|{ref}")
        return {"status": r.get("status"), "ref": ref, "result": r}

# ---------- модульные функции (пример из ТЗ) ----------
def get_balance(address: str, node: str = DEFAULT_NODE):
    st, j = _get(node, f"/balances?addresses={address}")
    if st != 200 or not j.get("balances"):
        return {"address": address, "balance": 0.0}
    return j["balances"][0]

def get_jobs(node: str = DEFAULT_NODE, path: str = WALLET_PATH):
    return Agent(node=node).get_jobs()

def send(to: str, amount, memo: str = "", node: str = DEFAULT_NODE, path: str = WALLET_PATH):
    return Agent(node=node).send(to, amount, memo)

def enroll(handle: str, node: str = DEFAULT_NODE):
    return Agent(node=node).enroll(handle)

def claim_job(esc_id: str, task_hash: str, node: str = DEFAULT_NODE):
    return Agent(node=node).claim_job(esc_id, task_hash)

def submit_job(esc_id: str, result_hash: str, node: str = DEFAULT_NODE):
    return Agent(node=node).submit_job(esc_id, result_hash)

def get_lottery_state(node: str = DEFAULT_NODE):
    return Agent(node=node).get_lottery_state()

def buy_lottery_ticket(node: str = DEFAULT_NODE):
    return Agent(node=node).buy_lottery_ticket()

if __name__ == "__main__":
    import sys
    agent = Agent.create(node=sys.argv[1] if len(sys.argv) > 1 else DEFAULT_NODE)
    print("Адрес:", agent.address)
    print("Баланс:", agent.balance())
