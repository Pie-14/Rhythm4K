# train_bpm_sel.py — 训「BPM 候选选择器」（留一法）
import json, os, sys
import numpy as np

WORK = r'D:\AI4K'
rows = json.load(open(os.path.join(WORK, 'bpm_rows.json'), encoding='utf-8'))

songs = {}
for r in rows:
    songs.setdefault(r['song'], []).append(r)
songs = {k: v for k, v in songs.items() if any(x['label'] for x in v)}
print('有正例的歌', len(songs))

FEATS = ['score', 'contrast', 'cov', 'half', 'halfRatio', 'grid', 'log(145)', 'log(120)', 'bias']


def Xi(r):
    return np.array(r['f'], dtype=np.float64)


def fit(X, y, l2=1.0, iters=3000, lr=0.5):
    mu, sd = X.mean(0), X.std(0)
    sd[sd < 1e-9] = 1.0
    Z = np.hstack([np.ones((len(X), 1)), (X - mu) / sd])
    w = np.zeros(Z.shape[1])
    for _ in range(iters):
        p = 1 / (1 + np.exp(-Z.dot(w)))
        g = Z.T.dot(p - y) / len(Z) + l2 * w / len(Z)
        w -= lr * g
    return w, mu, sd


def pred(w, mu, sd, X):
    Z = np.hstack([np.ones((len(X), 1)), (X - mu) / sd])
    return 1 / (1 + np.exp(-Z.dot(w)))


keys = sorted(songs)
# 留一法
top1 = 0
top1_exact = 0
near = 0
details = []
for held in keys:
    tr = [r for k, v in songs.items() if k != held for r in v]
    Xtr = np.stack([Xi(r) for r in tr])
    ytr = np.array([r['label'] for r in tr], dtype=np.float64)
    w, mu, sd = fit(Xtr, ytr)
    te = songs[held]
    Xte = np.stack([Xi(r) for r in te])
    p = pred(w, mu, sd, Xte)
    idx = int(np.argmax(p))
    best = te[idx]
    top1 += 1
    if best['label'] == 1:
        top1_exact += 1
    want = best['want']
    if any(abs(best['bpm'] - want * m) / (want * m) <= 0.03 for m in (0.5, 1, 2)):
        near += 1
    details.append((held, want, best['bpm'], best['label']))

print('')
print('=== 学到的选择器（留一法）===')
print('  top-1 完全正确 %d/%d (%.0f%%)' % (top1_exact, top1, top1_exact / top1 * 100))
print('  top-1 正确或差一个八度 %d/%d (%.0f%%)' % (near, top1, near / top1 * 100))

# 对比：现状（按 score 选）
base = 0
for k, v in songs.items():
    best = max(v, key=lambda r: r['f'][0])
    if best['label'] == 1:
        base += 1
print('  现状（按 score 选）%d/%d (%.0f%%)' % (base, len(songs), base / len(songs) * 100))

# 全量训练导出权重
X = np.stack([Xi(r) for v in songs.values() for r in v])
y = np.array([r['label'] for v in songs.values() for r in v], dtype=np.float64)
w, mu, sd = fit(X, y)
print('')
print('权重（标准化后）:')
for i, name in enumerate(FEATS):
    print('  %-12s %+.3f' % (name, w[1 + i]))
json.dump({'w': [float(x) for x in w], 'mu': [float(x) for x in mu],
           'sd': [float(x) for x in sd], 'feats': FEATS},
          open(os.path.join(WORK, 'bpm_sel.json'), 'w'))
print('')
print('已存 D:\\AI4K\\bpm_sel.json')
