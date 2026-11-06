#!/usr/bin/env python3
"""Rebuild the committed synthetic editor demo, or verify it matches the sources."""

import argparse
import tempfile
from pathlib import Path

from build import build

ROOT = Path(__file__).resolve().parents[1]
FILES = ('index.html', 'index.json')


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
        stale = [
            name
            for name in FILES
            if not (ROOT / 'docs' / name).is_file()
            or (ROOT / 'docs' / name).read_bytes() != (output / name).read_bytes()
        ]
    if stale:
        parser.exit(
            1, '示例与源码不同步：' + ', '.join(stale) + '；运行 python scripts/build_demo.py\n'
        )
    print('Committed demo matches the template, assets and example configuration.')


if __name__ == '__main__':
    main()
