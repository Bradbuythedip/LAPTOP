#!/usr/bin/env python3
"""Regenerate every derived image from web/token.jpg.

    pip install Pillow          # this one tool needs it; the test suite does not
    python3 tools/art.py        # say what it would do
    python3 tools/art.py --write

WHY THIS EXISTS. The artwork has now arrived three times as a GitHub web upload, each time to
a different path, each time causing a merge conflict — because uploading a file replaces one
image while the other five still show the old one. That is not a nuisance, it is the failure
this project cares about: the picture on pump.fun and the picture on the site must be the same
picture, and a careful buyer comparing them is exactly the check a copycat fails.

So there is ONE SOURCE and everything else is generated from it:

    web/token.jpg     the artwork. Replace THIS file and nothing else.
                      It is also what the launch pins to IPFS, byte for byte.

      -> web/snooze.png       1024  the large still
      -> web/hero.png          800  og:image, and a real PNG because vercel.json
                                    sends nosniff and a JPEG named .png is dropped
      -> web/snooze-768.webp   768
      -> web/snooze-512.webp   512  what the page displays
      -> web/hero-512.webp     512
      -> web/snooze-256.webp   256
      -> web/icon.png          256  favicon and apple-touch-icon

web/bg.webp is NOT generated: it is the background, a different image, and nothing here
touches it.
"""
import argparse
import hashlib
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "web" / "token.jpg"

# (filename, pixels, format). Order is largest first so a failure is loudest early.
DERIVED = [
    ("snooze.png",      1024, "PNG"),
    ("hero.png",         800, "PNG"),
    ("snooze-768.webp",  768, "WEBP"),
    ("snooze-512.webp",  512, "WEBP"),
    ("hero-512.webp",    512, "WEBP"),
    ("snooze-256.webp",  256, "WEBP"),
    ("icon.png",         256, "PNG"),
]


def main(argv=None):
    p = argparse.ArgumentParser(
        prog="tools/art.py",
        description="Regenerate every derived image from web/token.jpg.",
        epilog="Replace web/token.jpg, run this with --write, commit. Do not edit the derived "
               "files by hand and do not upload over one of them — that is what leaves the "
               "site showing a different picture from the token.")
    p.add_argument("--write", action="store_true", help="actually write the files")
    args = p.parse_args(argv)

    try:
        from PIL import Image
    except ImportError:
        print("This tool needs Pillow:  pip install Pillow\n"
              "(The test suite does not — only this.)", file=sys.stderr)
        return 2

    if not SOURCE.is_file():
        print("no artwork at %s" % SOURCE, file=sys.stderr)
        return 2

    src = Image.open(SOURCE)
    if src.width != src.height:
        print("! %s is %dx%d, not square. Every derived image is square, so it will be "
              "distorted." % (SOURCE.name, src.width, src.height), file=sys.stderr)
    print("  source  %s  %s %dx%d  %s bytes"
          % (SOURCE.name, src.format, src.width, src.height,
             format(SOURCE.stat().st_size, ",")))
    print("  sha256  %s" % hashlib.sha256(SOURCE.read_bytes()).hexdigest()[:32])
    print()
    rgb = src.convert("RGB")

    for name, n, fmt in DERIVED:
        out = ROOT / "web" / name
        if n > src.width:
            print("  !! %s wants %dpx and the source is only %dpx — it would be upscaled"
                  % (name, n, src.width))
        im = rgb.resize((n, n), Image.LANCZOS)
        if not args.write:
            was = format(out.stat().st_size, ",") if out.is_file() else "absent"
            print("  would write  %-18s %4dpx %-5s  (currently %s bytes)" % (name, n, fmt, was))
            continue
        if fmt == "WEBP":
            im.save(out, "WEBP", quality=88, method=6)
        else:
            im.save(out, "PNG", optimize=True)
        print("  wrote        %-18s %4dpx %-5s  %10s bytes"
              % (name, n, fmt, format(out.stat().st_size, ",")))

    if not args.write:
        print("\n  nothing written. Re-run with --write.")
        return 0
    print("\n  Every image on the site is now the artwork the launch pins.")
    print("  test/run.sh checks that pixel-wise, so a mismatch is a failed test.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
