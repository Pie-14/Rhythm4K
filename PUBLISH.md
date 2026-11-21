# 发布到 GitHub

`dist/for-github/` 已经是**可以直接推送的仓库状态**：没有密钥、没有个人绝对路径、没有第三方素材。
当前版本 **0.4.0**，体积约 **2.3 MB**。

## 里面有什么

```
www/            游戏本体（9 个 js，最大的 seqmodel.js 1.3 MB）
launcher/       启动器源码 + 图标（不含编译出的 exe）
tests/          393 项断言的测试套件
tools/bench/    生成质量与 BPM 准确率的评估脚本
tools/training/ 训练管线（可选，需要 PyTorch + 数据集）
README.md       说明
CHANGELOG.md    更新日志
```

**不包含**（已在 `.gitignore` 里）：`dist/`（构建产物）、`www/audio/`（第三方音频/封面）、
`.verify/`（数据集，~2 GB）、`.backup/`（开发快照）、`Rhythm4K.lnk`（含绝对路径）、
`launcher/Rhythm4K.exe`（会被 Defender 拦）。

## 三条路，挑一条

### ① GitHub Desktop（最省事，推荐）

1. 装 [GitHub Desktop](https://desktop.github.com/)
2. `File → Add local repository…` → 选 `dist/for-github` 这个文件夹
3. 它会提示「不是仓库，要不要创建」→ **Create repository**
4. 右上角 `Publish repository`（想公开就取消勾选 *Keep this code private*）

### ② 网页上传（不想装任何东西）

1. 打开 [github.com/new](https://github.com/new)，建一个空仓库
2. 点 `uploading an existing file`
3. 把 `dist/for-github` 里的东西**全选拖进去**（`.gitignore` 里的都不在里面了，可以放心拖）

### ③ 命令行

本机没装 git。装完 [Git for Windows](https://git-scm.com/download/win) 后：

```powershell
cd dist/for-github
git init
git add .
git commit -m "Rhythm4K 0.4.0"
git branch -M main
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

## 发布 Release

推上去之后，在仓库页面 `Releases → Draft a new release`：

- Tag：`v0.4.0`
- 标题：`Rhythm4K 0.4.0 — 自动生成谱面重写`
- 说明：直接贴 `dist/release-notes-0.4.0.md` 的内容
- 附件：上传 `dist/release/Rhythm4K-0.4.0.zip`

## 检查清单

- [ ] `www/audio/` 没有被带进去（第三方音乐，版权）
- [ ] `launcher/Rhythm4K.exe` 没有被带进去
- [ ] `Rhythm4K.lnk` 没有被带进去（里面是本机绝对路径）
- [ ] `.verify/`、`.backup/` 没有被带进去
- [ ] README 里的版本号和 CHANGELOG 一致（都是 0.4.0）
