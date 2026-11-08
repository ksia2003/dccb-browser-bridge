"""Place the popup screenshot on a 1280x800 store image with a short caption.

    python3 scripts/store-compose.py popup.png store/screenshot-3-popup.png
"""
import sys

from PIL import Image, ImageDraw, ImageFont

FONT = "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"
FONT_REGULAR = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"

popup = Image.open(sys.argv[1]).convert("RGB")
canvas = Image.new("RGB", (1280, 800), (241, 243, 244))
scale = min(1.0, 740 / popup.height)
popup = popup.resize((int(popup.width * scale), int(popup.height * scale)), Image.LANCZOS)
x, y = 1280 - popup.width - 110, (800 - popup.height) // 2
draw = ImageDraw.Draw(canvas)
draw.rounded_rectangle((x - 2, y - 2, x + popup.width + 2, y + popup.height + 2), radius=10, fill=(218, 220, 224))
canvas.paste(popup, (x, y))
title = ImageFont.truetype(FONT, 40, index=1)
body = ImageFont.truetype(FONT_REGULAR, 24, index=1)
draw.text((90, 250), "내 서버의 AI가\n내 Chrome에서 일합니다", font=title, fill=(32, 33, 36), spacing=14)
draw.text((90, 400), "· 대시보드의 주소와 코드로 한 번 연결\n· AI는 'AI · 기기' 탭 그룹 안에서만 작업\n· 언제든 끄거나 사람에게 넘기기", font=body, fill=(95, 99, 104), spacing=16)
canvas.save(sys.argv[2])
