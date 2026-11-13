# -*- coding: utf-8 -*-
"""生成 Rhythm4K.exe 的图标（纯程序绘制，不需要外部素材）。"""
from PIL import Image, ImageDraw

S = 1024  # 先画大图再缩放，边缘更干净
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 底板
d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=(11, 15, 26, 255))

# 4 条轨道（与底板混好的实色，不要用半透明覆盖，否则会挖出透明洞）
lane_w = int(S * 0.115)
gap = int(S * 0.055)
total = 4 * lane_w + 3 * gap
x0 = (S - total) // 2
lane_color = (28, 37, 56, 255)
for i in range(4):
    x = x0 + i * (lane_w + gap)
    d.rounded_rectangle([x, int(S * 0.10), x + lane_w, int(S * 0.90)], radius=lane_w // 3,
                        fill=lane_color)

# 下落中的音符（高低错开）
notes = [
    (0, 0.62, (226, 236, 255, 255)),
    (1, 0.38, (79, 168, 255, 255)),
    (2, 0.50, (226, 236, 255, 255)),
    (3, 0.28, (79, 168, 255, 255)),
]
note_h = int(S * 0.10)
for idx, yfrac, color in notes:
    x = x0 + idx * (lane_w + gap)
    y = int(S * yfrac)
    d.rounded_rectangle([x, y, x + lane_w, y + note_h], radius=int(note_h * 0.32), fill=color)

# 判定线 + 微光
line_y = int(S * 0.795)
glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow)
gd.rounded_rectangle([x0 - int(S * 0.03), line_y - int(S * 0.022), x0 + total + int(S * 0.03), line_y + int(S * 0.022)],
                     radius=int(S * 0.02), fill=(110, 224, 255, 60))
img.alpha_composite(glow)
d.rounded_rectangle([x0 - int(S * 0.02), line_y - int(S * 0.011), x0 + total + int(S * 0.02), line_y + int(S * 0.011)],
                    radius=int(S * 0.011), fill=(150, 232, 255, 235))

out = "icon.ico"
img.resize((256, 256), Image.LANCZOS).save(
    out, format="ICO",
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
img.resize((512, 512), Image.LANCZOS).save("icon-512.png")
print("wrote", out)
