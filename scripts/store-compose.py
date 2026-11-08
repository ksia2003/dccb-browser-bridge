"""Compose the Chrome Web Store screenshots (1280x800) from the pictures store-screenshots.mjs took.

    python3 scripts/store-compose.py store/ /tmp/window.png
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

BOLD = "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"
REGULAR = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
out = Path(sys.argv[1])
window = Image.open(sys.argv[2]).convert("RGB")


def popup(name: str, width: int = 320) -> Image.Image:
    image = Image.open(out / f"popup-{name}.png").convert("RGBA")
    return image.resize((width, round(image.height * width / image.width)), Image.LANCZOS)


def with_shadow(canvas: Image.Image, image: Image.Image, x: int, y: int, radius: int = 12) -> None:
    shadow = Image.new("RGBA", (image.width + 60, image.height + 60), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((30, 36, 30 + image.width, 36 + image.height), radius, fill=(0, 0, 0, 70))
    canvas.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(14)), (x - 30, y - 30))
    mask = Image.new("L", image.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, image.width - 1, image.height - 1), radius, fill=255)
    canvas.paste(image, (x, y), mask)


def text(draw: ImageDraw.ImageDraw, xy, value: str, size: int, bold: bool, fill, anchor: str = "la") -> None:
    draw.text(xy, value, font=ImageFont.truetype(BOLD if bold else REGULAR, size, index=1), fill=fill, anchor=anchor)


# 1. The person's own page in front, the AI working in a background tab, the popup open.
shot = window.convert("RGBA")
with_shadow(shot, popup("working"), 1280 - 320 - 24, 84)
shot.convert("RGB").save(out / "screenshot-1-working.png")

# 2. The three states a person ever sees.
canvas = Image.new("RGBA", (1280, 800), (241, 243, 244, 255))
draw = ImageDraw.Draw(canvas)
text(draw, (640, 92), "내 서버의 AI가 내 Chrome에서 일합니다", 40, True, (22, 24, 29), "mm")
text(draw, (640, 146), "한 번 붙여 넣으면 연결 끝. AI는 뒤쪽 탭에서 일하고, 내 탭은 건드리지 않습니다.", 22, False, (92, 99, 112), "mm")
names = [("setup", "① 처음 한 번 연결"), ("connected", "② 평소"), ("working", "③ AI가 작업 중")]
x = 640 - (3 * 320 + 2 * 40) // 2
for name, label in names:
    image = popup(name)
    with_shadow(canvas, image, x, 210)
    text(draw, (x + 160, 210 + image.height + 34), label, 20, True, (60, 64, 67), "mm")
    x += 360
canvas.convert("RGB").save(out / "screenshot-2-states.png")

# 3. Dark Chrome, dark popup.
canvas = Image.new("RGBA", (1280, 800), (21, 22, 26, 255))
draw = ImageDraw.Draw(canvas)
text(draw, (640, 92), "Chrome 테마를 따라 밝게, 어둡게", 40, True, (242, 243, 245), "mm")
text(draw, (640, 146), "AI가 보고 있는 페이지를 누르면 그 탭으로 갑니다.", 22, False, (164, 169, 180), "mm")
x = 640 - (2 * 320 + 60) // 2
for name in ("connected-dark", "working-dark"):
    with_shadow(canvas, popup(name), x, 220)
    x += 380
canvas.convert("RGB").save(out / "screenshot-3-dark.png")
