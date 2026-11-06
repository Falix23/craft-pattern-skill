"""Readable raster charts and comparison sheets, independent of an editor page."""

from functools import lru_cache
from math import ceil
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

SYMBOLS = '123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0'
FONT_PATHS = [
    '/System/Library/Fonts/PingFang.ttc',
    '/System/Library/Fonts/STHeiti Light.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
]
FONT_PATH = next((p for p in FONT_PATHS if Path(p).is_file()), None)
CJK = bool(FONT_PATH and any(name in FONT_PATH for name in ('PingFang', 'CJK', 'STHeiti')))


@lru_cache(maxsize=32)
def font(size):
    return ImageFont.truetype(FONT_PATH, size) if FONT_PATH else ImageFont.load_default()


def fit_text(draw, text, face, width):
    if draw.textlength(text, font=face) <= width:
        return text
    while text and draw.textlength(text + '…', font=face) > width:
        text = text[:-1]
    return text + '…'


def counts(pattern):
    usage = [0] * len(pattern['palette'])
    for value in pattern['cells']:
        if value is not None:
            usage[value] += 1
    return usage


def grid(pattern, cell=12, symbols=False):
    width, height = pattern['width'], pattern['height']
    image = Image.new('RGB', (width * cell, height * cell), 'white')
    draw = ImageDraw.Draw(image)
    for i, color in enumerate(pattern['cells']):
        x, y = i % width * cell, i // width * cell
        fill = (
            pattern['palette'][color]['hex']
            if color is not None
            else ('#EAEDE7' if (i % width + i // width) % 2 == 0 else '#FFFFFF')
        )
        draw.rectangle((x, y, x + cell - 1, y + cell - 1), fill=fill)
        if symbols and color is not None:
            rgb = [int(fill[c : c + 2], 16) for c in (1, 3, 5)]
            ink = (
                '#24362B'
                if sum(a * b for a, b in zip(rgb, (0.2126, 0.7152, 0.0722))) > 145
                else '#FFFFFF'
            )
            draw.text(
                (x + cell / 2, y + cell / 2),
                SYMBOLS[color],
                anchor='mm',
                font=font(max(9, cell - 6)),
                fill=ink,
            )
    for x in range(width + 1):
        draw.line(
            (min(x * cell, image.width - 1), 0, min(x * cell, image.width - 1), image.height - 1),
            fill='#879484' if x % 10 == 0 else '#D4DAD0',
        )
    for y in range(height + 1):
        draw.line(
            (0, min(y * cell, image.height - 1), image.width - 1, min(y * cell, image.height - 1)),
            fill='#879484' if y % 10 == 0 else '#D4DAD0',
        )
    return image


def chart(pattern, path, title='', symbols=False):
    """Chart with coordinate rulers and an exact per-color material legend."""
    cell = 18 if symbols else max(6, min(16, 768 // max(pattern['width'], pattern['height'])))
    picture = grid(pattern, cell, symbols)
    usage = counts(pattern)
    used = [(i, p, usage[i]) for i, p in enumerate(pattern['palette']) if usage[i]]
    width = max(600, picture.width + 80)
    columns = max(1, width // 285)
    legend_height = ceil(len(used) / columns) * 52 + 80
    image = Image.new('RGB', (width, picture.height + 125 + legend_height), '#FFFEFA')
    draw = ImageDraw.Draw(image)
    heading = title if CJK else 'BEAD PATTERN'
    draw.text(
        (24, 16), fit_text(draw, heading, font(22), width - 48), fill='#244E3A', font=font(22)
    )
    unit = 'stitches' if pattern.get('mode') == 'cross-stitch' else 'beads'
    label = (
        f'{pattern["width"]} × {pattern["height"]} 格 | {len(used)} 色 | {sum(usage):,} {"针" if unit == "stitches" else "颗"}'
        if CJK
        else f'{pattern["width"]} x {pattern["height"]} | {len(used)} colors | {sum(usage):,} {unit}'
    )
    draw.text((24, 52), label, fill='#52664D', font=font(16))
    left, top = (width - picture.width) // 2, 100
    image.paste(picture, (left, top))
    for x in range(pattern['width']):
        if x == 0 or (x + 1) % 5 == 0 or x + 1 == pattern['width']:
            draw.text(
                (left + (x + 0.5) * cell, top - 12),
                str(x + 1),
                font=font(10),
                fill='#5A6C51',
                anchor='mm',
            )
    for y in range(pattern['height']):
        if y == 0 or (y + 1) % 5 == 0 or y + 1 == pattern['height']:
            draw.text(
                (left - 8, top + (y + 0.5) * cell),
                str(y + 1),
                font=font(10),
                fill='#5A6C51',
                anchor='rm',
            )
    legend_top = top + picture.height + 22
    draw.text(
        (24, legend_top),
        '色号与用量（棋盘格留空）' if CJK else 'Materials (checkerboard = no bead)',
        font=font(17),
        fill='#244E3A',
    )
    for position, (index, color, amount) in enumerate(used):
        x = 24 + position % columns * (width // columns)
        y = legend_top + 32 + position // columns * 52
        draw.rectangle((x, y, x + 24, y + 24), fill=color['hex'], outline='#84917B')
        text = fit_text(draw, f'{SYMBOLS[index]}  {color["id"]}', font(13), width // columns - 64)
        draw.text((x + 32, y), text, font=font(13), fill='#354D36')
        draw.text((x + 32, y + 19), f'{color["hex"]}   {amount}', font=font(13), fill='#354D36')
    image.save(path)


def comparison(entries, path):
    columns = min(3, len(entries))
    tile_w, tile_h = 440, 500
    image = Image.new('RGB', (columns * tile_w, ceil(len(entries) / columns) * tile_h), '#F5F4EE')
    draw = ImageDraw.Draw(image)
    for i, entry in enumerate(entries):
        pattern = entry['pattern']
        x, y = i % columns * tile_w, i // columns * tile_h
        name = entry['name'] if CJK else f'Plan {i + 1}'
        draw.text(
            (x + 22, y + 15),
            fit_text(draw, name, font(22), tile_w - 44),
            font=font(22),
            fill='#244E3A',
        )
        detail = (
            {'low': '低', 'medium': '中', 'high': '高'}[entry['color_detail']]
            if CJK
            else entry['color_detail']
        )
        label = (
            f'{pattern["width"]} × {pattern["height"]} 格 | 区分度：{detail}'
            if CJK
            else f'{pattern["width"]} x {pattern["height"]} | {detail}'
        )
        draw.text((x + 22, y + 49), label, font=font(15), fill='#52664D')
        picture = grid(pattern, max(2, min(24, 384 // max(pattern['width'], pattern['height']))))
        image.paste(
            picture, (x + (tile_w - picture.width) // 2, y + 82 + (384 - picture.height) // 2)
        )
        used = counts(pattern)
        unit = 'stitches' if pattern.get('mode') == 'cross-stitch' else 'beads'
        label = (
            f'{sum(n > 0 for n in used)} 色 | {sum(used):,} {"针" if unit == "stitches" else "颗"}'
            if CJK
            else f'{sum(n > 0 for n in used)} colors | {sum(used):,} {unit}'
        )
        draw.text((x + 22, y + 473), label, font=font(16), fill='#354D36')
    image.save(path)


if __name__ == '__main__':
    import argparse
    import json

    import library

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('pattern')
    parser.add_argument('--output', required=True)
    parser.add_argument('--preview', action='store_true')
    args = parser.parse_args()
    try:
        pattern = library.normalize_pattern(
            json.loads(Path(args.pattern).expanduser().read_text('utf-8'))
        )
        path = Path(args.output).expanduser().resolve()
        if path.exists():
            raise ValueError('输出文件已存在，拒绝覆盖')
        path.parent.mkdir(parents=True, exist_ok=True)
        chart(pattern, path, pattern['title'], symbols=not args.preview)
        print(json.dumps({'image': str(path)}, ensure_ascii=False))
    except (OSError, ValueError) as error:
        parser.exit(2, str(error) + '\n')
