# Genera los iconos del launcher (res/mipmap-*/ic_launcher.png). Uso: python3 gen_icons.py
from PIL import Image, ImageDraw, ImageFont
import os
for dpi, size in [("mdpi", 48), ("hdpi", 72), ("xhdpi", 96), ("xxhdpi", 144), ("xxxhdpi", 192)]:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * 0.22), fill=(245, 166, 35, 255))
    try:
        f = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", int(size * 0.62))
    except Exception:
        f = ImageFont.load_default()
    d.text((size / 2, size / 2), "R", font=f, fill=(11, 11, 16, 255), anchor="mm")
    os.makedirs(f"app/res/mipmap-{dpi}", exist_ok=True)
    img.save(f"app/res/mipmap-{dpi}/ic_launcher.png")
