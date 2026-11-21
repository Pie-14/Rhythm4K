# export_stage2.py — 把阶段 B（GRU 键位模型）导出成 JS
import numpy as np, torch, base64, json, os, sys

W = r'D:\AI4K'
out = sys.argv[1]
sd = torch.load(os.path.join(W, 'stage2_weights.pt'), map_location='cpu')

def b64f(a):
    return base64.b64encode(np.ascontiguousarray(np.asarray(a, dtype='<f4')).tobytes()).decode('ascii')

t = {}
for k, v in sd.items():
    t[k.replace('.', '_')] = v.detach().numpy().astype(np.float32)

payload = {
    'inpW': b64f(t['inp_weight']), 'inpB': b64f(t['inp_bias']),
    'ihW': b64f(t['gru_weight_ih_l0']), 'ihB': b64f(t['gru_bias_ih_l0']),
    'hhW': b64f(t['gru_weight_hh_l0']), 'hhB': b64f(t['gru_bias_hh_l0']),
    'outW': b64f(t['out_weight']), 'outB': b64f(t['out_bias']),
    'inDim': int(t['inp_weight'].shape[1]),
    'hid': int(t['gru_weight_hh_l0'].shape[1]),
}
js = '  M.STAGE2_WEIGHTS = ' + json.dumps(payload) + ';\n'
with open(out, 'w', encoding='utf-8') as f:
    f.write("/* stage2.js — 阶段 B：GRU 键位模型（由 D:\\AI4K\\export_stage2.py 生成） */\n")
    f.write("(function (g) {\n  'use strict';\n  var M = g.M4K = g.M4K || {};\n")
    f.write(js)
    f.write("})(typeof window !== 'undefined' ? window : globalThis);\n")
print('已写 %s  %.0f KB  inDim=%d hid=%d' % (out, os.path.getsize(out) / 1024, payload['inDim'], payload['hid']))
