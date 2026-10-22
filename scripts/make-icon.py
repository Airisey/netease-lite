# Generates renderer/assets/icon.ico + icon.png from the source artwork.
#
# The icon is committed to renderer/assets/ rather than generated at build time so
# that `npm run build` stays dependency-free (no Pillow requirement on the build
# machine). Re-run this only when the artwork changes:
#     D:\IT\Python\python.exe scripts\make-icon.py
#
# Artwork lives outside the project (it is design output, not source):
#     ..\netease-lite-icon\icon-1024.png   <- the master, a 1024px PNG
# Pass a different master as the first argument if it moves.
#
# renderer/assets/icon.ico is what build.js embeds into the exe's resources
# (via resedit) and what electron/main.js hands to BrowserWindow. Keep the size
# list here in sync with what the PE resource editor writes.
from PIL import Image
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ASSETS = os.path.join(ROOT, 'renderer', 'assets')

DEFAULT_MASTER = os.path.join(os.path.dirname(ROOT), 'netease-lite-icon', 'icon-1024.png')

# One ICO entry per size: Explorer/taskbar/title bar each pick a crisp bitmap
# instead of downscaling a single large one. 256 is the largest Windows accepts
# in a .ico and the one Explorer uses on the desktop.
SIZES = [16, 32, 48, 128, 256]


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_MASTER
    if not os.path.exists(src):
        raise SystemExit('master artwork not found: ' + src)
    os.makedirs(ASSETS, exist_ok=True)

    master = Image.open(src).convert('RGBA')
    print('master', master.size, 'from', src)

    png_path = os.path.join(ASSETS, 'icon.png')
    master.resize((512, 512), Image.LANCZOS).save(png_path)
    print('wrote', png_path)

    ico_path = os.path.join(ASSETS, 'icon.ico')
    master.resize((256, 256), Image.LANCZOS).save(
        ico_path, format='ICO', sizes=[(s, s) for s in SIZES]
    )
    print('wrote', ico_path, os.path.getsize(ico_path), 'bytes')

    # small preview strip so the result can be eyeballed without opening Explorer
    strip = Image.new('RGBA', (sum(SIZES) + 8 * (len(SIZES) + 1), 264), (28, 28, 32, 255))
    x = 8
    for s in SIZES:
        im = master.resize((s, s), Image.LANCZOS)
        strip.alpha_composite(im, (x, 132 - s // 2))
        x += s + 8
    prev = os.path.join(ROOT, '_probe', 'icon-preview.png')
    os.makedirs(os.path.dirname(prev), exist_ok=True)
    strip.save(prev)
    print('wrote', prev)


if __name__ == '__main__':
    main()
