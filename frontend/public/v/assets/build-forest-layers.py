#!/usr/bin/env python3
"""
Спрайт режем на 4 горизонтальные полосы (H/4), стопка с общим низом (параллакс).

Сверху вниз в файле:
  — верхняя четверть → forest-front.png (ближе)
  — вторая четверть → forest-mid2.png
  — третья четверть → forest-mid.png
  — нижняя четверть → forest-far.png (дальше)

Чёрный фон → прозрачный.
"""
from __future__ import annotations

import os

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "forest-parallax-sheet.png")
BLACK_MAX_CHANNEL = 22
BLACK_SUM_RGB = 55


def black_to_alpha(im: Image.Image) -> Image.Image:
    im = im.convert("RGBA")
    arr = np.array(im)
    rgb = arr[:, :, :3].astype(np.int16)
    a = arr[:, :, 3]
    maxc = np.max(rgb, axis=2)
    s = np.sum(rgb, axis=2)
    is_bg = (maxc <= BLACK_MAX_CHANNEL) & (s <= BLACK_SUM_RGB)
    new_a = np.where(is_bg, 0, a).astype(np.uint8)
    arr[:, :, 3] = new_a
    return Image.fromarray(arr, "RGBA")


def main() -> None:
    im = Image.open(SRC).convert("RGBA")
    w, h = im.size
    q = h // 4
    y0, y1, y2, y3, y4 = 0, q, 2 * q, 3 * q, h

    mapping = [
        ("forest-front", (0, y0, w, y1), "верхняя H/4 → передний план"),
        ("forest-mid2", (0, y1, w, y2), "вторая четверть"),
        ("forest-mid", (0, y2, w, y3), "третья четверть"),
        ("forest-far", (0, y3, w, y4), "нижняя H/4 → дальний план"),
    ]

    print("source", w, "x", h, "strip_h ~", q)

    for name, box, note in mapping:
        out = os.path.join(HERE, f"{name}.png")
        cropped = im.crop(box)
        cropped = black_to_alpha(cropped)
        cropped.save(out, optimize=True)
        print("wrote", out, box, "-", note)


if __name__ == "__main__":
    main()
