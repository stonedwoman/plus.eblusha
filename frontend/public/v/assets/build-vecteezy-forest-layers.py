#!/usr/bin/env python3
"""
Извлекает 4 лесных слоя из большого Vecteezy SVG в отдельные SVG-файлы для нижнего параллакса.

Источник по умолчанию:
  /DATA/valheim/vecteezy_vector-illustration-of-summer-landscape-smoky-forest-green_7633589.svg
"""

from __future__ import annotations

import copy
import re
import xml.etree.ElementTree as ET
from pathlib import Path

SVG_NS = "http://www.w3.org/2000/svg"
ET.register_namespace("", SVG_NS)
NS = {"svg": SVG_NS}

HERE = Path(__file__).resolve().parent
SRC = Path(
    "/DATA/valheim/vecteezy_vector-illustration-of-summer-landscape-smoky-forest-green_7633589.svg"
)

URL_RE = re.compile(r"url\(#([^)]+)\)")
NUM_RE = re.compile(r"-?\d+(?:\.\d+)?")

LAYER_MAP = [
    ("clip-4", "forest-vecteezy-far.svg"),
    ("clip-10", "forest-vecteezy-mid.svg"),
    ("clip-13", "forest-vecteezy-mid2.svg"),
    ("clip-31", "forest-vecteezy-front.svg"),
]
SOURCE_WIDTH = 5500.0
TILE_OVERLAP = 4.0


def _fmt_num(value: float) -> str:
    rounded = round(value)
    if abs(value - rounded) < 1e-6:
        return str(int(rounded))
    return f"{value:.3f}"


def _build_svg_root(width: float, ymin: float, height: float) -> ET.Element:
    return ET.Element(
        "svg",
        {
            "width": _fmt_num(width),
            "height": _fmt_num(height),
            "viewBox": f"0 {_fmt_num(ymin)} {_fmt_num(width)} {_fmt_num(height)}",
            "preserveAspectRatio": "xMidYMax meet",
            "aria-hidden": "true",
        },
    )


def _collect_refs(elem: ET.Element, refs: set[str] | None = None) -> set[str]:
    if refs is None:
        refs = set()
    for value in elem.attrib.values():
        for ref in URL_RE.findall(value):
            refs.add(ref)
    for child in list(elem):
        _collect_refs(child, refs)
    return refs


def _clip_extents(def_map: dict[str, ET.Element], clip_id: str) -> tuple[float, float, float, float] | None:
    el = def_map.get(clip_id)
    if el is None:
        return None
    path = el.find(".//svg:path", NS)
    if path is None:
        return None
    nums = [float(x) for x in NUM_RE.findall(path.attrib.get("d", ""))]
    if len(nums) < 4:
        return None
    xs = nums[0::2]
    ys = nums[1::2]
    return min(xs), min(ys), max(xs), max(ys)


def _expand_refs(def_map: dict[str, ET.Element], ids: set[str]) -> set[str]:
    out = set(ids)
    changed = True
    while changed:
        changed = False
        for ref in list(out):
            el = def_map.get(ref)
            if el is None:
                continue
            nested = _collect_refs(el)
            for nref in nested:
                if nref not in out:
                    out.add(nref)
                    changed = True
    return out


def main() -> None:
    root = ET.parse(SRC).getroot()
    defs = root.find("svg:defs", NS)
    if defs is None:
        raise RuntimeError("defs not found in source SVG")

    children = list(root)
    def_map = {el.attrib["id"]: el for el in defs if "id" in el.attrib}

    def find_top_group(clip_id: str) -> ET.Element:
        target = f"url(#{clip_id})"
        for child in children:
            if child.tag == f"{{{SVG_NS}}}g" and child.attrib.get("clip-path") == target:
                return child
        raise RuntimeError(f"top-level group for {clip_id} not found")

    for clip_id, out_name in LAYER_MAP:
        group = find_top_group(clip_id)
        refs = _expand_refs(def_map, _collect_refs(group))

        ymins: list[float] = []
        ymaxs: list[float] = []
        for ref in refs:
            if not ref.startswith("clip-"):
                continue
            ext = _clip_extents(def_map, ref)
            if ext is None:
                continue
            _, ymin, _, ymax = ext
            ymins.append(ymin)
            ymaxs.append(ymax)

        if ymins and ymaxs:
            ymin = max(0.0, min(ymins) - 40.0)
            ymax = max(ymaxs) + 30.0
        else:
            ymin = 0.0
            ymax = 1800.0

        height = ymax - ymin

        out_root = _build_svg_root(SOURCE_WIDTH, ymin, height)
        out_defs = ET.SubElement(out_root, "defs")

        for ref in sorted(refs):
            el = def_map.get(ref)
            if el is not None:
                out_defs.append(copy.deepcopy(el))

        out_root.append(copy.deepcopy(group))

        out_path = HERE / out_name
        ET.ElementTree(out_root).write(out_path, encoding="utf-8", xml_declaration=True)
        print(f"wrote {out_path} viewBox={out_root.attrib['viewBox']}")

        tile_width = SOURCE_WIDTH * 2.0 - TILE_OVERLAP
        tile_root = _build_svg_root(tile_width, ymin, height)
        tile_defs = ET.SubElement(tile_root, "defs")
        for ref in sorted(refs):
            el = def_map.get(ref)
            if el is not None:
                tile_defs.append(copy.deepcopy(el))
        tile_root.append(copy.deepcopy(group))
        mirrored_group = ET.SubElement(
            tile_root,
            "g",
            {"transform": f"translate({_fmt_num(tile_width)},0) scale(-1,1)"},
        )
        mirrored_group.append(copy.deepcopy(group))

        tile_path = HERE / out_name.replace("forest-vecteezy-", "forest-vecteezy-tile-")
        ET.ElementTree(tile_root).write(tile_path, encoding="utf-8", xml_declaration=True)
        print(
            f"wrote {tile_path} viewBox={tile_root.attrib['viewBox']} overlap={_fmt_num(TILE_OVERLAP)}"
        )


if __name__ == "__main__":
    main()
