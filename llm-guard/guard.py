#!/usr/bin/env python3
# ============================================================
# llm-trust-guard — Уровень 1 «Департамента Юстиции» AGENTCOIN (AGIP-22)
# Периметр: проверяет входящий TEXT Naznachenija (chat / memo / заявки gov)
# на промпт-инъекции, попытки вывести системный промпт, закодированные атаки.
# Рекомендация из ТЗ (open) — наружная проверка llm-trust-guard; здесь
# сделан самонесущий эвристический сканер: честный fail-open только
# по недоступности сервиса (нода сама решает, что делать с text).
# Запуск: systemd agentcoin-guard.service (127.0.0.1:8081)
# ============================================================
import base64
import json
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 8081
MAX_TEXT_LEN = 4000

# (score, компилированный regex, категория угрозы)
RULES = [
    (3, re.compile(r"игнор(ируй|ь)[^.\n]{0,30}(все|превые|прежние|rules|инструкции)|ignore\s+(all|any|the)\s+(previous|above|prior|original)\s+(instructions|rules|prompts?)", re.I), "Prompt Injection"),
    (3, re.compile(r"(disregard|forget|erace|забудь|удали)[^.\n]{0,30}(instructions|rules|prompt|правила|инструкции)", re.I), "Prompt Injection"),
    (3, re.compile(r"(reveal|show|print|give me|выведи|раскрой|напечатай)[^.\n]{0,30}(system\s*prompt|system\s*instructions|тво(и|й)\s*инструкции|initial\s*prompt)", re.I), "System Prompt Exfiltration"),
    (3, re.compile(r"(you are|ты теперь|pretend|acting as|roleplay as|смотри: ты)\s+(a|an|the|now|языком)?\s*(admin|operator|developer|root|system|системн(ый|ая)|админ|оператор)", re.I), "Role Hijack"),
    (3, re.compile(r"(переведи|выведи|отправь|transfer|send|withdraw)[^.\n]{0,50}(все|всё|важ|all|everything|entire)[^.\n]{0,20}(AGT|funds|средства|баланс|balance|treasury|казн)", re.I), "Fund Exfiltration"),
    (2, re.compile(r"(drain|сли[йв]| украсть|steal|похитить)[^.\n]{0,20}(treasury|казн|funds|кошел)", re.I), "Fund Exfiltration"),
    (2, re.compile(r"(eval|exec|system)\s*\(|rm\s+-rf|curl[^|\n]{0,60}\|\s*(sh|bash)|powershell(\.exe)?\s+[-\w]|nc\s+-e\s+/bin/(sh|bash)", re.I), "Code Execution"),
    (2, re.compile(r"<script|onerror\s*=|javascript:\s*|document\.cookie|localStorage\.\w+\s*=", re.I), "XSS Payload"),
    (2, re.compile(r"(доступ|дай|access|grant)[^.\n]{0,40}(root|admin|суперпользоват|\badmin\b|operator\s*panel|x-admin-token)", re.I), "Privilege Escalation"),
    (2, re.compile(r"(забудь|drop)\s+(все\s+)?(_conditions|conditions|constraints|ограничения)", re.I), "Prompt Injection"),
]

B64_RE = re.compile(r"[A-Za-z0-9+/=]{40,}")
HEX_RE = re.compile(r"\\x[0-9a-f]{2}", re.I)


def decode_reward(text: str):
    """Пытается найти закодированную атаку (Encoding Bypass)."""
    m = B64_RE.search(text)
    if m:
        try:
            dec = base64.b64decode(m.group(0) + "=="[: len(m.group(0)) % 4]).decode("utf-8", "ignore")
            if dec and len(dec) > 8:
                return dec
        except Exception:
            pass
    return None


def check_text(text: str):
    text = text or ""
    if len(text) > MAX_TEXT_LEN:
        text = text[:MAX_TEXT_LEN]
    score = 0
    threats = []
    for pts, rx, cat in RULES:
        if rx.search(text):
            score += pts
            if cat not in threats:
                threats.append(cat)
    decoded = decode_reward(text)
    explicit_hidden = False
    if decoded:
        d_score = 0
        for pts, rx, cat in RULES:
            if rx.search(decoded):
                d_score += pts
        if d_score > 0:
            score += d_score + 2  # прятать атаку в base64 — сам по себе признак
            explicit_hidden = True
            threats.append("Encoding Bypass")
    if HEX_RE.search(text) and ("code" in threats or len(text) > 300):
        score += 1
        threats.append("Encoding Bypass")
    category = threats[0] if threats else "clean"
    if score < 3:
        allowed, threat = True, None
        if threats:
            threat = "Suspicious: " + category  # мягкое предупреждение (не блокируем)
    else:
        allowed, threat = False, (f"{category} (score={score})" + (" [hidden]" if explicit_hidden else ""))
    return {
        "allowed": allowed,
        "threat": threat,
        "category": None if allowed else category,
        "score": score,
        "threats": threats,
        "checked_len": len(text),
        "ts": int(time.time()),
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # тихий лог: только в stderr journald
        sys.stderr.write("[llm-trust-guard] " + (fmt % args) + "\n")

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": True, "service": "llm-trust-guard", "port": PORT, "rules": len(RULES), "ts": int(time.time())})
        else:
            self._json(404, {"error": "not_found"})

    def do_POST(self):
        if self.path != "/check":
            return self._json(404, {"error": "not_found"})
        try:
            ln = int(self.headers.get("Content-Length", "0") or 0)
            raw = self.rfile.read(min(ln, 64 * 1024))
            data = json.loads(raw.decode("utf-8", "ignore") or "{}")
        except Exception:
            return self._json(400, {"error": "bad_body"})
        text = data.get("text", "")
        if isinstance(text, (dict, list)) or text is None:
            text = json.dumps(text)
        result = check_text(str(text))
        result["source"] = str(data.get("source", "unknown"))[:32]
        self._json(200, result)


if __name__ == "__main__":
    sys.stderr.write(f"[llm-trust-guard] LISTEN 127.0.0.1:{PORT} rules={len(RULES)}\n")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
