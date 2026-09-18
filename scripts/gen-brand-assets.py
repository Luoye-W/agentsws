#!/usr/bin/env python3
"""从母品牌标记出一套位图与 SVG 资产（WP112）。可重跑，产物不手改。

    node_modules 装好之后：
      npx tsc -b packages/brand        # 这个脚本读它的 dist
      python3 scripts/gen-brand-assets.py

出这几样：

  apps/workstation/public/favicon.svg        深色圆底 + 渐变标记
  apps/workstation/public/favicon-32.png     32px 后备（老浏览器不吃 SVG favicon）
  apps/desktop/build/icon.png                1024，macOS 图标网格：824 内容区 + 圆角
  apps/desktop/build/trayTemplate.png        22，单色模板图（黑 + alpha，系统自己反色）
  apps/desktop/build/trayTemplate@2x.png     44
  docs/assets/brand/mark-{dark,light,mono}.svg  仓库门面用的 SVG 副本

并把托盘那两张的 base64 **写回** `apps/desktop/src/tray-icon.ts`——托盘图标是壳启动
的第一件事，不该依赖打包后的资源路径，所以它是内嵌的 data URL。

⚠️ 几何与颜色一个数字都不在这个文件里定义：全部从 `@agentsws/brand` 的 dist 里读
（`node -e` 吐一份 JSON 过来）。那个包是母品牌规范
`00_Brand/品牌设计规范-v2.md` 在代码里的唯一副本；要改标记，回规范改，再改那个包。

⚠️ 规范 §1.3：**最小可用尺寸 28px**。托盘图标只有 22/44，所以它一律走**单色**——
再小方块间的缝会并起来，渐变只剩一团糊。单色本来就是规范给这一档的 fallback。
"""

from __future__ import annotations

import base64
import json
import re
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
BRAND_DIST = ROOT / "packages/brand/dist/index.js"
# 4 倍超采样再 LANCZOS 缩小，边缘不会毛（与母品牌 gen.py 同一套做法）
SS = 4


def brand() -> dict:
    """把几何与颜色从 `@agentsws/brand` 里读出来（单一真源，不在这儿抄一遍）。"""
    if not BRAND_DIST.exists():
        sys.exit(f"先建一下品牌包：npx tsc -b packages/brand（缺 {BRAND_DIST}）")
    code = f"""
import * as b from {json.dumps(BRAND_DIST.as_uri())};
console.log(JSON.stringify({{
  blocks: b.ALL_BLOCKS,
  size: b.BLOCK_SIZE,
  radius: b.BLOCK_RADIUS,
  box: b.MARK_BOX,
  axis: b.GRADIENT_AXIS,
  dark: b.STOPS_ON_DARK,
  light: b.STOPS_ON_LIGHT,
  ink: b.INK,
  paper: b.PAPER,
  minGradientPx: b.MIN_GRADIENT_PX,
  svgDark: b.BRAND_MARK_SVG_DARK,
  svgLight: b.BRAND_MARK_SVG_LIGHT,
  svgMono: b.BRAND_MARK_SVG_MONO,
}}));
"""
    out = subprocess.run(
        ["node", "--input-type=module", "-e", code],
        capture_output=True,
        text=True,
        check=True,
        cwd=ROOT,
    )
    return json.loads(out.stdout)


B = brand()
BLOCKS = [(b["x"], b["y"]) for b in B["blocks"]]
SU: float = B["size"]
RU: float = B["radius"]
BOX = B["box"]


def rgb(color: str) -> tuple[int, int, int]:
    return (int(color[1:3], 16), int(color[3:5], 16), int(color[5:7], 16))


def ramp(t: float, stops: list[dict]) -> tuple[int, int, int]:
    for i in range(len(stops) - 1):
        a, c = stops[i], stops[i + 1]
        if a["offset"] <= t <= c["offset"]:
            span = c["offset"] - a["offset"]
            u = 0.0 if span == 0 else (t - a["offset"]) / span
            ca, cc = rgb(a["color"]), rgb(c["color"])
            return tuple(int(round(ca[k] + (cc[k] - ca[k]) * u)) for k in range(3))
    return rgb(stops[-1]["color"] if t > stops[-1]["offset"] else stops[0]["color"])


def mark_mask(canvas: int, ratio: float) -> tuple[Image.Image, float, float, float]:
    """标记的圆角方块 mask，按**外框 65×65** 居中（§1.1：不是按 100×100 画布居中）。"""
    scale = canvas * ratio / BOX["width"]
    ox = (canvas - BOX["width"] * scale) / 2 - BOX["x"] * scale
    oy = (canvas - BOX["height"] * scale) / 2 - BOX["y"] * scale
    mask = Image.new("L", (canvas, canvas), 0)
    d = ImageDraw.Draw(mask)
    for x, y in BLOCKS:
        x0, y0 = ox + x * scale, oy + y * scale
        d.rounded_rectangle(
            [x0, y0, x0 + SU * scale, y0 + SU * scale], radius=RU * scale, fill=255
        )
    return mask, scale, ox, oy


def gradient_field(canvas: int, scale: float, ox: float, oy: float, stops: list[dict]):
    """一条 `userSpaceOnUse` 渐变铺满整幅画布，方块把它切开（§1.2）。"""
    ax, ay = B["axis"]["x1"], B["axis"]["y1"]
    bx, by = B["axis"]["x2"], B["axis"]["y2"]
    p1 = np.array([ox + ax * scale, oy + ay * scale])
    v = np.array([(bx - ax) * scale, (by - ay) * scale])
    l2 = float(v @ v)
    yy, xx = np.mgrid[0:canvas, 0:canvas]
    t = np.clip(((xx - p1[0]) * v[0] + (yy - p1[1]) * v[1]) / l2, 0, 1)
    lut = np.array([ramp(i / 255, stops) for i in range(256)], dtype=np.uint8)
    return lut[(t * 255).astype(np.uint8)]


def base_shape(canvas: int, kind: str, fill: tuple[int, int, int]) -> Image.Image:
    """深色底：`circle` 是 favicon 那个圆底，`squircle` 是 macOS 图标网格那个圆角方。"""
    img = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if kind == "circle":
        d.ellipse([0, 0, canvas - 1, canvas - 1], fill=(*fill, 255))
        return img
    # Apple 的图标网格：1024 的画布里内容区 824、圆角 185.4
    pad = round(canvas * (1024 - 824) / 2 / 1024)
    radius = canvas * 185.4 / 1024
    d.rounded_rectangle(
        [pad, pad, canvas - 1 - pad, canvas - 1 - pad], radius=radius, fill=(*fill, 255)
    )
    return img


def render(
    out: Path,
    px: int,
    *,
    ratio: float,
    stops: list[dict] | None = None,
    solid: tuple[int, int, int] | None = None,
    base: str | None = None,
    base_fill: tuple[int, int, int] | None = None,
    content_of: float = 1.0,
) -> Path:
    """出一张 PNG。`content_of` 是标记相对**底形**的占比（底形本身可能比画布小）。"""
    canvas = px * SS
    inner = round(canvas * content_of)
    mask, scale, ox, oy = mark_mask(inner, ratio)
    if solid is not None:
        fill = np.full((inner, inner, 3), solid, dtype=np.uint8)
    else:
        fill = gradient_field(inner, scale, ox, oy, stops or B["dark"])
    mark = Image.fromarray(fill, "RGB").convert("RGBA")
    mark.putalpha(mask)

    img = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    if base is not None:
        img = base_shape(canvas, base, base_fill or rgb(B["ink"]))
    off = (canvas - inner) // 2
    img.alpha_composite(mark, (off, off))
    img.resize((px, px), Image.LANCZOS).save(out)
    return out


# favicon 的圆底按 §1.3「方形卡片 / 深底块」那一档取 64%：
# 头像那档的 70% 是给**方底再被平台裁圆**用的，我们这里画的是真圆，
# 70% 时标记外框的角刚好顶到弧上（安全区只剩约 14 个单位，不足一个方块宽），
# 64% 之后四周留 18 个单位，满足 §1.4。
FAVICON_RATIO = 0.64


def favicon_svg() -> str:
    """深色圆底 + 渐变标记（§1.2「浅底的坑」第 1 条解法）。"""
    ratio = FAVICON_RATIO
    scale = 100 * ratio / BOX["width"]
    ox = (100 - BOX["width"] * scale) / 2 - BOX["x"] * scale
    oy = (100 - BOX["height"] * scale) / 2 - BOX["y"] * scale
    stops = "".join(
        f'<stop offset="{s["offset"] * 100:g}%" stop-color="{s["color"]}"/>' for s in B["dark"]
    )
    ax = B["axis"]
    rects = "".join(
        f'<rect x="{x:g}" y="{y:g}" width="{SU:g}" height="{SU:g}" rx="{RU:g}" fill="url(#fav)"/>'
        for x, y in BLOCKS
    )
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"'
        ' role="img" aria-label="agentsws">\n'
        "  <!-- WP112 · 出海Agents工坊 标记。由 scripts/gen-brand-assets.py 生成，不手改。\n"
        "       浅底的坑（规范 §1.2）：这里走的是第 1 条解法——深色圆底。 -->\n"
        "  <title>agentsws</title>\n"
        f'  <circle cx="50" cy="50" r="50" fill="{B["ink"]}"/>\n'
        "  <defs>\n"
        f'    <linearGradient id="fav" gradientUnits="userSpaceOnUse"'
        f' x1="{ax["x1"]}" y1="{ax["y1"]}" x2="{ax["x2"]}" y2="{ax["y2"]}">{stops}</linearGradient>\n'
        "  </defs>\n"
        f'  <g transform="translate({ox:.5f},{oy:.5f}) scale({scale:.6f})">{rects}</g>\n'
        "</svg>\n"
    )


def patch_tray_icon(one_x: Path, two_x: Path) -> None:
    """把两张托盘图的 base64 写回 `tray-icon.ts`（只动那两个常量，别的一个字不碰）。"""
    ts = ROOT / "apps/desktop/src/tray-icon.ts"
    src = ts.read_text(encoding="utf-8")
    for name, png in (("TRAY_ICON_PNG_BASE64", one_x), ("TRAY_ICON_2X_PNG_BASE64", two_x)):
        data = base64.b64encode(png.read_bytes()).decode("ascii")
        src, n = re.subn(
            rf"(export const {name} =\n  ')[A-Za-z0-9+/=]+(')",
            lambda m, d=data: f"{m.group(1)}{d}{m.group(2)}",
            src,
        )
        if n != 1:
            sys.exit(f"{ts} 里没找到 {name}（或者找到不止一处）")
    ts.write_text(src, encoding="utf-8")
    print(f"  {ts.relative_to(ROOT)}（两个 base64 常量已同步）")


def main() -> None:
    made: list[Path] = []

    # ── 工作台 favicon ────────────────────────────────────────────────
    pub = ROOT / "apps/workstation/public"
    pub.mkdir(parents=True, exist_ok=True)
    (pub / "favicon.svg").write_text(favicon_svg(), encoding="utf-8")
    made.append(pub / "favicon.svg")
    made.append(
        render(
            pub / "favicon-32.png",
            32,
            ratio=FAVICON_RATIO,
            stops=B["dark"],
            base="circle",
        )
    )

    # ── 桌面壳图标（品牌 avatar-dark 方案，macOS 图标网格）────────────
    build = ROOT / "apps/desktop/build"
    made.append(
        render(
            build / "icon.png",
            1024,
            ratio=0.70,
            stops=B["dark"],
            base="squircle",
            content_of=824 / 1024,
        )
    )

    # ── 托盘：单色模板图（黑 + alpha，macOS 按明暗自己反色）──────────
    # 22 / 44 都在 28px 以下 → 规范 §1.3 说的那一档，一律单色
    tray1 = render(build / "trayTemplate.png", 22, ratio=0.86, solid=(0, 0, 0))
    tray2 = render(build / "trayTemplate@2x.png", 44, ratio=0.86, solid=(0, 0, 0))
    made += [tray1, tray2]

    # ── 仓库门面用的 SVG 副本 ────────────────────────────────────────
    brand_docs = ROOT / "docs/assets/brand"
    brand_docs.mkdir(parents=True, exist_ok=True)
    for name, svg in (
        ("mark-dark.svg", B["svgDark"]),
        ("mark-light.svg", B["svgLight"]),
        ("mark-mono.svg", B["svgMono"]),
    ):
        (brand_docs / name).write_text(f"{svg}\n", encoding="utf-8")
        made.append(brand_docs / name)

    for p in made:
        print(f"  {p.relative_to(ROOT)}")
    patch_tray_icon(tray1, tray2)


if __name__ == "__main__":
    main()
