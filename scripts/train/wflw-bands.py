#!/usr/bin/env python
"""
WFLW band calibration: where lips, eyes, and brows sit inside a face box.

Reads the local WFLW 98-point lists already under scratch/datasets/wflw.
Does not download anything. Writes apps/client/src/lib/face-bands.json.

  python scripts/train/wflw-bands.py

Annotation line (space-separated, last field is the image path):
  98 * (x y) landmarks in absolute pixels,
  then x_min y_min x_max y_max,
  then 6 attribute ints.

Landmark groups (0-based, 98-point layout): brows 33..50, eyes 60..75, mouth 76..95.
"""
from __future__ import annotations

import json
import statistics
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ANN_DIR = ROOT / "scratch/datasets/wflw/WFLW_annotations/list_98pt_rect_attr_train_test"
IMG_ROOT = ROOT / "scratch/datasets/wflw/WFLW_images"
OUT_JSON = ROOT / "apps/client/src/lib/face-bands.json"

BROW_IDX = range(33, 51)
EYE_IDX = range(60, 76)
MOUTH_IDX = range(76, 96)
CLAMP_LO = 0.0
CLAMP_HI = 1.0


def parse_line(line: str) -> dict | None:
    parts = line.split()
    if len(parts) < 207:
        return None
    try:
        vals = [float(v) for v in parts[:196]]
        rect = [float(v) for v in parts[196:200]]
    except ValueError:
        return None
    x_min, y_min, x_max, y_max = rect
    w = x_max - x_min
    h = y_max - y_min
    if w <= 1 or h <= 1:
        return None
    pts = list(zip(vals[0::2], vals[1::2]))
    rel = [((x - x_min) / w, (y - y_min) / h) for x, y in pts]
    return {"rel": rel, "path": parts[-1]}


def collect(ann_file: Path) -> dict:
    faces = []
    skipped = 0
    for line in ann_file.read_text().splitlines():
        if not line.strip():
            continue
        parsed = parse_line(line)
        if parsed is None:
            skipped += 1
            continue
        rel = parsed["rel"]
        faces.append(
            {
                "mouth_y": [max(CLAMP_LO, min(CLAMP_HI, rel[i][1])) for i in MOUTH_IDX],
                "mouth_x": [max(CLAMP_LO, min(CLAMP_HI, rel[i][0])) for i in MOUTH_IDX],
                "eye_y": [max(CLAMP_LO, min(CLAMP_HI, rel[i][1])) for i in EYE_IDX],
                "eye_x": [max(CLAMP_LO, min(CLAMP_HI, rel[i][0])) for i in EYE_IDX],
                "brow_y": [max(CLAMP_LO, min(CLAMP_HI, rel[i][1])) for i in BROW_IDX],
            }
        )
    if not faces:
        return {"n": 0, "skipped": skipped}

    def stats(key: str) -> dict:
        arr = [v for face in faces for v in face[key]]
        ordered = sorted(arr)
        n = len(ordered)
        return {
            "mean": round(statistics.fmean(arr), 4),
            "std": round(statistics.pstdev(arr), 4),
            "p5": round(ordered[max(0, int(0.05 * (n - 1)))], 4),
            "p95": round(ordered[min(n - 1, int(0.95 * (n - 1)))], 4),
        }

    def extent_stats(key: str) -> dict:
        mins, maxs, mids = [], [], []
        for face in faces:
            vals = face[key]
            lo, hi = min(vals), max(vals)
            mins.append(lo)
            maxs.append(hi)
            mids.append((lo + hi) / 2)
        return {
            "minOfMin": round(min(mins), 4),
            "maxOfMax": round(max(maxs), 4),
            "minMean": round(statistics.fmean(mins), 4),
            "maxMean": round(statistics.fmean(maxs), 4),
            "midMean": round(statistics.fmean(mids), 4),
        }

    return {
        "n": len(faces),
        "skipped": skipped,
        "mouth_y": stats("mouth_y"),
        "mouth_x": stats("mouth_x"),
        "eye_y": stats("eye_y"),
        "eye_x": stats("eye_x"),
        "brow_y": stats("brow_y"),
        "mouth_y_extent": extent_stats("mouth_y"),
        "eye_y_extent": extent_stats("eye_y"),
        "brow_y_extent": extent_stats("brow_y"),
    }


def main() -> None:
    train_path = ANN_DIR / "list_98pt_rect_attr_train.txt"
    test_path = ANN_DIR / "list_98pt_rect_attr_test.txt"
    for path in (train_path, test_path):
        if not path.is_file():
            raise SystemExit(f"missing local WFLW annotation (not downloading): {path}")

    train = collect(train_path)
    test = collect(test_path)
    if train.get("n") != 7500 or test.get("n") != 2500:
        raise SystemExit(
            f"unexpected WFLW counts train={train.get('n')} test={test.get('n')}; "
            "refusing to overwrite face-bands.json"
        )

    n_img = sum(1 for _ in IMG_ROOT.rglob("*.jpg")) if IMG_ROOT.is_dir() else 0
    payload = {
        "_meta": {
            "source": "WFLW (mrriandmstique/wflw-wider-facial-landmarks-in-the-wild, Kaggle)",
            "regenerate": "python scripts/train/wflw-bands.py",
            "landmark_groups": "brows 33..50, eyes 60..75, mouth 76..95 (0-based, 98-point layout)",
            "coords": "fractions of the annotated face rect (x/y of box, 0..1)",
            "images_on_disk": n_img,
            "no_em_dash": True,
        },
        "train": train,
        "test": test,
    }
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(payload, indent=2) + "\n")
    print(f"wrote {OUT_JSON}")
    print(json.dumps({"train_n": train["n"], "test_n": test["n"], "images_on_disk": n_img}))


if __name__ == "__main__":
    main()
