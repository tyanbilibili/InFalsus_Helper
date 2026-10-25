# -*- coding: utf-8 -*-
"""Extract missing 160x160 song preview covers from local Unity bundles."""

import argparse
import json
import os
import sys

import UnityPy
from PIL import Image

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--game", required=True)
    parser.add_argument("--catalog", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--existing", action="append", default=[])
    args = parser.parse_args()

    with open(args.catalog, "r", encoding="utf-8") as handle:
        envelope = json.load(handle)
    songs = envelope.get("catalog", {}).get("songs", [])
    mapping = envelope.get("mapping", {}).get("songs", [])
    base_by_song = {
        item.get("song_id"): item.get("base_name")
        for item in mapping
        if isinstance(item, dict)
    }

    targets = {}
    for song in songs:
        song_id = song.get("id")
        base = base_by_song.get(song_id)
        if not song_id or not base:
            continue
        output_path = os.path.join(args.output, song_id + ".webp")
        existing = any(os.path.isfile(os.path.join(root, song_id + ".webp")) for root in args.existing)
        if not os.path.isfile(output_path) and not existing:
            targets[str(base) + "_small"] = (song_id, output_path)
    if not targets:
        print(json.dumps({"updated": 0, "missing": []}, ensure_ascii=False))
        return 0

    os.makedirs(args.output, exist_ok=True)
    bundle_dir = os.path.join(args.game, "infalsus_Data", "StreamingAssets", "aa", "StandaloneWindows64")
    bundles = sorted(
        os.path.join(bundle_dir, name)
        for name in os.listdir(bundle_dir)
        if name.endswith(".bundle")
    )
    extracted = []
    for bundle in bundles:
        if not targets:
            break
        try:
            environment = UnityPy.load(bundle)
            for obj in environment.objects:
                if obj.type.name != "Texture2D":
                    continue
                try:
                    texture = obj.read()
                    name = texture.m_Name
                except Exception:
                    continue
                target = targets.get(name)
                if not target:
                    continue
                song_id, output_path = target
                image = texture.image.convert("RGBA").resize((160, 160), Image.Resampling.LANCZOS)
                image.save(output_path, "WEBP", quality=92, method=6)
                extracted.append(song_id)
                del targets[name]
        except Exception:
            # A malformed unrelated bundle must not stop the remaining scan.
            continue

    print(json.dumps({
        "updated": len(extracted),
        "songs": sorted(extracted),
        "missing": sorted(value[0] for value in targets.values())
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
