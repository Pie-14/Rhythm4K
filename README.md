# Rhythm4K

<p align="center">
  <img src="launcher/icon-512.png" width="128" alt="Rhythm4K">
</p>

<p align="center">
一个能直接读 <b>osu!mania</b> 谱面的 4 轨下落式音游，纯静态网页，无后端、无依赖、不联网。
</p>

<p align="center">
<sub>A 4-key mania rhythm game that plays osu!mania beatmaps. Runs entirely in the browser — no backend, no dependencies.</sub>
</p>

---

## 特性

- **直接吃 osu!mania 谱面**：拖入 `.osz` / `.osu` / 整个曲目文件夹即可，不需要转换
- **能从音乐自动生成谱面**：给一首 mp3，它估 BPM、对节拍、按难度铺音符
- **普通音符 + 长条**，任意键数（4K 默认键位，5/6/7K 自动切换键位）
- **背景图 + 背景视频**：读 `.osz` 里 `[Events]` 段指定的素材；`.flv` 也能放（见下）
- **仿 osu!lazer 的版式**：逐列色相、圆角音符、音符形状的判定靶区、右侧 hit error 条
- **音频时钟驱动**：以 WebAudio 的 `currentTime` 为准，带输出延迟补偿和判定偏移校准
- **满分 1,000,000**，判定 `PERFECT / GREAT / GOOD / BAD / MISS`
- 完全离线，`file://` 双击就能跑

## 快速开始

### Windows

双击 **`启动游戏.bat`**（会找到 Edge/Chrome，用 app 模式全屏打开，没有地址栏）。

想要桌面快捷方式：右键 `重建启动方式.ps1` → **使用 PowerShell 运行**，会在当前目录生成 `Rhythm4K.lnk`
（快捷方式里是绝对路径，所以它不进仓库，换机器重新生成一次即可）。

> `launcher\Rhythm4K.exe` 是用系统编译器现场生成的无签名启动器，Windows Defender / SmartScreen
> 通常会拦，**不推荐**作为入口。要用的话得自己解除拦截。

### 任意系统 / 浏览器

用 **Chrome、Edge 或任意 Chromium 内核浏览器**打开 `www/index.html`。
`file://` 直接可用，不需要起服务器。

### 在线玩

仓库是纯静态的，把 GitHub Pages 指向 **`www/`** 目录即可在线玩：
Settings → Pages → Source 选 *Deploy from a branch* → 分支 `main`、目录 `/www`。

## 操作

| 操作 | 键 |
| --- | --- |
| 打歌（4K） | `D` `F` `J` `K` |
| 打歌（5K） | `D` `F` `空格` `J` `K` |
| 打歌（6K/7K） | `S` `D` `F` [`空格`] `J` `K` `L` |
| 开始 / 重试 | `空格` |
| 暂停 / 继续 | `Esc` |
| 全屏切换 | `F11` |

第一次打开可以点「**内置示例曲**」。它优先读 www/audio/demo.mp3（本地放的真实曲目，自动分析生成谱面），
读不到就退回程序实时合成的曲子——所以哪怕 www/audio/ 是空的也照样能玩。
> www/audio/ 里是第三方作品，已加进 .gitignore，发布仓库时不会带上；分发包里会带。

## 导入谱面

三种方式，随便挑：

1. 把 **`.osz`** 拖进窗口（自动解包，谱面和音频一起读出来）
2. 把 **`.osu` + 音频文件**一起拖进来，或拖整个歌曲文件夹
3. 点「选择 .osz / .osu」或「选择文件夹」

要求：

- 必须是 **osu!mania**（`Mode: 3`），`CircleSize` 决定轨数
- 音频文件名和谱面里 `AudioFilename` 一致（放同一个文件夹就行）
- 只支持普通音符和长条；`Slider` / `Spinner` 会被忽略
- 变速 / SV 特效谱面不支持（音符到达时间仍然准确，只是下落速度不做变化）

## 判定与计分

| 判定 | 时间窗 | 权重 |
| --- | --- | --- |
| PERFECT | ±25ms | 300 |
| GREAT | ±45ms | 200 |
| GOOD | ±80ms | 100 |
| BAD | ±110ms | 50 |
| MISS | 超过 ±150ms | 0 |

- **满分 1,000,000**：每个音符等分 `1e6 / 音符总数`，按判定权重计入，
  所以全 PERFECT 正好 1,000,000，分数 ≈ 准确率 × 1e6。连击不加分，只计数。
- 长条在**头部**判定；按住到尾巴（容差 110ms）算完成，提前松手算断连
- 判定总是偏一侧时，看右侧的 hit error 条就知道该把「判定偏移」调正还是调负

## 从音频自动生成谱面

菜单里选难度 → 点「从音乐自动生成谱面」→ 选一个 mp3/ogg/wav，几秒后就有谱面可以打。
准备页里换难度会就地重新生成，不用重新选文件。

它做的事：

1. 降采样到 ~22kHz，分三个频段滤波：低频（底鼓）、中频（军鼓/人声）、高频（踩镲）
2. 每个频段算短时包络 → 只取上升沿 → 自适应阈值挑打击点
3. 用谱流自相关估 BPM，再用梳状打分找节拍相位
4. 打击点吸附到节拍网格，按难度筛密度（简单 8 分、普通/困难 16 分）。
   吸附容差收紧到 **±30ms 以内**：够不到网格的起音直接丢弃，不硬挪——
   否则音符会离真实发声太远，听感就是「对不上拍」
5. **音型模板**：连续的几个音不随机走位，而是套用「楼梯 / 折返 / 三连 / 跳进」这些模板；
   长串按上下行交替铺，每轮把起点挪一列。规则是「优先用还没怎么用过的那几条列」
6. **段落密度**：算一条整曲能量曲线（1 秒平滑、分位数归一化），按 2 拍窗口用能量决定保留几个音。
   高潮段约 1.3 倍密度、间奏约 0.55 倍；且高潮段**网格收到八分音符**（去掉十六分弱拍）、
   正拍加权，让重音压在小节第一拍上。**如果整首曲子响度起伏不明显（对比度 < 0.7，按 4 秒平滑后的曲线算），
   就完全不套这套曲线**，所有段落都用中性密度——不会凭空压低或抬高。这一步是必需的，因为高潮段响度大、和声厚，
   能量上升沿反而少，光靠起音检测会让高潮比间奏还空
7. **和弦**：同一个节拍格里如果同时有多个音源（底鼓 + 军鼓 + 镲），就落成 2~3 键和弦。
   **只落在小节第一拍**（情绪重音），不会撒得到处都是——那样节奏会乱。
   简单/普通最多 2 键、困难最多 3 键；副音镜像到另一侧，不会和主音撞列
7. **长条跟着真实延音**：只有这个音真的拖了 ≥0.85 拍才生成长条，长度跟着延音走。
   密度有上限：总量 ≤12%、两条之间至少隔 1.5 拍（不然人声吟唱段会整片变长条）。
   如果它所在的列马上还有音，会自动换一条空着的列

**对这个功能的预期要摆正**：它仍是「机器谱」——节奏、密度、音型套路都对得上，能玩，
但没有人工谱面那种整体的编排设计（段落起伏、刻意的难点铺陈、和旋律的呼应）。
鼓点清楚的曲子（摇滚、电子、鼓组明显的）效果最好；纯钢琴、氛围、人声为主的曲子容易铺得很乱。

速度估计带一个以 145 BPM 为中心的先验：4/4 里底鼓军鼓交替时，两拍周期的自相关天然更强，
不加先验会稳定地估成半速。宁可估快一点——网格更细，谱子不会变粗。

## 背景图与视频

读 `.osz` 里 `[Events]` 段：

```
[Events]
0,0,"BG.jpg",0,0          ← 背景图
Video,-45,"optc.flv"      ← 视频（自动识别起始偏移）
```

| 容器 | 处理方式 |
| --- | --- |
| `.mp4` `.webm` `.mkv` `.mov` `.avi` | 交给 `<video>` 原生播放，编码不支持就退回背景图 |
| **`.flv`** | **自己解容器 + WebCodecs 解码** |

`.flv` 这一路值得说明：浏览器内核没有 FLV 解复用器（Flash 时代的格式），但 osu 老谱面里
大量是这种。好在里面的编码通常是 H.264，Chromium 能解。所以 `www/js/flv.js` 自己解析 FLV tag、
取出 AVCC 码流和 `AVCDecoderConfigurationRecord`，喂给 WebCodecs 的 `VideoDecoder`，
解出来的画面画进离屏 canvas，再当背景图用。

注意 B 帧：FLV 存的是**解码顺序**，PTS 是乱序的，必须按 DTS 喂，否则会 `EncodingError`。

放不了一律退回 `BG.jpg`，不会黑屏。

## 开发

纯静态，没有构建步骤：改完 `www/` 里的文件，刷新页面就是最新的。

### 目录结构

```
www/                 游戏本体（纯静态）
  index.html
  css/style.css
  js/core.js         .osu 解析 + 判定引擎（纯逻辑，无 DOM，可在 Node 里测）
  js/audio.js        WebAudio 主时钟（延迟补偿、暂停恢复）
  js/flv.js          FLV 解复用 + WebCodecs 解码
  js/render.js       Canvas2D 绘制
  js/demo.js         内置示例曲（程序合成音频 + 谱面）
  js/autochart.js    音频 → 谱面（BPM 估计 / 节拍对齐 / 难度生成）
  js/app.js          界面流程 / 输入 / 主循环
tests/               三层测试 + DOM/音频桩
tools/               开发用：本地服务器、无头浏览器探针
launcher/            启动器源码（C#）与图标
启动游戏.bat          可移植启动入口
重建启动方式.ps1      生成桌面快捷方式
build.ps1            重新编译启动器 exe
package.ps1          打包成可分发 zip
```

### 跑测试

需要 Node 18+（不依赖任何 npm 包）：

```bash
node tests/test_core.js      # 谱面解析 + 判定逻辑
node tests/test_render.js    # 绘制坐标、布局、无 NaN
node tests/test_app.js       # 假 DOM + 假音频，端到端跑完一整首
node tests/test_autochart.js # 自动生成：合成鼓点 → BPM/相位/谱面质量
node tests/test_launchers.js # 启动脚本静态检查（换行符 / 括号块 / BOM）
node tests/test_flv.js <某个.flv>   # FLV 解复用（不给路径就跳过）
```

### 重新编译启动器

```powershell
powershell -ExecutionPolicy Bypass -File build.ps1
```

用的是 Windows 自带的 .NET Framework 编译器，不需要装 SDK。

### 打包分发

```powershell
powershell -ExecutionPolicy Bypass -File package.ps1
```

会生成 `dist/Rhythm4K-<版本>.zip`，只含运行必需的文件（不含测试和开发工具）。

## 已知限制

- 变速 / SV 谱面不支持
- 不支持自定义皮肤贴图（配色和形状是内置的）
- `.flv` 只支持 H.264；VP6 / Sorenson H.263 的老 FLV、DivX 的 AVI 放不了
- 没有成绩保存、排行榜、谱面编辑器
- 需要 Chromium 内核（Firefox 的 WebCodecs 支持不全，视频背景可能失效）

## 许可

[MIT](LICENSE)

谱面、音乐、背景素材的版权属于各自作者。仓库本身不附带第三方素材（www/audio/ 已忽略）；
没有音频文件时，内置示例曲会退回程序实时合成的音频。
