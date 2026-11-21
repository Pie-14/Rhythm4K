# build_bpm_gt.py — 从 .osu 的 TimingPoints 提取真值 BPM，并按游戏方式(44.1k)解码
import json, os, sys, re
import numpy as np
import soundfile as sf
from collections import Counter

root = sys.argv[1]
WORK = r'D:\AI4K'
lib = os.path.join(root, '.verify', 'lib3')
outdir = os.path.join(WORK, 'pcm44')
os.makedirs(outdir, exist_ok=True)


def parse_bpm(text):
    """取未继承时间点（uninherited=1）的 BPM，返回中位数"""
    in_tp = False
    bpms = []
    for line in text.splitlines():
        s = line.strip()
        if s.startswith('['):
            in_tp = s == '[TimingPoints]'
            continue
        if not in_tp or not s or s.startswith('//'):
            continue
        parts = s.split(',')
        if len(parts) < 2:
            continue
        try:
            bl = float(parts[1])
            uninherited = parts[6].strip() == '1' if len(parts) > 6 else True
        except Exception:
            continue
        if not uninherited or bl <= 0:
            continue
        bpm = 60000.0 / bl
        if 30 <= bpm <= 400:
            bpms.append(bpm)
    if not bpms:
        return None
    c = Counter(round(b, 2) for b in bpms)
    return c.most_common(1)[0][0]


def safe(s):
    return re.sub(r'[^0-9A-Za-z]+', '_', s)[:60]


charts = json.load(open(os.path.join(root, '.verify', 'lib3_charts.json'), encoding='utf-8'))
by_audio = {}
for c in charts:
    if c['keys'] != 4 or c.get('mode') != 3:
        continue
    p = os.path.join(root, c['dir'])
    if not os.path.exists(p):
        continue
    t = open(p, encoding='utf-8-sig', errors='ignore').read()
    bpm = parse_bpm(t)
    if not bpm:
        continue
    pkg = os.path.basename(os.path.dirname(c['dir']))
    by_audio.setdefault(pkg, []).append(bpm)

# 每个包取众数
gt = {}
for pkg, bpms in by_audio.items():
    c = Counter(bpms)
    gt[pkg] = c.most_common(1)[0][0]

print('有真值 BPM 的包:', len(gt))

# 找音频并解码到 44100
pcmDir = os.path.join(root, '.verify', 'pcm4')
mapping = json.load(open(os.path.join(pcmDir, '_mapping.json'), encoding='utf-8'))
# mapping: osu相对路径 -> 音频名
pkg_audio = {}
for osu_rel, name in mapping.items():
    pkg = os.path.basename(os.path.dirname(osu_rel))
    if pkg not in pkg_audio:
        pkg_audio[pkg] = name

out = {}
done = skip = fail = 0
for pkg, bpm in sorted(gt.items()):
    name = pkg_audio.get(pkg)
    if not name:
        fail += 1
        continue
    dst = os.path.join(outdir, name + '.f32')
    if os.path.exists(dst):
        skip += 1
        out[pkg] = {'audio': name, 'bpm': bpm}
        continue
    src = os.path.join(pcmDir, name + '.f32')
    if not os.path.exists(src):
        fail += 1
        continue
    x = np.fromfile(src, dtype=np.float32)
    # 从 22050 上采样到 44100（只为模拟游戏里的采样率路径）
    n = len(x) * 2
    y = np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)
    y.tofile(dst)
    json.dump({'sr': 44100, 'length': int(len(y)), 'duration': float(len(y) / 44100)},
              open(os.path.join(outdir, name + '.json'), 'w'))
    out[pkg] = {'audio': name, 'bpm': bpm}
    done += 1

json.dump(out, open(os.path.join(WORK, 'bpm_gt.json'), 'w'), ensure_ascii=False, indent=1)
print('解码 %d | 已存在 %d | 失败 %d | 总真值 %d' % (done, skip, fail, len(out)))
