# export_seq_js.py — 把 seq_weights.npz 量化成 JS 权重文件
import numpy as np, base64, json, os, sys

work = r'D:\AI4K'
out_js = sys.argv[1] if len(sys.argv) > 1 else r'C:\Users\Pie14\Documents\deepseek-harness\default-workspace\rhythm4k\www\js\seqmodel.js'

d = np.load(os.path.join(work, 'seq_weights.npz'))
mu = d['mu'].astype(np.float32)
sd = d['sd'].astype(np.float32)


def q8(arr):
    a = arr.astype(np.float32)
    scale = float(np.abs(a).max()) / 127.0
    if scale <= 0:
        scale = 1.0
    q = np.clip(np.round(a / scale), -127, 127).astype(np.int8)
    return q, scale


def b64(a):
    return base64.b64encode(a.tobytes()).decode('ascii')


layers = []


def add(w, b, in_ch, out_ch, k, dil, pad):
    qw, sw = q8(w)
    qb, sb = q8(b)
    layers.append({
        'w': b64(qw), 'b': b64(qb), 'wScale': sw, 'bScale': sb,
        'inCh': in_ch, 'outCh': out_ch, 'k': k, 'dil': dil, 'pad': pad,
    })


# 输入卷积
add(d['inp_weight'], d['inp_bias'], 33, 64, 5, 1, 2)
# 6 个残差块，每个两块卷积
for i, dil in enumerate([1, 2, 4, 8, 16, 1]):
    add(d['blocks_%d_0_weight' % i], d['blocks_%d_0_bias' % i], 64, 64, 5, dil, 2 * dil)
    add(d['blocks_%d_2_weight' % i], d['blocks_%d_2_bias' % i], 64, 64, 5, dil, 2 * dil)
# 输出头
add(d['head_weight'], d['head_bias'], 64, 4, 1, 1, 0)

payload = {
    'inDim': 33,
    'mu': b64(mu), 'sd': b64(sd),
    'layers': layers,
}

src = open(out_js, encoding='utf-8').read()
head = src.split('  var SEQ = null;')[0]
tail = '  var SEQ = null;' + src.split('  var SEQ = null;', 1)[1]

js_data = '  M.SEQ_WEIGHTS = ' + json.dumps(payload) + ';\n'

with open(out_js, 'w', encoding='utf-8') as f:
    f.write(head + js_data + tail)

print('已写入 %s' % out_js)
print('大小 %.0f KB | 层数 %d' % (os.path.getsize(out_js) / 1024, len(layers)))
