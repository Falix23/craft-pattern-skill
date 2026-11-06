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


def low_resolution_overview(cases):
    """Compare only resolution; each subject keeps its selected processing settings."""
    image = Image.new('RGB', (1416, 1670), '#F4F3EB')
    draw = ImageDraw.Draw(image)
    heading = '低分辨率对比：32 / 48 / 64 格' if render.CJK else 'LOW RESOLUTION: 32 / 48 / 64'
    subtitle = (
        '同一输入、同一配色设置，只调整最长边；预览省略辅助线，便于观察轮廓和细节。'
        if render.CJK
        else 'Same source and color settings. Only the longest edge changes. Grid-free previews.'
    )
    draw.text((30, 20), heading, font=render.font(30), fill='#214E3B')
    draw.text((32, 66), subtitle, font=render.font(18), fill='#61715A')
    for column, edge in enumerate((32, 48, 64)):
        draw.text(
            (190 + column * 400, 106),
            f'{edge} 格' if render.CJK else f'{edge} cells',
            font=render.font(24),
            fill='#214E3B',
        )
    for row, case in enumerate(cases):
        y = 150 + row * 370
        name = case['title'].replace('拼豆', '') if render.CJK else case['english']
        draw.text(
            (25, y + 140),
            render.fit_text(draw, name, render.font(23), 145),
            font=render.font(23),
            fill='#214E3B',
        )
        for column, plan in enumerate(case['plans']):
            x = 180 + column * 400
            draw.rounded_rectangle((x, y, x + 380, y + 348), radius=15, fill='#FFFEFA')
            pattern = json.loads((ROOT / plan['files']['json']).read_text('utf-8'))
            pixel = ImageOps.contain(
                render.grid(pattern, cell=1, grid_lines=False), (256, 256), Image.Resampling.NEAREST
            )
            image.paste(pixel, (x + (380 - pixel.width) // 2, y + 16 + (256 - pixel.height) // 2))
            label = (
                f'{plan["width"]} × {plan["height"]} 格 · {plan["color_count"]} 色'
                if render.CJK
                else f'{plan["width"]} x {plan["height"]} | {plan["color_count"]} colors'
            )
            amount = f'{plan["bead_count"]:,} 颗' if render.CJK else f'{plan["bead_count"]:,} beads'
            draw.text((x + 20, y + 284), label, font=render.font(18), fill='#38583E')
            draw.text((x + 20, y + 313), amount, font=render.font(18), fill='#61715A')
    draw.text(
        (30, 1642),
        '棋盘格表示留空；每个方案另附完整网格、符号与逐色用量。'
        if render.CJK
        else 'Checkerboard = no bead. Each plan includes a symbol chart and exact material counts.',
        font=render.font(16),
        fill='#61715A',
    )
    image.save(ASSETS / 'low-resolution-comparison.png')


def expression_comparison(cases):
    """Show one illustration at three resolutions, including the same face crop."""
    case = next(case for case in cases if case['id'] == 'bubu')
    image = Image.new('RGB', (1280, 850), '#F4F3EB')
    draw = ImageDraw.Draw(image)
    draw.text(
        (25, 18),
        '布布一二：颜色分区与表情' if render.CJK else 'BUBU & DUDU: REGIONS AND EXPRESSION',
        font=render.font(29),
        fill='#214E3B',
    )
    draw.text(
        (27, 63),
        '低 32 / 中 48 / 高 64 格；配色统一为中档、最多 8 色，实际用色按格子统计。'
        if render.CJK
        else '32 / 48 / 64 cells. Medium color distinction, 8-color cap. Actual counts.',
        font=render.font(18),
        fill='#61715A',
    )
    with Image.open(EXAMPLES / case['input']) as source:
        source = ImageOps.exif_transpose(source).convert('RGBA')
        original = Image.new('RGB', source.size, 'white')
        original.paste(source, mask=source.getchannel('A'))
    panels = [(original, None)]
    for plan in case['plans']:
        pattern = json.loads((ROOT / plan['files']['json']).read_text('utf-8'))
        panels.append((render.grid(pattern, cell=1, grid_lines=False), plan))
    labels = (
        ('原图参考', '低分辨率 · 32 格', '中分辨率 · 48 格', '高分辨率 · 64 格')
        if render.CJK
        else ('SOURCE', 'LOW: 32', 'MEDIUM: 48', 'HIGH: 64')
    )
    for column, ((picture, plan), label) in enumerate(zip(panels, labels)):
        x = 20 + column * 315
        draw.text((x + 10, 110), label, font=render.font(22), fill='#214E3B')
        draw.rounded_rectangle((x, 151, x + 300, 488), radius=14, fill='#FFFEFA')
        method = Image.Resampling.NEAREST if plan else Image.Resampling.LANCZOS
        full = ImageOps.contain(picture, (278, 282), method)
        image.paste(full, (x + (300 - full.width) // 2, 162 + (282 - full.height) // 2))
        caption = (
            (
                f'{plan["width"]}×{plan["height"]} 格 · {plan["color_count"]} 色 · {plan["bead_count"]:,} 颗'
                if render.CJK
                else f'{plan["width"]}x{plan["height"]} | {plan["color_count"]} colors | {plan["bead_count"]:,} beads'
            )
            if plan
            else ('原始配色与表情' if render.CJK else 'Original colors and expression')
        )
        draw.text((x + 12, 457), caption, font=render.font(17), fill='#38583E')
        draw.rounded_rectangle((x, 548, x + 300, 802), radius=14, fill='#FFFEFA')
        box = (
            int(picture.width * 0.20),
            int(picture.height * 0.23),
            round(picture.width * 0.73),
            round(picture.height * 0.54),
        )
        closeup = ImageOps.contain(picture.crop(box), (280, 222), method)
        image.paste(closeup, (x + (300 - closeup.width) // 2, 561 + (222 - closeup.height) // 2))
    draw.text(
        (28, 513),
        '眼睛、嘴线和腮红：同一区域放大' if render.CJK else 'SAME FACE AREA, ENLARGED',
        font=render.font(21),
        fill='#214E3B',
    )
    draw.text(
        (25, 826),
        '下排只放大显示；短线按原图弯折重建，局部可在一格范围内对齐。'
        if render.CJK
        else 'Bottom row is a display zoom. Short strokes follow source bends with bounded grid alignment.',
        font=render.font(16),
        fill='#61715A',
    )
    image.save(ASSETS / 'bubu-expression-comparison.png')


def build_low_resolution(config):
    assets = ASSETS / 'low-resolution'
    patterns = EXAMPLES / 'low-resolution'
    assets.mkdir(parents=True, exist_ok=True)
    patterns.mkdir(parents=True, exist_ok=True)
    summary = []
    with tempfile.TemporaryDirectory(prefix='craft-pattern-low-resolution-') as directory:
        for case in config['cases']:
            source = EXAMPLES / case['input']
            selected = case['plans'][case['selected_plan'] - 1]
            # Keep color distinction, palette cap, background, fit and cleanup fixed.
            settings = {
                k: v
                for k, v in selected.items()
                if k not in ('name', 'width', 'height', 'longest_edge')
            }
            plans = [
                settings | {'name': f'{edge} 格', 'longest_edge': edge} for edge in (32, 48, 64)
            ]
            plan_file = Path(directory) / f'{case["id"]}-plans.json'
            plan_file.write_text(json.dumps(plans, ensure_ascii=False), 'utf-8')
            result = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / 'scripts' / 'generate.py'),
                    str(source),
                    '--plans',
                    str(plan_file),
                    '--title',
                    case['title'],
                    '--no-archive',
                    '--output',
                    str(Path(directory) / case['id']),
                ],
                text=True,
                capture_output=True,
                check=True,
            )
            generated = json.loads(result.stdout)
            entry = {k: case[k] for k in ('id', 'title', 'english', 'input')}
            entry['source_sha256'] = hashlib.sha256(source.read_bytes()).hexdigest()
            entry['settings'] = settings | {
                'cleanup': settings.get('cleanup', 4),
                'fit': settings.get('fit', 'contain'),
            }
            entry['plans'] = []
            for edge, plan in zip((32, 48, 64), generated['plans']):
                values = {
                    k: plan[k]
                    for k in (
                        'width',
                        'height',
                        'color_detail',
                        'color_count',
                        'bead_count',
                        'blank_cells',
                    )
                }
                values['longest_edge'] = edge
                values['files'] = {}
                for key, suffix in (
                    ('json', '.json'),
                    ('svg', '.svg'),
                    ('materials', '.csv'),
                    ('preview', '-preview.png'),
                    ('chart', '-chart.png'),
                ):
                    target = (
                        assets if key in ('preview', 'chart') else patterns
                    ) / f'{case["id"]}-{edge}{suffix}'
                    if key == 'materials':
                        target.write_text(Path(plan['files'][key]).read_text('utf-8'), 'utf-8')
                    else:
                        shutil.copyfile(plan['files'][key], target)
                    values['files'][key] = target.relative_to(ROOT).as_posix()
                entry['plans'].append(values)
            summary.append(entry)
    (EXAMPLES / 'low-resolution-summary.json').write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + '\n', 'utf-8'
    )
    low_resolution_overview(summary)
    expression_comparison(summary)


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
    build_low_resolution(config)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    build_showcase()
