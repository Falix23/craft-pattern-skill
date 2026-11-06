#!/usr/bin/env python3
"""Rebuild the committed synthetic editor demo, or verify it matches the sources."""

import argparse
import base64
import binascii
import io
import re
import tempfile
from pathlib import Path

from build import build
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
FILES = ('index.html', 'index.json')
SOURCE_PNG = re.compile(r'(?<=src=")data:image/png;base64,[^"]+')


def same_page(first, second):
    """Compare source pixels instead of platform-dependent PNG compression bytes."""
    first, second = first.decode('utf-8'), second.decode('utf-8')
    if SOURCE_PNG.sub('__SOURCE_PNG__', first) != SOURCE_PNG.sub('__SOURCE_PNG__', second):
        return False
    first_images, second_images = SOURCE_PNG.findall(first), SOURCE_PNG.findall(second)
    if len(first_images) != 1 or len(second_images) != 1:
        return False
    pixels = []
    try:
        for source in first_images + second_images:
            with Image.open(
                io.BytesIO(base64.b64decode(source.split(',', 1)[1], validate=True))
            ) as image:
                pixels.append((image.size, image.convert('RGBA').tobytes()))
    except (ValueError, OSError, binascii.Error):
        return False
    return pixels[0] == pixels[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--check', action='store_true', help='检查 docs 示例是否与源码同步，不改写文件'
    )
    args = parser.parse_args()
    config = ROOT / 'examples' / 'input.json'
    if not args.check:
        # Call the build function directly so maintenance never archives demo cases.
        build(config, ROOT / 'docs' / 'index.html')
        print('Rebuilt docs/index.html and docs/index.json from the synthetic example.')
        return
    with tempfile.TemporaryDirectory(prefix='craft-pattern-demo-') as directory:
        output = Path(directory)
        build(config, output / 'index.html')
        stale = []
        for name in FILES:
            committed = ROOT / 'docs' / name
            if not committed.is_file():
                stale.append(name)
                continue
            expected, actual = committed.read_bytes(), (output / name).read_bytes()
            matches = same_page(expected, actual) if name.endswith('.html') else expected == actual
            if not matches:
                stale.append(name)
    if stale:
        parser.exit(
            1, '示例与源码不同步：' + ', '.join(stale) + '；运行 python scripts/build_demo.py\n'
        )
    print('Committed demo matches the template, assets and example configuration.')


if __name__ == '__main__':
    main()
