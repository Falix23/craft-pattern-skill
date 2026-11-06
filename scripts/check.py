#!/usr/bin/env python3
"""Run the same formatting, regression and output checks locally and in CI."""

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run(*command, env=None):
    print('+ ' + ' '.join(map(str, command)), flush=True)
    subprocess.run(list(map(str, command)), cwd=ROOT, env=env, check=True)


def main():
    node = shutil.which('node')
    if not node:
        raise SystemExit('验证需要 Node.js 18+。')
    run(sys.executable, '-m', 'ruff', 'check', '.')
    run(sys.executable, '-m', 'ruff', 'format', '--check', '.')
    with tempfile.TemporaryDirectory(prefix='craft-pattern-check-') as directory:
        root = Path(directory)
        env = dict(os.environ, CRAFT_PATTERN_LIBRARY=str(root / 'library'))
        run(sys.executable, '-m', 'unittest', 'discover', '-s', 'tests', '-v', env=env)
        run(node, '--test', *sorted((ROOT / 'tests').glob('test_*.cjs')), env=env)
        run(sys.executable, 'scripts/build_demo.py', '--check', env=env)
        run(
            sys.executable,
            'scripts/generate.py',
            'examples/demo.png',
            '--compare',
            '--background',
            'auto',
            '--output',
            root / 'plans',
            '--no-archive',
            env=env,
        )
    print('All checks passed; temporary outputs and test libraries were removed.')


if __name__ == '__main__':
    try:
        main()
    except subprocess.CalledProcessError as error:
        sys.exit(error.returncode)
