# -*- coding: utf-8 -*-
# Прогрев Ollama: первый запрос может грузить модель несколько минут (RAM-дефицит).
# Второй запрос после прогрева — быстрый (модель остаётся в RAM ~5 мин по умолчанию).
import urllib.request, json, time
req = urllib.request.Request(
    'http://127.0.0.1:11434/api/generate',
    data=json.dumps({
        'model': 'qwen3:0.6b',
        'prompt': 'say OK',
        'stream': False,
        'options': {'num_predict': 5, 'num_ctx': 512},
    }).encode(),
    headers={'Content-Type': 'application/json'})
t0 = time.time()
try:
    resp = json.load(urllib.request.urlopen(req, timeout=280))
    print('took %.1f s RESP:' % (time.time() - t0), (resp.get('response') or '')[:120])
except Exception as e:
    print('took %.1f s FAIL:' % (time.time() - t0), str(e)[:200])
