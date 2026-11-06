#!/usr/bin/env python3
"""Build README illustrations from attributed inputs and real headless outputs."""

import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import render
from PIL import Image, ImageDraw, ImageOps

ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = ROOT / 'examples' / 'showcase'
ASSETS = ROOT / 'assets' / 'showcase'


def overview(cases):
    image = Image.new('RGB', (1440, 1080), '#F4F3EB')
    draw = ImageDraw.Draw(image)
    heading = '图片 → 拼豆格子图' if render.CJK else 'YOUR IMAGE → A BEAD PATTERN'
    subtitle = (
        '四个主题，真实生成结果；尺寸、配色和用量由同一套算法计算。'
        if render.CJK
        else 'Four subjects. Actual generated patterns, colors and bead counts.'
    )
    draw.text((36, 23), heading, font=render.font(32), fill='#214E3B')
    draw.text((38, 72), subtitle, font=render.font(18), fill='#61715A')
    for index, case in enumerate(cases):
        x, y = 28 + (index % 2) * 706, 120 + (index // 2) * 472
        draw.rounded_rectangle((x, y, x + 678, y + 450), radius=18, fill='#FFFEFA')
        selected = case['plans'][case['selected_plan'] - 1]
        title = case['title'] if render.CJK else case['english']
        draw.text((x + 22, y + 17), title, font=render.font(24), fill='#214E3B')
        for offset, label in (
            (24, '小红书参考素材' if render.CJK else 'SOURCE REFERENCE'),
            (357, '本 skill 生成 · 预览' if render.CJK else 'GENERATED PREVIEW'),
        ):
            draw.text((x + offset, y + 58), label, font=render.font(15), fill='#61715A')
        with Image.open(EXAMPLES / case['input']) as source:
            original = ImageOps.exif_transpose(source).convert('RGBA')
            original = ImageOps.contain(original, (290, 300), Image.Resampling.LANCZOS)
        pattern = json.loads((ROOT / selected['files']['json']).read_text('utf-8'))
        pixel = ImageOps.contain(
            render.grid(pattern, cell=1, grid_lines=False), (290, 300), Image.Resampling.NEAREST
        )
        draw.rectangle((x + 24, y + 87, x + 314, y + 387), fill='white')
        image.paste(
            original,
            (x + 24 + (290 - original.width) // 2, y + 87 + (300 - original.height) // 2),
            original,
        )
        image.paste(pixel, (x + 357 + (290 - pixel.width) // 2, y + 87 + (300 - pixel.height) // 2))
        draw.text((x + 322, y + 215), '→', font=render.font(25), fill='#A1AC91')
        detail = {'low': '低', 'medium': '中', 'high': '高'}[selected['color_detail']]
        text = (
            f'{selected["width"]} × {selected["height"]} 格 · {detail}区分度 · {selected["color_count"]} 色 · {selected["bead_count"]:,} 颗'
            if render.CJK
            else f'{selected["width"]} x {selected["height"]} | {selected["color_count"]} colors | {selected["bead_count"]:,} beads'
        )
        draw.text((x + 22, y + 413), text, font=render.font(17), fill='#38583E')
    image.save(ASSETS / 'overview.png')


def build_showcase():
    config = json.loads((EXAMPLES / 'cases.json').read_text('utf-8'))
    ASSETS.mkdir(parents=True, exist_ok=True)
    patterns = EXAMPLES / 'patterns'
    patterns.mkdir(exist_ok=True)
    summary = []
    with tempfile.TemporaryDirectory(prefix='craft-pattern-showcase-') as directory:
        for case in config['cases']:
            source = EXAMPLES / case['input']
            if not source.is_file():
                raise FileNotFoundError(f'Missing attributed local source: {source}')
            plans_path = Path(directory) / f'{case["id"]}-plans.json'
            plans_path.write_text(json.dumps(case['plans'], ensure_ascii=False), 'utf-8')
            command = [
                sys.executable,
                str(ROOT / 'scripts' / 'generate.py'),
                str(source),
                '--plans',
                str(plans_path),
                '--title',
                case['title'],
                '--no-archive',
                '--output',
                str(Path(directory) / case['id']),
            ]
            result = subprocess.run(command, text=True, capture_output=True, check=True)
            generated = json.loads(result.stdout)
            entry = {key: case[key] for key in ('id', 'title', 'english', 'input', 'selected_plan')}
            entry['source_sha256'] = hashlib.sha256(source.read_bytes()).hexdigest()
            entry['plans'] = []
            for number, plan in enumerate(generated['plans'], 1):
                values = {
                    key: plan[key]
                    for key in (
                        'name',
                        'width',
                        'height',
                        'color_detail',
                        'color_count',
                        'bead_count',
                        'blank_cells',
                    )
                }
                stem = f'{case["id"]}-{number:02d}'
                files = {}
                for key, extension in (('json', 'json'), ('svg', 'svg'), ('materials', 'csv')):
                    target = patterns / f'{stem}.{extension}'
                    shutil.copyfile(plan['files'][key], target)
                    files[key] = target.relative_to(ROOT).as_posix()
                for key in ('preview', 'chart'):
                    target = ASSETS / f'{stem}-{key}.png'
                    shutil.copyfile(plan['files'][key], target)
                    files[key] = target.relative_to(ROOT).as_posix()
                values['files'] = files
                entry['plans'].append(values)
            if 'comparison' in generated:
                target = ASSETS / f'{case["id"]}-comparison.png'
                shutil.copyfile(generated['comparison'], target)
                entry['comparison'] = target.relative_to(ROOT).as_posix()
            summary.append(entry)
    (EXAMPLES / 'summary.json').write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + '\n', 'utf-8'
    )
    overview(summary)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    build_showcase()
