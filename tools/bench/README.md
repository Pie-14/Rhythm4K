# 评估脚本

这些小工具用来**量「自动生成的谱面有多像人排的」**，以及 **BPM 估得准不准**。
它们不是游戏的一部分，也不参与构建——只在改生成器的时候用来做回归对比。

## 需要的数据

这些脚本依赖 `.verify/` 目录（已 gitignore），里面放的是本地数据集：

```
.verify/
  lib3/charts/*.json        人排谱（[{name, tier, pkg, audio, human:[[time,col,hold],…]}]
  lib3/<pkg>/*.osu          原始 .osu（用来抽真值 BPM）
  lib3/analysis/*.json      预处理好的分析结果（节拍、起音、能量）
  pcm4/<audio>.f32          22050Hz 单声道音频
```

数据集是我当年从 osu!mania 4K 谱面里批量抓的，**不随仓库分发**（版权 + 体积）。
想重建的话，需要自己准备一批 `.osz`，解压后跑一遍预处理（`tools/training/` 里有特征提取的写法）。

## 脚本

### `rebuild_gt.js` — 重建 BPM 真值表

从 `lib3/<pkg>/*.osu` 的 `[TimingPoints]` 抽 BPM（取未继承时间点的众数），
按音频名对上 `pcm4/`，写到 `.verify/bpm_gt.json`。

```bash
node tools/bench/rebuild_gt.js .
```

实测能从 137 个曲包里重建出 **254 条**真值。

### `bpmbench.js` — BPM 准确率

跑 64 首有音频的曲子，统计「±3% 内算对 / 差一个八度 / 完全错」。

```bash
node tools/bench/bpmbench.js .
```

### `prec.js` — BPM 精度

只看「判对的那部分」的相对误差，以及全曲末段的网格残差。
判断依据是：**判定对不代表能对齐**——差 0.3% 在 3 分钟里就会漂掉一拍。

```bash
node tools/bench/prec.js .
```

### `allcheck.js` — 生成质量快照

对几首歌分别生成三档难度，打印：密度（音/秒）、同列率、长条数与长度分布。
改完生成器跑一遍，确认没退化。

```bash
node tools/bench/allcheck.js .
```

### `bardiff.js` — 与人排逐小节对比

拿一首人排谱和自动谱，按小节比较密度曲线，输出：

| 指标 | 为什么要看 |
|---|---|
| 相邻小节自相关 | 人排是「一段一段」的（~0.65），逐小节独立随机是 0.15 |
| 4 小节局部 CV | 段落内部的密度起伏 |
| 最长「成片 / 空洞」 | 有没有「一堆连出」和「一片空白」 |

```bash
node tools/bench/bardiff.js . <human.json> <audio.f32> <meta.json> [强制BPM]
```

## 当前的基线（0.4.0）

| 指标 | 人排参考 | 自动 |
|---|---|---|
| BPM ±3% 准确率 | — | 63% |
| BPM 精度（对的那部分） | — | 0.000% |
| 音符与起音偏差（中位） | — | 3.8 ms |
| 同列率（0.5 拍内） | 4.3% | 0% |
| 长条比例 | ~10% | 10% |
| 相邻小节自相关 | 0.65 | 0.66 |
