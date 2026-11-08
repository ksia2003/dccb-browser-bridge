"""Chrome Web Store small promo tile (440x280).

    python3 scripts/store-promo.py store/promo-small-440x280.png
"""
import sys

from PIL import Image, ImageDraw, ImageFont

FONT = "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"
FONT_REGULAR = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"

tile = Image.new("RGB", (440, 280), (241, 243, 244))
icon = Image.open("public/icon/128.png").convert("RGBA").resize((96, 96), Image.LANCZOS)
tile.paste(icon, (40, 92), icon)
draw = ImageDraw.Draw(tile)
draw.text((156, 96), "Browser Bridge", font=ImageFont.truetype(FONT, 30, index=1), fill=(32, 33, 36))
draw.text((158, 144), "내 서버의 AI가\n내 Chrome에서 일합니다", font=ImageFont.truetype(FONT_REGULAR, 18, index=1), fill=(95, 99, 104), spacing=6)
tile.save(sys.argv[1])
