"""Draw four 1920x1080 backdrops for the Home app.

Abstract, room-tinted light rather than photographs: made here, so there is
nothing to attribute and nothing to licence. A soft floor line and a few
out-of-focus lights give it the depth of a dim room without pretending to be a
picture of one. Small on purpose: four of them cost less than one photograph.

    python make-backdrops.py <output directory>
"""

import os
import random
import sys

from PIL import Image, ImageDraw, ImageFilter

W, H = 1920, 1080

PALETTES = {
    # id: (top, bottom, glow, centre, size, bokeh)
    "dusk": ((74, 90, 158), (238, 158, 126), (255, 196, 140), (0.72, 0.30), 0.55, (255, 222, 186)),
    "linen": ((116, 106, 96), (232, 212, 184), (255, 248, 226), (0.26, 0.26), 0.55, (255, 252, 242)),
    "forest": ((40, 92, 84), (124, 196, 162), (198, 248, 214), (0.66, 0.28), 0.50, (222, 255, 230)),
    "night": ((26, 34, 68), (94, 116, 176), (168, 202, 255), (0.46, 0.24), 0.50, (200, 224, 255)),
}


def gradient(top, bottom):
    strip = Image.new("RGB", (1, 256))
    for y in range(256):
        t = y / 255.0
        t = t * t * (3 - 2 * t)                      # smoothstep: no banding at the ends
        strip.putpixel((0, y), tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return strip.resize((W, H), Image.BICUBIC)


def soft_layer(colour, alpha):
    layer = Image.new("RGB", (W, H), colour)
    mask = Image.new("L", (W, H), alpha)
    return layer, mask


def glow(colour, cx, cy, radius, strength):
    mask = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(mask)
    x, y = int(cx * W), int(cy * H)
    r = int(radius * W)
    d.ellipse([x - r, y - r, x + r, y + r], fill=int(255 * strength))
    mask = mask.filter(ImageFilter.GaussianBlur(W // 6))
    layer = Image.new("RGB", (W, H), colour)
    return layer, mask


def floor_line():
    """A slightly darker bottom third, its edge blurred: the room's floor."""
    mask = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(mask)
    d.rectangle([0, int(H * 0.62), W, H], fill=120)
    mask = mask.filter(ImageFilter.GaussianBlur(H // 14))
    return Image.new("RGB", (W, H), (2, 3, 6)), mask


def bokeh(colour, seed, count=9):
    rnd = random.Random(seed)
    mask = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(mask)
    for _ in range(count):
        r = rnd.randint(26, 95)
        x = rnd.randint(int(W * 0.08), int(W * 0.92))
        y = rnd.randint(int(H * 0.08), int(H * 0.55))
        d.ellipse([x - r, y - r, x + r, y + r], fill=rnd.randint(30, 80))
    mask = mask.filter(ImageFilter.GaussianBlur(14))
    return Image.new("RGB", (W, H), colour), mask


def vignette():
    mask = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(mask)
    d.ellipse([-W // 3, -H // 3, W + W // 3, H + H // 3], fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(W // 8))
    return mask


def grain(amount=7):
    return Image.effect_noise((W, H), amount).convert("L")


def make(name, out_dir):
    top, bottom, colour, centre, size, bok = PALETTES[name]
    im = gradient(top, bottom)

    layer, mask = glow(colour, centre[0], centre[1], size, 0.60)
    im = Image.composite(layer, im, mask.point(lambda v: int(v * 0.50)))

    layer2, mask2 = bokeh(bok, name)
    im = Image.composite(layer2, im, mask2)

    floor, fmask = floor_line()
    im = Image.composite(floor, im, fmask)

    # The vignette mask is white in the middle, so invert and cap it: dark at
    # the corners, the picture left alone in the centre.
    im = Image.composite(Image.new("RGB", (W, H), (4, 5, 9)), im,
                         vignette().point(lambda v: int((255 - v) * 0.55)))
    im = Image.blend(im, Image.merge("RGB", (grain(), grain(), grain())), 0.035)

    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, name + ".jpg")
    im.save(path, "JPEG", quality=84, optimize=True, progressive=True)
    print("%-8s %6d bytes  %s" % (name, os.path.getsize(path), path))


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "."
    for name in PALETTES:
        make(name, out)


if __name__ == "__main__":
    main()
