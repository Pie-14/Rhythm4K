# train_ddc.py — DDC 风格的采音时机模型（PyTorch，CPU）
#
# 输入：梅尔频谱的 ±16 帧窗口（33 帧 × 24 频带 = 792 维）
# 输出：该 16 分格放不放音符（二分类）
# 验证：按音频分组 5 折，同密度精确率
#
# 用法：D:\AI4K\venv\Scripts\python.exe train_ddc.py <项目根>
import json, os, sys, math, random
import numpy as np
import torch
import torch.nn as nn

root = sys.argv[1]
WORK = r'D:\AI4K'
CACHE = os.path.join(WORK, 'cache')
os.makedirs(CACHE, exist_ok=True)
lib = os.path.join(root, '.verify', 'lib3')
pcmDir = os.path.join(root, '.verify', 'pcm4')

TOL_MS = 35.0
SIDE = 10          # 左右各 10 帧（约 ±116ms），控制内存
STRIDE = 1
N_MELS = 24
N_FFT = 1024
HOP = 256


# ---------------- 梅尔频谱 ----------------
def hz2mel(f):
    return 2595.0 * np.log10(1.0 + f / 700.0)


def mel2hz(m):
    return 700.0 * (10.0 ** (m / 2595.0) - 1.0)


def mel_fb(sr, n_fft, n_mels):
    n_bins = n_fft // 2 + 1
    hz = mel2hz(np.linspace(hz2mel(20), hz2mel(sr / 2), n_mels + 2))
    freqs = np.linspace(0, sr / 2, n_bins)
    fb = np.zeros((n_mels, n_bins), dtype=np.float32)
    for i in range(n_mels):
        lo, ce, hi = hz[i], hz[i + 1], hz[i + 2]
        fb[i] = np.maximum(0, np.minimum((freqs - lo) / max(1e-9, ce - lo),
                                         (hi - freqs) / max(1e-9, hi - ce)))
    return fb


def compute_mel(x, sr):
    fb = mel_fb(sr, N_FFT, N_MELS)
    win = np.hanning(N_FFT).astype(np.float32)
    n = 1 + max(0, (len(x) - N_FFT) // HOP)
    out = np.empty((n, N_MELS), dtype=np.float32)
    for i in range(n):
        seg = x[i * HOP:i * HOP + N_FFT]
        if len(seg) < N_FFT:
            seg = np.pad(seg, (0, N_FFT - len(seg)))
        out[i] = fb.dot(np.abs(np.fft.rfft(seg * win)).astype(np.float32))
    return np.log1p(100.0 * out)


def norm_name(s):
    import re
    return re.sub(r'_+', '_', s)


def pcm_index():
    idx = {}
    for fn in os.listdir(pcmDir):
        if fn.endswith('.f32'):
            idx[norm_name(fn[:-4])] = fn
    return idx


PIDX = pcm_index()
MEL_CACHE = {}


def get_mel(slug):
    if slug in MEL_CACHE:
        return MEL_CACHE[slug]
    cpath = os.path.join(CACHE, norm_name(slug) + '.npy')
    if os.path.exists(cpath):
        arr = np.load(cpath)
        MEL_CACHE[slug] = arr
        return arr
    fn = PIDX.get(norm_name(slug))
    if not fn:
        MEL_CACHE[slug] = None
        return None
    meta = json.load(open(os.path.join(pcmDir, fn[:-4] + '.json'), encoding='utf-8'))
    x = np.fromfile(os.path.join(pcmDir, fn), dtype=np.float32)
    mel = compute_mel(x, meta['sr'])
    np.save(cpath, mel)
    MEL_CACHE[slug] = mel
    return mel


def build_song(ch):
    an = json.load(open(os.path.join(lib, 'analysis', ch['audio'] + '.json'), encoding='utf-8'))
    beat, offset = an['beatMs'], an['offset']
    step = beat / 4.0
    mel = get_mel(ch['audio'])
    if mel is None:
        return None
    mrate = 22050 / HOP
    human = sorted(set(int(n[0]) for n in ch['human']))
    if not human:
        return None
    nSlots = int((an['duration'] - offset) / step)
    if nSlots <= 0:
        return None

    X = np.zeros((nSlots, 2 * SIDE + 1, N_MELS), dtype=np.float16)
    y = np.zeros(nSlots, dtype=np.float32)
    col = np.full(nSlots, -1, dtype=np.int64)
    nF = mel.shape[0]

    # 预先把 human 做成「时刻 → 列集合」
    byT = {}
    for t, c, h in ch['human']:
        byT.setdefault(int(round(t)), set()).add(c)

    hi = 0
    for k in range(nSlots):
        t = offset + k * step
        f0 = int(round(t / 1000.0 * mrate))
        for j, off in enumerate(range(-SIDE, SIDE + 1)):
            fi = min(nF - 1, max(0, f0 + off))
            X[k, j] = mel[fi]
        # 标签
        while hi < len(human) and human[hi] < t - TOL_MS:
            hi += 1
        if hi < len(human) and abs(human[hi] - t) <= TOL_MS:
            y[k] = 1.0
            cols = byT.get(human[hi])
            if cols:
                col[k] = min(cols)
    # 不做每首歌内部标准化：它会把「响度」这个和密度强相关的信息抹掉
    # （之前就是这么崩的：同一段音乐在不同歌里被归一化成了同样的数值）
    X = np.log1p(np.maximum(X, 0))
    return {'audio': ch['audio'], 'tier': ch['tier'], 'X': X, 'y': y, 'col': col,
            'n': nSlots, 'human': human, 'offset': offset, 'step': step}


print('构建数据...', flush=True)
charts = [json.load(open(os.path.join(lib, 'charts', f), encoding='utf-8'))
          for f in os.listdir(os.path.join(lib, 'charts'))]
songs = []
for i, ch in enumerate(charts):
    s = build_song(ch)
    if s:
        songs.append(s)
    if (i + 1) % 50 == 0:
        print(' ', i + 1, '/', len(charts), flush=True)
print('谱面', len(songs), '| 槽位', sum(s['n'] for s in songs), flush=True)

audios = sorted(set(s['audio'] for s in songs))
rng = np.random.RandomState(7)
perm = rng.permutation(len(audios))
foldOf = {audios[i]: int(perm[i] % 5) for i in range(len(audios))}


class Net(nn.Module):
    def __init__(self, inp):
        super().__init__()
        self.body = nn.Sequential(
            nn.Flatten(),
            nn.Linear(inp, 512), nn.ReLU(), nn.Dropout(0.3),
            nn.Linear(512, 256), nn.ReLU(), nn.Dropout(0.2),
            nn.Linear(256, 1),
        )

    def forward(self, x):
        return self.body(x).squeeze(-1)


def match_times(pred, human, tol=TOL_MS):
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


def run_fold(f):
    tr = [s for s in songs if foldOf[s['audio']] != f]
    te = [s for s in songs if foldOf[s['audio']] == f]
    if not tr or not te:
        return {}
    # 负样本降采样到 40%（正样本全留），省内存也加快训练
    rng2 = np.random.RandomState(f)
    Xs, ys = [], []
    for s in tr:
        yv = s['y']
        keep = (yv > 0) | (rng2.rand(len(yv)) < 0.4)
        Xs.append(s['X'][keep])
        ys.append(yv[keep])
    Xtr = np.concatenate(Xs).astype(np.float32)
    ytr = np.concatenate(ys)
    net = Net(Xtr.shape[1] * Xtr.shape[2])
    opt = torch.optim.Adam(net.parameters(), lr=2e-3, weight_decay=1e-5)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=14)
    lossf = nn.BCEWithLogitsLoss()
    ds = torch.utils.data.TensorDataset(torch.from_numpy(Xtr), torch.from_numpy(ytr))
    dl = torch.utils.data.DataLoader(ds, batch_size=512, shuffle=True)
    net.train()
    for ep in range(14):
        tot = 0.0
        for xb, yb in dl:
            opt.zero_grad()
            out = net(xb)
            loss = lossf(out, yb)
            loss.backward()
            opt.step()
            tot += loss.item() * len(xb)
        sched.step()
        print('    fold %d epoch %d loss %.4f' % (f, ep + 1, tot / len(ds)), flush=True)
    net.eval()
    res = {}
    with torch.no_grad():
        for s in te:
            x = torch.from_numpy(s['X'].astype(np.float32))
            score = net(x).numpy()
            k = len(s['human'])
            if k == 0 or k >= len(score):
                continue
            idx = np.argsort(-score)[:k]
            pred = [s['offset'] + int(i) * s['step'] for i in idx]
            hit = match_times(pred, s['human'])
            res.setdefault(s['tier'], []).append(hit / len(pred))
    return res


print('训练...', flush=True)
agg = {}
for f in range(5):
    r = run_fold(f)
    for k, v in r.items():
        agg.setdefault(k, []).extend(v)
    print('  折 %d 完成' % f, flush=True)

allv = [x for v in agg.values() for x in v]
print('')
print('=== DDC 风格 MLP（±16 帧上下文）· 同密度精确率 ===')
print('  全部 %.1f%%' % (np.mean(allv) * 100 if allv else 0))
for tier in ('easy', 'normal', 'hard'):
    if tier in agg:
        print('  %-7s %.1f%%  (%d 张)' % (tier, np.mean(agg[tier]) * 100, len(agg[tier])))
print('')
print('对照：22 标量 48.7% | 加 ±8 帧频谱（岭回归）56.0%')
