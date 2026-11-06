#!/usr/bin/env python3
"""Rebuild three synthetic regression examples and their before/after gallery."""

from __future__ import annotations

import argparse
import html
import importlib.util
import json
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parents[1]
CASES = ROOT / 'examples' / 'cases'
_spec = importlib.util.spec_from_file_location('pattern_build', ROOT / 'scripts' / 'build.py')
_build = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_build)


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def make_sources():
    """Original pixel illustrations; all colour IDs are synthetic RGB references."""
    CASES.mkdir(parents=True, exist_ok=True)
    cat = json.loads((ROOT / 'examples' / 'input.json').read_text())
    cat.update(
        title='橘猫 · 纯色去底与眼白保留',
        image='../demo.png',
        background='auto',
        cleanup=1,
        background_tolerance=32,
    )
    write_json(CASES / 'cat.json', cat)

    # A non-square transparent PNG tests both native alpha and contain letterboxing.
    im = Image.new('RGBA', (48, 30), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    ink, body, screen, light, pink = '#293C47', '#829DD2', '#B9E5D8', '#FFF5DE', '#EBA6AE'
    d.rectangle((12, 10, 35, 25), fill=ink)
    d.rectangle((13, 11, 34, 24), fill=body)
    d.rectangle((16, 13, 31, 21), fill=ink)
    d.rectangle((17, 14, 30, 20), fill=screen)
    d.rectangle((20, 16, 21, 17), fill=ink)
    d.rectangle((26, 16, 27, 17), fill=ink)
    d.rectangle((22, 19, 25, 19), fill=ink)
    d.rectangle((10, 15, 11, 21), fill=ink)
    d.rectangle((36, 15, 37, 21), fill=ink)
    d.rectangle((16, 26, 20, 27), fill=ink)
    d.rectangle((27, 26, 31, 27), fill=ink)
    d.rectangle((23, 7, 24, 9), fill=ink)
    d.rectangle((22, 5, 25, 7), fill=pink)
    d.rectangle((14, 23, 17, 23), fill=light)
    im.resize((384, 240), Image.Resampling.NEAREST).save(CASES / 'transparent-robot.png')
    write_json(
        CASES / 'robot.json',
        {
            'title': '透明机器人 · 透明区域与等比留边',
            'image': 'transparent-robot.png',
            'width': 48,
            'height': 48,
            'mode': 'bead',
            'fit': 'contain',
            'background': 'transparent',
            'cleanup': 1,
            'palette': [
                {'id': name, 'hex': color}
                for name, color in [
                    ('INK', ink),
                    ('BLUE', body),
                    ('MINT', screen),
                    ('CREAM', light),
                    ('PINK', pink),
                ]
            ],
        },
    )

    # Exact grid-aligned near-colour dots, sampled with a fixed seed. The dark
    # porthole is a real feature and must remain after conservative cleanup.
    im = Image.new('RGB', (48, 48), '#F6F1E7')
    d = ImageDraw.Draw(im)
    outline, orange, noise, cream, flame, red = (
        '#3D414B',
        '#E29048',
        '#BC7844',
        '#F6F1E7',
        '#F7C65C',
        '#C65D56',
    )
    d.polygon([(23, 4), (32, 15), (32, 32), (15, 32), (15, 15)], fill=outline)
    d.polygon([(23, 6), (30, 16), (30, 30), (17, 30), (17, 16)], fill=orange)
    d.polygon([(14, 23), (8, 32), (8, 35), (14, 33)], fill=red)
    d.polygon([(33, 23), (39, 32), (39, 35), (33, 33)], fill=red)
    d.rectangle((20, 33, 27, 36), fill=outline)
    d.polygon([(21, 36), (26, 36), (25, 42), (23, 46), (21, 42)], fill=flame)
    d.rectangle((21, 17, 26, 22), fill=outline)
    d.rectangle((22, 18, 25, 21), fill=cream)
    d.point((23, 19), fill=outline)
    rng = random.Random(20261104)
    candidates = [
        (x, y)
        for y in range(10, 30)
        for x in range(18, 30)
        if all(
            im.getpixel((nx, ny)) == tuple(int(orange[i : i + 2], 16) for i in (1, 3, 5))
            for nx, ny in ((x, y), (x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1))
        )
    ]
    rng.shuffle(candidates)
    dots = []
    for x, y in candidates:
        if all(abs(x - a) + abs(y - b) > 2 for a, b in dots):
            dots.append((x, y))
        if len(dots) == 22:
            break
    for point in dots:
        d.point(point, fill=noise)
    im.resize((384, 384), Image.Resampling.NEAREST).save(CASES / 'noisy-rocket.png')
    write_json(
        CASES / 'rocket.json',
        {
            'title': '小火箭 · 固定种子近色杂点',
            'image': 'noisy-rocket.png',
            'width': 48,
            'height': 48,
            'mode': 'bead',
            'fit': 'contain',
            'background': 'auto',
            'background_tolerance': 32,
            'cleanup': 1,
            'palette': [
                {'id': name, 'hex': color}
                for name, color in [
                    ('CREAM', cream),
                    ('ORANGE', orange),
                    ('MUTED_ORANGE', noise),
                    ('INK', outline),
                    ('FLAME', flame),
                    ('RED', red),
                ]
            ],
        },
    )
    write_json(
        CASES / 'manifest.json',
        {
            'provenance': 'Original synthetic illustrations; no personal photos; RGB colours are not official brand codes.',
            'cases': [
                {'id': 'cat', 'focus': 'Edge-connected solid background, enclosed eye highlights.'},
                {'id': 'robot', 'focus': 'Native transparent PNG plus contain letterboxing.'},
                {
                    'id': 'rocket',
                    'focus': 'Near-colour one-cell dots; preserve dark porthole detail.',
                    'seed': 20261104,
                    'injected_dots': len(dots),
                },
            ],
        },
    )


def checker(size, step=12):
    im = Image.new('RGB', size, '#FAFAF7')
    d = ImageDraw.Draw(im)
    for y in range(0, size[1], step):
        for x in range(0, size[0], step):
            if (x // step + y // step) % 2:
                d.rectangle((x, y, x + step - 1, y + step - 1), fill='#E8EBE5')
    return im


def render_pattern(pattern, cell_size=8):
    w, h = pattern['width'], pattern['height']
    im = checker((w * cell_size, h * cell_size), cell_size)
    d = ImageDraw.Draw(im)
    for i, value in enumerate(pattern['cells']):
        if value is not None:
            x, y = (i % w) * cell_size, (i // w) * cell_size
            d.rectangle(
                (x, y, x + cell_size - 1, y + cell_size - 1), fill=pattern['palette'][value]['hex']
            )
    overlay = Image.new('RGBA', im.size, (0, 0, 0, 0))
    grid = ImageDraw.Draw(overlay)
    for x in range(0, w * cell_size + 1, cell_size):
        grid.line((x, 0, x, h * cell_size), fill=(56, 72, 62, 42), width=1)
    for y in range(0, h * cell_size + 1, cell_size):
        grid.line((0, y, w * cell_size, y), fill=(56, 72, 62, 42), width=1)
    return Image.alpha_composite(im.convert('RGBA'), overlay).convert('RGB')


def metric(pattern):
    cells = pattern['cells']
    counts = [cells.count(i) for i in range(len(pattern['palette']))]
    return {
        'bead_count': sum(v is not None for v in cells),
        'blank_cells': cells.count(None),
        'cleaned_cells': pattern.get('metrics', {}).get('cleaned_cells', 0),
        'removed_background': pattern.get('metrics', {}).get('removed_background', 0),
        'materials': {p['id']: counts[i] for i, p in enumerate(pattern['palette'])},
    }


def font(size):
    for path in [
        '/System/Library/Fonts/Supplemental/Arial.ttf',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    ]:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def run(output, images_only=False):
    make_sources()
    output.mkdir(parents=True, exist_ok=True)
    # These are the original pre-update documents' published settings.
    rows, summary = [], []
    for case_id, label in [
        ('cat', '01  CAT / remove solid background'),
        ('robot', '02  ROBOT / preserve transparency'),
        ('rocket', '03  ROCKET / remove near-colour speckles'),
    ]:
        config_path = CASES / (case_id + '.json')
        config = json.loads(config_path.read_text())
        source_path = (config_path.parent / config['image']).resolve()
        case_out = output / case_id
        case_out.mkdir(exist_ok=True)
        before_config = config | {
            'background': 'keep',
            'cleanup': 0,
            'title': config['title'] + ' · 优化前',
        }
        after_config = config | {'title': config['title'] + ' · 优化后'}
        data = {}
        for variant, variant_config in [('before', before_config), ('after', after_config)]:
            if images_only:
                data[variant] = _build.convert(variant_config, source_path)
                write_json(case_out / (variant + '.json'), data[variant])
            else:
                # Passing --image avoids changing the meaning of config-relative paths.
                temp_config = case_out / (variant + '-input.json')
                write_json(temp_config, variant_config)
                data[variant] = _build.build(
                    temp_config, case_out / (variant + '.html'), source_path
                )
            render_pattern(data[variant]).save(case_out / (variant + '.png'))
        source = Image.open(source_path).convert('RGBA')
        source.save(case_out / 'source.png')
        source_preview = checker((384, 384))
        source = ImageOps.contain(source, (384, 384), Image.Resampling.NEAREST)
        source_preview.paste(
            source, ((384 - source.width) // 2, (384 - source.height) // 2), source
        )
        pair = Image.new('RGB', (1260, 496), '#F5F3EC')
        draw = ImageDraw.Draw(pair)
        draw.text((28, 16), label, fill='#184D3C', font=font(22))
        for x, heading, picture in [
            (28, 'SOURCE (synthetic)', source_preview),
            (438, 'BEFORE', Image.open(case_out / 'before.png')),
            (848, 'AFTER', Image.open(case_out / 'after.png')),
        ]:
            draw.text((x, 53), heading, fill='#344338', font=font(16))
            picture = picture.resize((384, 384), Image.Resampling.NEAREST)
            pair.paste(picture, (x, 82))
        before, after = metric(data['before']), metric(data['after'])
        draw.text(
            (438, 472),
            f'{before["bead_count"]} beads / {before["blank_cells"]} blank',
            fill='#4F5C52',
            font=font(14),
        )
        draw.text(
            (848, 472),
            f'{after["bead_count"]} beads / {after["blank_cells"]} blank / {after["cleaned_cells"]} cleaned',
            fill='#184D3C',
            font=font(14),
        )
        pair.save(case_out / 'compare.png')
        rows.append(pair)
        summary.append(
            {
                'id': case_id,
                'title': config['title'],
                'source': str(source_path.relative_to(ROOT)),
                'grid': [config['width'], config['height']],
                'before': before,
                'after': after,
            }
        )
    gallery = Image.new('RGB', (1260, 48 + 496 * len(rows)), '#F5F3EC')
    ImageDraw.Draw(gallery).text(
        (28, 14),
        'CRAFT PATTERN / SAME INPUT, BEFORE & AFTER / ORIGINAL SYNTHETIC EXAMPLES',
        font=font(17),
        fill='#184D3C',
    )
    for i, row in enumerate(rows):
        gallery.paste(row, (0, 48 + i * 496))
    gallery.save(output / 'compare.png')
    write_json(output / 'summary.json', summary)
    cards = []
    for case in summary:
        case_id, before, after = case['id'], case['before'], case['after']
        cards.append(f'''<article><h2>{html.escape(case['title'])}</h2>
<p>{before['bead_count']} → <strong>{after['bead_count']} 颗</strong> · {after['blank_cells']} 个空格 · 清理 {after['cleaned_cells']} 格</p>
<img src="{case_id}/compare.png" alt="同一输入图片的优化前后对比">
<p><a href="{case_id}/before.html">打开优化前图纸</a> <a href="{case_id}/after.html">打开优化后图纸与上传编辑器</a></p></article>''')
    page = """<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>拼豆优化 · 三个案例</title><style>body{font:16px/1.7 system-ui,sans-serif;color:#253d32;background:#f5f3ec;margin:0;padding:28px}main{max-width:1260px;margin:auto}h1{font-size:30px}article{background:white;border:1px solid #dae1d7;border-radius:16px;margin:24px 0;padding:24px}h2{margin:0}img{width:100%;display:block;margin:20px 0}a{display:inline-block;padding:8px 14px;margin:0 10px 6px 0;color:white;background:#184d3c;border-radius:8px;text-decoration:none}.note{color:#637267}</style>
<main><h1>背景留空、减少杂色：三个案例</h1><p>每一组均使用同一张输入图片和同一套色板，比较原有设置与新增处理。
透明棋盘表示不放豆子的空格，不计入材料。</p><p class="note">三个案例均为原创合成插画，用于验证功能；不代表复杂实拍照片的效果。颜色为通用 RGB 参考，非品牌官方色号。</p>"""
    (output / 'index.html').write_text(page + '\n'.join(cards) + '</main></html>', encoding='utf-8')
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f'Comparison image: {output / "compare.png"}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'outputs' / 'cases')
    parser.add_argument(
        '--images-only',
        action='store_true',
        help='Skip HTML building while developing the template',
    )
    args = parser.parse_args()
    run(args.output.resolve(), args.images_only)
