#!/usr/bin/env python3
"""Onboard-агент AGENTCOIN: создаёт агента, берёт задачу эскроу, выполняет, получает оплату.
Всё — только через сайт https://agentcoin.work (агент не знает нод).
Шаги: /join → /escrow/create → (майнинг) → /escrow/claim → /escrow/payout → (майнинг) → /balance.
Использование: python3 onboard_agent.py [employer_address] [amount]
"""
import json
import sys
import time
import urllib.request

BASE = "https://agentcoin.work"
EMPLOYER = sys.argv[1] if len(sys.argv) > 1 else "AGT0baeb66fd048b34243f861af00e09b9c683c3dc2"
AMOUNT = float(sys.argv[2]) if len(sys.argv) > 2 else 10.0


def call(method, path, payload=None, timeout=60):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(BASE + path, data=data,
                                 headers={"Content-Type": "application/json"},
                                 method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode())
    except Exception as e:
        try:
            return getattr(e, "code", "?"), json.loads(e.read().decode())
        except Exception:
            return getattr(e, "code", "?"), {"raw_error": str(e)[:200]}


def curl_equiv(method, path, payload):
    p = json.dumps(payload, ensure_ascii=False)
    return f"curl -s -X {method} {BASE}{path} -H 'Content-Type: application/json' -d '{p}'"


def wait_for(desc, fn, timeout=600, step=15):
    t0 = time.time()
    while time.time() - t0 < timeout:
        ok, info = fn()
        if ok:
            return info
        print(f"  ... жду {desc} ({int(time.time() - t0)}с): {str(info)[:100]}", flush=True)
        time.sleep(step)
    raise SystemExit(f"TIMEOUT: {desc}")


print("== 1. Создание агента: кошелёк + паспорт (node make-agent.mjs через сайт)")
import subprocess
label = "onboard-%s" % int(time.time() % 100000)
mk = subprocess.run(["node", "make-agent.mjs", label], capture_output=True, text=True,
                    cwd=".", timeout=90)
assert mk.returncode == 0, f"make-agent failed: {mk.stderr[:300]}"
agent = json.loads(mk.stdout)
worker, worker_key = agent["address"], agent["privKey"]
cred_file = "onboard-cred-%s.json" % label
json.dump(agent, open(cred_file, "w"))
print("   ключи сохранены:", cred_file, "(НЕ коммитить)")
print("   АГЕНТ:", worker, "handle:", agent["handle"], "(паспорт 201)")
print("   CURL1: curl -s -X POST $BASE/identity/challenge -d '{address,pub,handle}'")
print("   CURL2: curl -s -X POST $BASE/identity/register -d '{challengeId,signature}'")

print("== 2. Баланс работодателя до:", EMPLOYER[:16])
st, bal0 = call("POST", "/balance", {"address": EMPLOYER})
print("   HTTP", st, "->", bal0)

import secrets as _secrets
task = _secrets.token_hex(16)
print(f"== 3. Задача от казны: POST /escrow/create (10 AGT, task={task})")
payload = {"employer": EMPLOYER, "worker": worker, "amount": AMOUNT,
           "taskHash": task, "deadlineSec": 3600}
st, esc = call("POST", "/escrow/create", payload)
print("   HTTP", st, "->", json.dumps(esc, ensure_ascii=False)[:300])
assert st == 201 and esc.get("escId"), f"escrow/create failed: {esc}"
esc_id = esc["escId"]
print("   ESCROW_ID:", esc_id)
print("   CURL:", curl_equiv("POST", "/escrow/create", dict(payload, taskHash="<ts>")))

print("== 4+5. Жду упаковку эскроу и снимаю квитанцию: POST /escrow/claim в цикле")
print("   (404 = ещё не в цепи; claim ничего не тратит)")
def try_claim():
    st, claim = call("POST", "/escrow/claim",
                      {"escId": esc_id, "taskHash": task, "workerPrivKey": worker_key})
    if st == 200 and claim.get("receiptSig"):
        return True, claim
    return False, claim.get("error", claim)
claim = wait_for("эскроу в цепи + квитанция", try_claim, timeout=900)
print("   КВИТАНЦИЯ OK:", json.dumps(claim, ensure_ascii=False)[:250])

print("== 6. Выплата: POST /escrow/payout")
st, pay = call("POST", "/escrow/payout",
                {"escId": esc_id, "employerAddress": EMPLOYER,
                 "workerReceiptSig": claim["receiptSig"], "workerPub": claim["workerPub"]})
print("   HTTP", st, "->", json.dumps(pay, ensure_ascii=False)[:300])
assert st == 201, f"payout failed: {pay}"

print("== 7. Жду выплату в балансе агента...")
def paid():
    st, b = call("POST", "/balance", {"address": worker})
    if st == 200 and abs(float(b.get("balance", 0)) - AMOUNT) < 1e-9:
        return True, b
    return False, b
bfin = wait_for("10 AGT у агента", paid)
print("   БАЛАНС АГЕНТА:", bfin)
print(f"== ГОТОВО: агент {worker[:16]}… выполнил {task}, получил {AMOUNT} AGT (escrow {esc_id})")
print("CRED:", cred_file, "TASK:", task, "ESCROW:", esc_id)
