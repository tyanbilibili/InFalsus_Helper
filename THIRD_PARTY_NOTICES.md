# InFalsus Rating Launcher v1.0 — 第三方声明

## 游戏美术与数据
按维护者要求，保留现有标题图、75首曲绘及原生缩略图，以保持与开发版一致的界面。
游戏商标、标题图、曲绘及曲目信息的权利归 lowiro 与各原权利人；本项目不将它们声称为原创或开源素材。
本包定位为非官方学习测试；这不表示已获得官方授权，也不自动授予再次传播这些素材的权利。
标题来源及哈希：`InFalsus_Rating/assets/title-source.json`。
曲绘映射及哈希：`InFalsus_Rating/assets/covers/manifest.json` 与 `covers-native/manifest.json`。
未附带游戏可执行程序、游戏音频、可游玩谱面文件或真实玩家存档。

## 字体
Kazesawa（作者 Kazesawa）、Noto Sans CJK（Noto 项目）和 Oxanium（The Oxanium Project Authors）采用 SIL OFL 1.1。
完整许可在 `InFalsus_Rating/assets/fonts/` 的三个 LICENSE.txt 中；来源与固定版本在 sources.json。
Noto 静态派生字体已重命名为 IF CJK Text；所有六个运行用 TTF 与开发版一致。没有安装系统字体。

## 只读适配与公共类型表
独立只读适配器研究参考 REDDRAGON-HL/InFalsus-SaveData-Parser（MIT），使用的必要公开元数据为 sources/save-adapter/songs.json。
上游完整许可保留在 sources/save-adapter/LICENSE。未附带其开发工具或 Python 解析环境。
Unity 公共类型表来源于 UnityPy，MIT 完整许可保留在 InFalsus_Rating/live/UnityPy-LICENSE.txt。
其他技术参考与既有说明保留在 InFalsus_Rating/live/THIRD_PARTY_NOTICES.md。

## Node.js
附带官方 Windows x64 Node.js v24.22.0 的单一 node.exe，仅用作本机运行时。
完整 Node.js 及其内含第三方组件许可在 InFalsus_Rating/runtime/LICENSE.txt。
官方 SHASUMS256.txt 与校验来源保存在同目录；没有 npm、SDK、头文件、Python、编辑器或 node_modules。
Node.js 官方二进制下载来源：https://nodejs.org/dist/v24.22.0/win-x64/node.exe
官方校验清单：https://nodejs.org/dist/v24.22.0/SHASUMS256.txt
Windows/.NET Framework 由使用者的操作系统提供，不在包中分发。
