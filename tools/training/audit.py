# audit.py — 数据集审计：确认没有脏数据混进来
import json, os, sys, re
from collections import Counter, defaultdict

root = sys.argv[1]
lib = os.path.join(root, '.verify', 'lib3')
charts = json.load(open(os.path.join(root, '.verify', 'lib3_charts.json'), encoding='utf-8'))
pcmDir = os.path.join(root, '.verify', 'pcm4')

keep = [c for c in charts if c['keys'] == 4 and c['mode'] == 3]
print('=== 1. 基础筛选 ===')
print('  全部 .osu        %d' % len(charts))
print('  4K mania (Mode=3) %d' % len(keep))
bad_mode = [c for c in charts if c['keys'] == 4 and c['mode'] != 3]
print('  排除的 4键非 mania %d  (std %d / catch %d)' % (
    len(bad_mode),
    sum(1 for c in bad_mode if c['mode'] == 0),
    sum(1 for c in bad_mode if c['mode'] == 2)))

# 实际进入训练集的（charts 目录）
chartFiles = [f for f in os.listdir(os.path.join(lib, 'charts')) if f.endswith('.json')]
used = []
for f in chartFiles:
    d = json.load(open(os.path.join(lib, 'charts', f), encoding='utf-8'))
    used.append(d)
print('')
print('=== 2. 实际训练用的谱面 %d 张 ===' % len(used))

# 校验：每张谱的音频分析是否存在、BPM 是否合理
anCache = {}
bpmBad, singleCol, dupKey = [], [], Counter()
density = []
for d in used:
    slug = d['audio']
    if slug not in anCache:
        p = os.path.join(lib, 'analysis', slug + '.json')
        anCache[slug] = json.load(open(p, encoding='utf-8')) if os.path.exists(p) else None
    an = anCache[slug]
    if an is None:
        bpmBad.append((d['name'], '无分析'))
        continue
    if not (50 <= an['bpm'] <= 300):
        bpmBad.append((d['name'], an['bpm']))
    cols = set(n[1] for n in d['human'])
    if len(cols) < 2:
        singleCol.append(d['name'])
    if any(c < 0 or c > 3 for c in cols):
        singleCol.append(d['name'] + ' (列越界)')
    dur = (an['duration'] - an['offset']) / 1000.0
    if dur > 5:
        density.append(len(d['human']) / dur)
    dupKey[(d['audio'], len(d['human']))] += 1

print('  BPM 异常/无分析:', len(bpmBad))
for n, v in bpmBad[:5]:
    print('    %s  %s' % (n[:50], v))
print('  只用了 1 列或列越界:', len(singleCol))
for n in singleCol[:5]:
    print('    ' + n[:60])
print('  音符密度 (个/秒): 中位 %.2f  最小 %.2f  最大 %.2f' % (
    sorted(density)[len(density) // 2], min(density), max(density)))

print('')
print('=== 3. 重复谱面（同一音频 + 同样音符数）===')
dups = [(k, v) for k, v in dupKey.items() if v > 1]
print('  可疑重复 %d 组' % len(dups))
for (audio, n), cnt in dups[:5]:
    print('    %s  音符 %d  ×%d' % (audio[:40], n, cnt))

print('')
print('=== 4. 分档 ===')
tierCount = Counter(d['tier'] for d in used)
for t, n in tierCount.items():
    print('  %-7s %d' % (t, n))

print('')
print('=== 5. 结论 ===')
ok = (len(singleCol) == 0 and len(bpmBad) == 0)
print('  数据干净:', '是' if ok else '否（见上）')
print('  共 %d 张 4K mania 谱，%d 首不同音频' % (len(used), len(set(d['audio'] for d in used))))
