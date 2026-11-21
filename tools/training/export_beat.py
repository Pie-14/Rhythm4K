# export_beat.py — 按拍模型 → JS
import numpy as np, torch, base64, json, os, sys
W = r'D:\AI4K'
out = sys.argv[1]
sd = torch.load(os.path.join(W, 'beat_weights.pt'), map_location='cpu')

def b64f(a):
    return base64.b64encode(np.ascontiguousarray(np.asarray(a, dtype='<f4')).tobytes()).decode('ascii')

t = {k.replace('.', '_'): v.detach().numpy().astype(np.float32) for k, v in sd.items()}
payload = {k: b64f(v) for k, v in t.items()}
payload['inDim'] = int(t['body_0_weight'].shape[1])
payload['hid'] = int(t['body_0_weight'].shape[0])

js = '  M.BEAT_WEIGHTS = ' + json.dumps(payload) + ';\n'
with open(out, 'w', encoding='utf-8') as f:
    f.write("/* beatmodel.js — 按拍生成模型（由 D:\\AI4K\\export_beat.py 生成） */\n")
    f.write("(function (g) {\n  'use strict';\n  var M = g.M4K = g.M4K || {};\n")
    f.write(js)
    f.write("})(typeof window !== 'undefined' ? window : globalThis);\n")
print('已写 %s  %.0f KB  inDim=%d hid=%d' % (out, os.path.getsize(out) / 1024, payload['inDim'], payload['hid']))
