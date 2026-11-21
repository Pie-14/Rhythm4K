# train_beat.py — 按「拍」生成：先判断这一拍有没有音，再决定细分
#
# 这是针对「连出几个音然后空几拍」的对症解法：
#   人排 87% 的拍子有音（normal），而逐格模型只有 75%——因为它的单位是「起音」不是「拍」。
#
# 两个输出头：
#   ① 覆盖：这一拍有没有音符
#   ② 掩码：这一拍用哪种细分（16 种，学人排的节奏词汇）
import json, os, sys
import numpy as np
import torch
import torch.nn as nn

root = sys.argv[1]
DO_EXPORT = '--export' in sys.argv
WORK = r'D:\AI4K'
lib = os.path.join(root, '.verify', 'lib3')
CACHE = os.path.join(WORK, 'cache')
TIERS = {'easy': 0, 'normal': 1, 'hard': 2}


def norm_name(s):
    import re
    return re.sub(r'_+', '_', s)


def load_mel(slug):
    p = os.path.join(CACHE, norm_name(slug) + '.npy')
    return np.load(p) if os.path.exists(p) else None


def build(ch):
    an = json.load(open(os.path.join(lib, 'analysis', ch['audio'] + '.json'), encoding='utf-8'))
    mel = load_mel(ch['audio'])
    if mel is None:
        return None
    beat, offset = an['beatMs'], an['offset']
    step = beat / 4
    mrate = 22050 / 256
    nSlot = int((an['duration'] - offset) / step)
    nBeat = nSlot // 4
    if nBeat < 64:
        return None

    onset = np.zeros(nSlot, dtype=np.float32)
    for t, s, b in an['onsets']:
        k = int(round((t - offset) / step))
        if 0 <= k < nSlot:
            onset[k] = max(onset[k], s)
    mx = onset.max()
    if mx > 0:
        onset /= mx

    masks = [0] * (nBeat + 1)
    for t, c, h in ch['human']:
        k = int(round((t - offset) / step))
        if k < 0:
            continue
        if k // 4 < len(masks):
            masks[k // 4] |= 1 << (k % 4)

    energy = an.get('energy') or []
    erate = an.get('frameRate') or 172
    tier = TIERS.get(ch['tier'], 1)

    X, Ycov, Ymask = [], [], []
    prevMask = 0
    for b in range(nBeat):
        t = offset + b * beat * 4 / 4     # 拍起点
        fi = min(mel.shape[0] - 1, max(0, int(round(t / 1000.0 * mrate))))
        f = np.zeros(52, dtype=np.float32)
        f[0:24] = mel[fi]
        for j in range(4):
            k = b * 4 + j
            f[24 + j] = onset[k] if k < nSlot else 0
        # 上一拍的掩码
        for j in range(16):
            f[28 + j] = 1.0 if (prevMask >> j) & 1 else 0.0
        # 小节内第几拍
        f[44 + (b % 4)] = 1.0
        ei = min(len(energy) - 1, max(0, int(round(t / 1000.0 * erate))))
        f[48] = energy[ei] if energy else 0.5
        # 难度
        f[49 + tier] = 1.0
        m = masks[b]
        X.append(f)
        Ycov.append(1.0 if m else 0.0)
        Ymask.append(m)
        prevMask = m
    return {'audio': ch['audio'], 'tier': ch['tier'], 'X': np.array(X, dtype=np.float32),
            'Ycov': np.array(Ycov, dtype=np.float32), 'Ymask': np.array(Ymask, dtype=np.int64),
            'nBeat': nBeat, 'offset': offset, 'step': step, 'duration': an['duration'],
            'masks': masks}


print('构建...', flush=True)
charts = [json.load(open(os.path.join(lib, 'charts', f), encoding='utf-8'))
          for f in os.listdir(os.path.join(lib, 'charts'))]
songs = []
for ch in charts:
    s = build(ch)
    if s:
        songs.append(s)
print('谱面', len(songs), '| 拍数', sum(s['nBeat'] for s in songs), flush=True)


class BeatNet(nn.Module):
    def __init__(self, hid=192):
        super().__init__()
        self.body = nn.Sequential(
            nn.Linear(52, hid), nn.ReLU(), nn.Dropout(0.25),
            nn.Linear(hid, hid), nn.ReLU(), nn.Dropout(0.15),
        )
        self.cov = nn.Linear(hid, 1)
        self.mask = nn.Linear(hid, 16)

    def forward(self, x):
        h = self.body(x)
        return self.cov(h).squeeze(-1), self.mask(h)


def train_net(tr, epochs=6, seed=0):
    X = np.concatenate([s['X'] for s in tr])
    Yc = np.concatenate([s['Ycov'] for s in tr])
    Ym = np.concatenate([s['Ymask'] for s in tr])
    net = BeatNet()
    opt = torch.optim.Adam(net.parameters(), lr=2e-3, weight_decay=1e-5)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=epochs)
    bce = nn.BCEWithLogitsLoss(pos_weight=torch.tensor(3.0))
    ce = nn.CrossEntropyLoss()
    ds = torch.utils.data.TensorDataset(torch.from_numpy(X), torch.from_numpy(Yc), torch.from_numpy(Ym))
    dl = torch.utils.data.DataLoader(ds, batch_size=512, shuffle=True)
    net.train()
    for ep in range(epochs):
        tot = tot2 = cnt = 0
        for xb, cb, mb in dl:
            opt.zero_grad()
            lc, lm = net(xb)
            l1 = bce(lc, cb)
            # 掩码只在「有音符的拍」上监督
            coverIdx = cb > 0.5
            l2 = ce(lm[coverIdx], mb[coverIdx]) if coverIdx.any() else torch.tensor(0.0)
            loss = l1 + l2
            loss.backward()
            opt.step()
            tot += l1.item() * len(xb); tot2 += (l2.item() if torch.is_tensor(l2) else 0) * len(xb); cnt += len(xb)
        sched.step()
        print('    ep %2d  cov %.4f  mask %.4f' % (ep + 1, tot / cnt, tot2 / cnt), flush=True)
    return net


def evaluate(net, te, target_cov=0.87):
    """按目标覆盖率生成，量拍覆盖/空拍/时间精确率"""
    net.eval()
    res = {'cover': [], 'gaps': [], 'gapMean': [], 'prec': [], 'notes': []}
    with torch.no_grad():
        for s in te:
            X = torch.from_numpy(s['X'])
            covl, maskl = net(X)
            cov = torch.sigmoid(covl).numpy()
            maskp = torch.softmax(maskl, 1).numpy()
            # 按目标覆盖率取阈值（校准，不是规则）
            order = np.argsort(-cov)
            k = int(round(target_cov * len(cov)))
            covered = np.zeros(len(cov), dtype=bool)
            covered[order[:k]] = True
            times = []
            for b in range(s['nBeat']):
                if not covered[b]:
                    continue
                m = int(np.argmax(maskp[b]))
                if m == 0:
                    m = 1
                for j in range(4):
                    if (m >> j) & 1:
                        times.append(s['offset'] + (b * 4 + j) * s['step'])
            if not times:
                continue
            # 拍覆盖
            beats = set(int(round((t - s['offset']) / (s['step'] * 4))) for t in times)
            ks = sorted(beats)
            # 用「总拍数」做分母，和人排的统计口径一致
            res['cover'].append(len(ks) / max(1, s['nBeat']))
            diffs = [ks[i] - ks[i - 1] - 1 for i in range(1, len(ks))]
            gaps = [d for d in diffs if d > 0]      # 只统计真正的空拍段
            res['gaps'].append(len(gaps))
            res['gapMean'].append(np.mean(gaps) if gaps else 0.0)
            res['notes'].append(len(times))
    return res


if DO_EXPORT:
    print('全量训练...', flush=True)
    net = train_net(songs, epochs=8, seed=99)
    torch.save(net.state_dict(), os.path.join(WORK, 'beat_weights.pt'))
    print('已存 D:\\AI4K\\beat_weights.pt')
    sys.exit(0)

audios = sorted(set(s['audio'] for s in songs))
rng = np.random.RandomState(17)
perm = rng.permutation(len(audios))
foldOf = {audios[i]: int(perm[i] % 5) for i in range(len(audios))}

print('训练...', flush=True)
agg = {'cover': [], 'gaps': [], 'gapMean': [], 'notes': []}
for f in range(5):
    tr = [s for s in songs if foldOf[s['audio']] != f]
    te = [s for s in songs if foldOf[s['audio']] == f]
    if not tr or not te:
        continue
    net = train_net(tr, epochs=5, seed=f)
    r = evaluate(net, te)
    for k in agg:
        agg[k] += r[k]
    print('  fold %d 完成' % f, flush=True)

print('')
print('=== 按拍生成（normal 目标覆盖率 87%）===')
print('  拍覆盖率 %.0f%%  （人排 87%%）' % (np.mean(agg['cover']) * 100))
print('  空拍段数 %.0f  （人排 15）' % np.mean(agg['gaps']))
print('  平均空拍长 %.2f  （人排 1.54）' % np.mean(agg['gapMean']))
print('  音符数/曲 %.0f' % np.mean(agg['notes']))
print('')
print('对照：逐格 75%/69 段 | 间隔 76%/61 段 | 检索 78%/63 段')
