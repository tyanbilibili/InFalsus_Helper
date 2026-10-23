# InFalsus Helper

In Falsus 本地曲库、成绩归档、自定义 Rating、Top 30 分表与游戏内浮窗工具。

最新版本：20261023

## 启动

双击 `dist/InFalsusHelper-win32-x64/InFalsusHelper.exe`。

## 功能

- 自动扫描 Steam 的 `libraryfolders.vdf` 与 App ID `3971950`，也可手动指定游戏目录。
- 一键通过 Steam 启动游戏。游戏已运行时只切回窗口，不会再次启动 `infalsus.exe`。
- 从游戏 Unity Addressables Data 读取歌曲、谱面、难度与定数；“重新读取 Data”时也会扫描并补齐缺失曲绘。
- 只读扫描 `%USERPROFILE%\AppData\LocalLow\lowiro\infalsus\<账号>\release\savestate_V3.sav`。
- 把游戏滚动历史去重后保存在本工具自己的 `user_data/accounts` 下。
- 计算 Top 30 Rating 并显示每张谱面的单曲值与加权贡献。
- 生成 2400×1800 的 Top 30 PNG 分表，每张卡片带 S / P / N / M 判定数量。
- 顶部居中浮窗：游玩阶段自动隐藏，结算立即展开；返回选曲界面后保持展开，开始下一首歌才收起。
- 鼠标移到屏幕顶部居中位置可随时召唤浮窗，移开约 1.5 秒后自动收回。
- 可自定义昵称：默认显示存档编号前 8 位，存档账号只在“存档账号”字段显示。
- 开发者模式：开启后显示“精确定数表”，可双击谱面定数修改为一位小数；只把改过的值保存到 `user_data/precise-constants.json`，并用于单曲 Rating、总 Rating、历史页与 Top30 导出。精确定数表按 ULT / FBD 降序切换排序；“设置当前精确定数表为默认精确定数”会把当前表存成 exe 同级 `data/precise-defaults.json`，“还原到默认精确定数”则恢复成该默认表。
- 移植参考程序的全局输入设置：
  - `Alt + Z` 暂停 / 恢复监听
  - `G` 与 `CapsLock` 播放音效
  - CapsLock 大小写切换屏蔽
  - `CapsLock→LShift`、`G→F`
  - 鼠标左键→LShift、右键→Space、中键→左键
  - 屏蔽 `Win+Shift+S` 和 `Win+Shift+R`

## Rating 算法

Arcaea同款算法。单曲 Rating 使用游戏整数分数和谱面定数 `C`：

```text
分数 ≥ 100,000,000:
    单曲 Rating = C + 2

98,000,000 ≤ 分数 < 100,000,000:
    单曲 Rating = C + 1 + (分数 - 98,000,000) / 2,000,000

分数 < 98,000,000:
    单曲 Rating = max(0, C + 1 - (98,000,000 - 分数) / 3,000,000)
```

同一谱面只保留最高单曲 Rating。最终总分：

```text
Rating = (Top10 单曲 Rating × 2 + Top11–30 单曲 Rating × 1) / 40
```

界面显示三位小数，内部计算保留精确有理数。

所有单曲 Rating、加权贡献与总 Rating 都按**去尾法**（直接截断多余小数）显示，不做四舍五入。因此浮窗显示的“本次变化”就是（新总 Rating 三位小数）−（旧总 Rating 三位小数），与屏幕上的数字完全一致。

## 数据目录

程序不会写入游戏存档。运行时数据位于程序旁的：

```text
data/                      # 与 InFalsusHelper.exe 同级，解压后即可见
  precise-defaults.json    # 默认精确定数表，可直接查看/替换/随包分发

user_data/                 # 首次读到存档账号后才会创建
  installation.json
  settings.json            # 含每个存档账号的昵称
  precise-constants.json   # 当前精确定数（只存改过的）
  runtime/
  accounts/<账号哈希>/archive.json

catalog_data/
  active.json

resources/app/app/data/    # 程序内置后备，data/ 缺失时使用
  precise-defaults.json
```

`catalog_data` 会在游戏 build 变化后从当前游戏 Data 重新生成。

默认精确定数表的优先级是：exe 同级的 `data\precise-defaults.json` → 程序内置的 `resources\app\app\data\precise-defaults.json`。所以解压后第一份就在 exe 旁边，看得见也改得动；如果它被删掉，下次启动会自动从内置那份恢复出来。

点“设置当前精确定数表为默认精确定数”会覆盖 exe 同级那份（需要程序目录可写，写不进去才回退到内置位置）；“还原到默认精确定数”则把当前表恢复成它。它与存档账号无关，下载解压就自带。

如果要分发给别人，直接打包整个 `dist/InFalsusHelper-win32-x64` 即可，`data/precise-defaults.json` 会一起带过去；再删除 `user_data`、`catalog_data` 等本机数据，避免包含自己的存档标识与成绩。

## 输入钩子

- 改键和目标输入使用硬件扫描码，兼容 DirectInput / Raw Input。
- 鼠标改写会把原始左键、右键、中键吞掉；启用后需要点击时请按鼠标中键。
- 若游戏以管理员身份运行，本工具可能也需要管理员权限。设置页提供“以管理员身份重启”。
- 注入输入带有系统可识别的 `INJECTED` 标记；启用的功能仅建议用于本机单机游戏和个人输入习惯调整。

## 构建

```powershell
npm install
npm test
npm run package
```

输入钩子与阶段监控已分别打包为：

```text
app/scripts/input-service.exe
app/scripts/phase-monitor.exe
```

游戏阶段监控只读访问 `GameAssembly.dll` 的 IL2CPP 静态类型区，不注入 DLL、不修改游戏内存。已知 build 使用固定布局；其他 build 会通过类型签名只读定位并验证布局。

当前完成实机阶段验证的 Steam build：`26126718`。曲库更新到该 build 时包含 80 首歌曲、320 张谱面。

## 素材与许可

界面沿用参考程序的科技档案视觉体系。字体许可位于 `app/assets/fonts/`，Electron 与 Chromium 许可见发行目录。In Falsus 名称、曲绘和游戏资源归原权利人所有；本工具为非官方本地辅助软件。

## 注意事项

- 精确定数表为开发者本人主观+社区定数表辅助，主观性非常强！如果你不认可开发者的定数，你可以打开开发者模式自己修改。
  
# 特别鸣谢！！！

**RTX3N0N**

## 鸣谢
- Tyan-an
- Deepseek-v4.1-flash
- Reasonix
- Codex
