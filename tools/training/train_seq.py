# train_seq.py — 端到端序列模型（实验版：不设任何规则）
#
# 输入：每个 16 分格的 33 维特征（梅尔 + 拍位 + 小节位 + 能量）
# 网络：膨胀 1D 卷积，感受野约 ±4 秒（能看到前后段落）
# 输出：4 条轨各自的概率（多标签 → 和弦自然产生）
#
# 训练标签来自人排谱，模型自己学「什么时候放、放哪几列」。
import json, os, sys
import numpy as np
import torch
import torch.nn as nn

root = sys.argv[1]
WORK = r'D:\AI4K'
lib = os.path.join(root, '.verify', 'lib3')
pcmDir = os.path.join(root, '.verify', 'pcm4')
CACHE = os.path.join(WORK, 'cache')
TOL = 35.0
N_MELS = 24
IN_DIM = N_MELS + 4 + 4 + 1   # 33


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
    step = beat / 4.0
    mrate = 22050 / 256
    nF = mel.shape[0]
    n = int((an['duration'] - offset) / step)
    if n < 64:
        return None
    X = np.zeros((n, IN_DIM), dtype=np.float32)
    Y = np.zeros((n, 4), dtype=np.float32)   # 每列一个标签
    # 人排：时刻 → 列
    bySlot = {}
    for t, c, h in ch['human']:
        k = int(round((t - offset) / step))
        if 0 <= k < n:
            bySlot.setdefault(k, set()).add(max(0, min(3, c)))
    energy = an.get('energy') or []
    erate = an.get('frameRate') or 172
    for k in range(n):
        t = offset + k * step
        f0 = int(round(t / 1000.0 * mrate))
        fi = min(nF - 1, max(0, f0))
        X[k, :N_MELS] = mel[fi]
        sub = k % 4
        barBeat = (k // 4) % 4
        X[k, N_MELS + sub] = 1.0
        X[k, N_MELS + 4 + barBeat] = 1.0
        ei = int(round(t / 1000.0 * erate))
        X[k, -1] = energy[min(len(energy) - 1, max(0, ei))] if energy else 0.5
        cols = bySlot.get(k)
        if cols:
            for c in cols:
                Y[k, c] = 1.0
    return {'audio': ch['audio'], 'tier': ch['tier'], 'X': X, 'Y': Y, 'n': n,
            'offset': offset, 'step': step}


print('构建...', flush=True)
charts = [json.load(open(os.path.join(lib, 'charts', f), encoding='utf-8'))
          for f in os.listdir(os.path.join(lib, 'charts'))]
songs = []
for ch in charts:
    s = build(ch)
    if s:
        songs.append(s)
T = sum(s['n'] for s in songs)
pos = sum(float(s['Y'].sum()) for s in songs)
print('谱面 %d | 总格数 %d | 正标签 %d (%.1f%%)' % (len(songs), T, pos, pos / T * 100), flush=True)

# 全局标准化
allX = np.concatenate([s['X'] for s in songs])
MU = allX.mean(0)
SD = allX.std(0) + 1e-6
for s in songs:
    s['X'] = (s['X'] - MU) / SD
print('特征已标准化', flush=True)

audios = sorted(set(s['audio'] for s in songs))
rng = np.random.RandomState(5)
perm = rng.permutation(len(audios))
foldOf = {audios[i]: int(perm[i] % 5) for i in range(len(audios))}


class ChartNet(nn.Module):
    def __init__(self, ch=64):
        super().__init__()
        self.inp = nn.Conv1d(IN_DIM, ch, 5, padding=2)
        self.blocks = nn.ModuleList()
        for d in (1, 2, 4, 8, 16, 1):
            self.blocks.append(nn.Sequential(
                nn.Conv1d(ch, ch, 5, padding=2 * d, dilation=d),
                nn.ReLU(),
                nn.Conv1d(ch, ch, 5, padding=2 * d, dilation=d),
                nn.ReLU(),
            ))
        self.head = nn.Conv1d(ch, 4, 1)

    def forward(self, x):
        h = torch.relu(self.inp(x.transpose(1, 2)))
        for blk in self.blocks:
            h = h + blk(h)          # 残差
        return self.head(h).transpose(1, 2)   # (B, T, 4)


def match_times(pred, human, tol=TOL):
    if not pred or not human:
        return 0
    h = sorted(human)
    used = [False] * len(h)
    hit = 0
    for t in sorted(pred):
        lo, hi = 0, len(h)
        while lo < hi:
            m = (lo + hi) // 2
            if h[m] < t - tol:
                lo = m + 1
            else:
                hi = m
        best, bestd = -1, tol + 1
        k = lo
        while k < len(h) and h[k] <= t + tol:
            if not used[k] and abs(h[k] - t) < bestd:
                bestd, best = abs(h[k] - t), k
            k += 1
        if best >= 0:
            used[best] = True
            hit += 1
    return hit


def evaluate(net, te):
    net.eval()
    res = {'time': {}, 'col': {}}
    with torch.no_grad():
        for s in te:
            x = torch.from_numpy(s['X']).unsqueeze(0)
            probs = torch.sigmoid(net(x))[0].numpy()    # (T, 4)
            presence = probs.max(1)
            k = int(s['Y'].sum())
            if k == 0:
                continue
            idx = np.argsort(-presence)[:k]
            pred_t = [s['offset'] + int(i) * s['step'] for i in idx]
            human_t = [s['offset'] + int(i) * s['step'] for i in range(s['n']) if s['Y'][i].sum() > 0]
            hit = match_times(pred_t, human_t)
            res['time'].setdefault(s['tier'], []).append(hit / len(pred_t))
            # 键位一致：在命中的时刻比较列
            agree = tot = 0
            for i in idx:
                gt = s['Y'][i]
                if gt.sum() == 0:
                    continue
                tot += 1
                pred_cols = set(np.where(probs[i] > 0.5)[0].tolist())
                if not pred_cols:
                    pred_cols = {int(np.argmax(probs[i]))}
                if pred_cols & set(np.where(gt > 0)[0].tolist()):
                    agree += 1
            if tot:
                res['col'].setdefault(s['tier'], []).append(agree / tot)
    return res


print('训练...', flush=True)
aggT, aggC = {}, {}
for f in range(5):
    tr = [s for s in songs if foldOf[s['audio']] != f]
    te = [s for s in songs if foldOf[s['audio']] == f]
    if not tr or not te:
        continue
    net = ChartNet()
    opt = torch.optim.Adam(net.parameters(), lr=1e-3, weight_decay=1e-5)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=10)
    bce = nn.BCEWithLogitsLoss(pos_weight=torch.tensor(2.5))
    seqs = [(torch.from_numpy(s['X']).unsqueeze(0), torch.from_numpy(s['Y']).unsqueeze(0)) for s in tr]
    net.train()
    for ep in range(10):
        rng.shuffle(seqs)
        tot = 0.0
        cnt = 0
        for xb, yb in seqs:
            opt.zero_grad()
            out = net(xb)
            loss = bce(out, yb)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(net.parameters(), 5.0)
            opt.step()
            tot += loss.item() * yb.shape[1]
            cnt += yb.shape[1]
        sched.step()
        print('    fold %d ep %2d loss %.4f' % (f, ep + 1, tot / max(1, cnt)), flush=True)
    r = evaluate(net, te)
    for k, v in r['time'].items():
        aggT.setdefault(k, []).extend(v)
    for k, v in r['col'].items():
        aggC.setdefault(k, []).extend(v)
    print('  fold %d 完成' % f, flush=True)

allt = [x for v in aggT.values() for x in v]
allc = [x for v in aggC.values() for x in v]
print('')
print('=== 端到端序列模型（无任何规则）===')
print('  时间精确率 %.1f%%   列一致率 %.1f%%' % (np.mean(allt) * 100, np.mean(allc) * 100))
for tier in ('easy', 'normal', 'hard'):
    if tier in aggT:
        print('  %-7s 时间 %.1f%%  列 %.1f%%' % (
            tier, np.mean(aggT[tier]) * 100, np.mean(aggC.get(tier, [0.0])) * 100))
print('')
print('对照：完整规则管线 normal 69.8%% / hard 74.1%% | 人 vs 人 时间 82%% 列 50%%')

# ===== 导出模式：全量训练后保存权重 =====
if '--export' in sys.argv:
    print('全量训练用于导出...', flush=True)
    net = ChartNet()
    opt = torch.optim.Adam(net.parameters(), lr=1e-3, weight_decay=1e-5)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=12)
    bce = nn.BCEWithLogitsLoss(pos_weight=torch.tensor(2.5))
    seqs = [(torch.from_numpy(s['X']).unsqueeze(0), torch.from_numpy(s['Y']).unsqueeze(0)) for s in songs]
    net.train()
    for ep in range(12):
        rng.shuffle(seqs)
        tot = cnt = 0
        for xb, yb in seqs:
            opt.zero_grad()
            out = net(xb)
            loss = bce(out, yb)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(net.parameters(), 5.0)
            opt.step()
            tot += loss.item() * yb.shape[1]
            cnt += yb.shape[1]
        sched.step()
        print('  ep %2d loss %.4f' % (ep + 1, tot / max(1, cnt)), flush=True)
    sd = net.state_dict()
    out = {'mu': MU.astype(np.float32), 'sd': SD.astype(np.float32)}
    for k, v in sd.items():
        out[k.replace('.', '_')] = v.detach().numpy().astype(np.float32)
    np.savez(os.path.join(WORK, 'seq_weights.npz'), **out)
    print('权重已存 D:\\AI4K\\seq_weights.npz')
    for k, v in out.items():
        print('  %-22s %s' % (k, list(v.shape)))
    sys.exit(0)