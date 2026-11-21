# train_stage2.py — 阶段 B：沿音符序列递推的键位模型（GRU）
#
# 解决四个问题：
#   1. 列配合差 → GRU 隐藏状态记住前面几十个音，学键位语法
#   2. 90% 和弦  → 不再用 4 条独立 sigmoid，而是「给定历史 + 音频」判每列，
#                  历史里带着「刚响过哪一列」，模型自己学会克制
#   3. 完全没和弦 → 输出仍是多标签（可以 1 个也可以 2 个），由模型决定
#   4. 同列连打   → 输入包含「上一个音的列」和「距上一个音多久」
#
# 用法：python train_stage2.py <项目根> [--export]
import json, os, sys
import numpy as np
import torch
import torch.nn as nn

root = sys.argv[1]
DO_EXPORT = '--export' in sys.argv
WORK = r'D:\AI4K'
lib = os.path.join(root, '.verify', 'lib3')
CACHE = os.path.join(WORK, 'cache')
N_MELS = 24
HIST = 8          # 历史事件数


def norm_name(s):
    import re
    return re.sub(r'_+', '_', s)


def load_mel(slug):
    p = os.path.join(CACHE, norm_name(slug) + '.npy')
    return np.load(p) if os.path.exists(p) else None


def build_seq(ch):
    """把一张谱变成事件序列：每个事件 = (时刻, 列集合)"""
    an = json.load(open(os.path.join(lib, 'analysis', ch['audio'] + '.json'), encoding='utf-8'))
    mel = load_mel(ch['audio'])
    if mel is None:
        return None
    beat, offset = an['beatMs'], an['offset']
    mrate = 22050 / 256
    byT = {}
    for t, c, h in ch['human']:
        byT.setdefault(int(round(t)), set()).add(max(0, min(3, c)))
    times = sorted(byT)
    if len(times) < 20:
        return None
    seq = []
    prev_cols = []
    prev_t = None
    for t in times:
        fi = min(mel.shape[0] - 1, max(0, int(round(t / 1000.0 * mrate))))
        audio = mel[fi].astype(np.float32)          # 24 维
        # 历史特征：前 HIST 个音的列 one-hot + 间隔（拍）
        hist = np.zeros(24 + HIST * 5, dtype=np.float32)
        hist[:24] = audio
        for j in range(HIST):
            k = len(prev_cols) - 1 - j
            if k < 0:
                continue
            hist[24 + j * 5 + prev_cols[k]] = 1.0
            gap = (t - prev_t[k]) / beat if prev_t is not None else 4.0
            hist[24 + HIST * 4 + j] = min(gap, 8.0) / 8.0
        label = np.zeros(4, dtype=np.float32)
        for c in byT[t]:
            label[c] = 1.0
        seq.append((hist, label, t))
        prev_cols.append(min(byT[t]))
        if prev_t is None:
            prev_t = []
        prev_t.append(t)
    return {'audio': ch['audio'], 'tier': ch['tier'], 'seq': seq,
            'offset': offset, 'step': beat / 4}


print('构建事件序列...', flush=True)
charts = [json.load(open(os.path.join(lib, 'charts', f), encoding='utf-8'))
          for f in os.listdir(os.path.join(lib, 'charts'))]
songs = []
for ch in charts:
    s = build_seq(ch)
    if s:
        songs.append(s)
NEV = sum(len(s['seq']) for s in songs)
print('谱面', len(songs), '| 事件', NEV, flush=True)

IN = 24 + HIST * 5


class Stage2(nn.Module):
    """GRU 沿事件序列走，输出这一时刻每列的概率"""

    def __init__(self, hid=128):
        super().__init__()
        self.inp = nn.Linear(IN, 128)
        self.gru = nn.GRU(128, hid, batch_first=True)
        self.out = nn.Linear(hid, 4)

    def forward(self, x, h=None):
        z = torch.relu(self.inp(x))
        o, h = self.gru(z, h)
        return self.out(o), h


def evaluate(net, te):
    """自回归：用模型自己的历史预测下一列"""
    net.eval()
    res = {}
    with torch.no_grad():
        for s in te:
            h = None
            prev_cols = []
            prev_t = []
            hit = tot = 0
            for hist, label, t in s['seq']:
                x = hist.copy()
                # 用自己预测的历史覆盖（训练时的历史是人的）
                for j in range(HIST):
                    k = len(prev_cols) - 1 - j
                    x[24 + j * 5:24 + j * 5 + 5] = 0
                    if k < 0:
                        continue
                    x[24 + j * 5 + prev_cols[k]] = 1.0
                    gap = (t - prev_t[k]) / 800.0
                    x[24 + HIST * 4 + j] = min(gap, 1.0)
                logits, h = net(torch.from_numpy(x).unsqueeze(0).unsqueeze(0), h)
                prob = torch.sigmoid(logits[0, 0]).numpy()
                # 允许 1~2 个列：取超过 0.5 的，至少 1 个
                cols = set(np.where(prob > 0.5)[0].tolist())
                if not cols:
                    cols = {int(np.argmax(prob))}
                if len(cols) > 2:
                    order = np.argsort(-prob)
                    cols = set(int(i) for i in order[:2])
                actual = set(np.where(label > 0)[0].tolist())
                tot += 1
                if cols & actual:
                    hit += 1
                pc = min(cols)
                prev_cols.append(pc)
                prev_t.append(t)
            if tot:
                res.setdefault(s['tier'], []).append(hit / tot)
    return res


def train_net(tr, epochs=8, seed=0):
    net = Stage2()
    opt = torch.optim.Adam(net.parameters(), lr=2e-3, weight_decay=1e-5)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=epochs)
    bce = nn.BCEWithLogitsLoss(pos_weight=torch.tensor(1.5))
    order = list(range(len(tr)))
    rng = np.random.RandomState(seed)
    net.train()
    for ep in range(epochs):
        rng.shuffle(order)
        tot = cnt = 0
        for si in order:
            s = tr[si]
            X = torch.from_numpy(np.stack([e[0] for e in s['seq']])).unsqueeze(0)
            Y = torch.from_numpy(np.stack([e[1] for e in s['seq']])).unsqueeze(0)
            if X.shape[1] < 2:
                continue
            opt.zero_grad()
            logits, _ = net(X)
            loss = bce(logits, Y)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(net.parameters(), 5.0)
            opt.step()
            tot += loss.item() * X.shape[1]
            cnt += X.shape[1]
        sched.step()
        print('    ep %2d  bce %.4f' % (ep + 1, tot / max(1, cnt)), flush=True)
    return net


if DO_EXPORT:
    print('全量训练用于导出...', flush=True)
    net = train_net(songs, epochs=10, seed=77)
    torch.save(net.state_dict(), os.path.join(WORK, 'stage2_weights.pt'))
    print('权重已存 D:\\AI4K\\stage2_weights.pt')
    sys.exit(0)

audios = sorted(set(s['audio'] for s in songs))
rng = np.random.RandomState(9)
perm = rng.permutation(len(audios))
foldOf = {audios[i]: int(perm[i] % 5) for i in range(len(audios))}

print('训练...', flush=True)
agg = {}
for f in range(5):
    tr = [s for s in songs if foldOf[s['audio']] != f]
    te = [s for s in songs if foldOf[s['audio']] == f]
    if not tr or not te:
        continue
    net = train_net(tr, epochs=8, seed=f)
    r = evaluate(net, te)
    for k, v in r.items():
        agg.setdefault(k, []).extend(v)
    print('  fold %d 完成' % f, flush=True)

allv = [x for v in agg.values() for x in v]
print('')
print('=== 阶段 B（GRU 序列键位）===')
print('  列一致率 %.1f%%' % (np.mean(allv) * 100 if allv else 0))
for tier in ('easy', 'normal', 'hard'):
    if tier in agg:
        print('  %-7s %.1f%%  (%d 张)' % (tier, np.mean(agg[tier]) * 100, len(agg[tier])))
print('')
print('对照：瞎猜 25% | 现有启发式 42~53% | 人 vs 人 50%')
