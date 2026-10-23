# Third-party notices for the save adapter

The read-only adapter was researched using **InFalsus-SaveData-Parser** by
RedDragon, copyright 2026, licensed under MIT. Its original license is retained
at `sources/save-adapter/LICENSE` (project root). Referenced source snapshots,
metadata and individual content hashes are in that directory. The production
Node reader is independently implemented and does not invoke the upstream
Python exporter.

Upstream: https://github.com/REDDRAGON-HL/InFalsus-SaveData-Parser
Metadata upstream: https://github.com/REDDRAGON-HL/InFalsus-Resource

The repository license does not confer ownership of game titles, game assets,
trademarks or other third-party materials. No game executable, art, music or
playable chart asset is redistributed by this adapter. The portable v1.0 distribution bundles a standalone official Node.js runtime; see ../runtime/LICENSE.txt. Windows .NET Framework remains a system prerequisite. Artwork distribution is described separately in the release-root THIRD_PARTY_NOTICES.md.

## Local text and numeric fonts

Kazesawa Regular/Bold and static Noto Sans SC-derived fonts are bundled under SIL OFL 1.1. The Noto-derived family is renamed `IF CJK Text`; see the [font provenance and build notes](../assets/fonts/README.md), [Kazesawa license](../assets/fonts/Kazesawa-LICENSE.txt), and [Noto license](../assets/fonts/NotoSansCJK-LICENSE.txt). They are loaded locally and privately, not installed system-wide. ASCII numeric runs now use Oxanium Regular/Bold, copyright 2019 The Oxanium Project Authors, also under [SIL OFL 1.1](../assets/fonts/Oxanium-LICENSE.txt). Original static TTF files are pinned to author commit `a8f39e0c71186190027a093e9001459410192d1e`; this is a reference-inspired numeric design choice, not an identification of a game font. These licenses do not cover game artwork.

## Local metadata catalog reader (v0.6.0)

`unity-common.json` is the common Unity type-tree offset/string table exported
from **UnityPy 1.25.4** (`get_common_strings()`), copyright (c) 2019–2026 K0lb3,
MIT. The full license is retained in [UnityPy-LICENSE.txt](UnityPy-LICENSE.txt).
UnityPy was used as a development-only independent verifier; the launcher does
not import Python, UnityPy, or any downloaded native extraction library.

Upstream: https://github.com/K0lb3/UnityPy

`unity-metadata.cjs` is an independently written, bounded Node.js decoder.
Unity Addressables `BinaryContentCatalogData.cs` / `BinaryStorageBuffer.cs`
were consulted as binary-format documentation through the package mirror:
https://github.com/needle-mirror/com.unity.addressables . No package code or
Unity runtime is linked into the launcher.

Game metadata layout research also consulted:
https://github.com/Rosemoe/infalsus-extractor and
https://github.com/REDDRAGON-HL/InFalsus-Resource . Their exporters/decryptors
are not executed by the launcher. Fixed-offset older SongData layouts are not
used: current local type trees determine fields. No audio, cover or playable
chart payload is exported. The common table is the only new third-party-derived
runtime file; game resources remain local and are read, never copied into the
release. These references do not license game assets.
