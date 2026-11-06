#!/usr/bin/env python3
"""Image -> ready-to-deliver PNG plans, without starting a browser or server."""

import argparse
import base64
import json
import shutil
import subprocess
import sys
import uuid
from datetime import datetime
from pathlib import Path

import build
import library
import render
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PLANS = [
    {'name': '轻量方案', 'longest_edge': 48, 'color_detail': 'low', 'max_colors': 8},
    {'name': '均衡方案', 'longest_edge': 64, 'color_detail': 'medium', 'max_colors': 8},
    {'name': '细节方案', 'longest_edge': 96, 'color_detail': 'high', 'max_colors': 12},
]
PLAN_KEYS = {
    'name',
    'longest_edge',
    'width',
    'height',
    'color_detail',
    'max_colors',
    'background',
    'background_tolerance',
    'alpha_threshold',
    'cleanup',
    'fit',
}


def integer(value, low, high, name):
    if type(value) is not int or not low <= value <= high:
        raise ValueError(f'{name} 须为 {low}–{high} 的整数')
    return value


def load_image(path):
    if path.stat().st_size > 40 * 1024 * 1024:
        raise ValueError('图片文件不能超过 40 MB')
    with Image.open(path) as source:
        if source.width * source.height > 40_000_000:
            raise ValueError('图片限制为 4000 万像素')
        image = ImageOps.exif_transpose(source).convert('RGBA')
    image.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
    return image


def dimensions(plan, source_size):
    width, height = plan.get('width'), plan.get('height')
    longest = plan.get('longest_edge')
    if longest is not None and (width is not None or height is not None):
        raise ValueError('longest_edge 不能与 width/height 同时指定')
    for name, value in (('width', width), ('height', height), ('longest_edge', longest)):
        if value is not None:
            integer(value, 4, 160, name)
    ratio = source_size[0] / source_size[1]
    if width is None and height is None:
        longest = longest or 64
        width, height = (
            (longest, max(4, round(longest / ratio)))
            if ratio >= 1
            else (max(4, round(longest * ratio)), longest)
        )
    elif width is None:
        width = max(4, round(height * ratio))
    elif height is None:
        height = max(4, round(width / ratio))
    integer(width, 4, 160, 'width')
    integer(height, 4, 160, 'height')
    return width, height


def validate_plans(raw, image, defaults, palette, mode):
    if not isinstance(raw, list) or not 1 <= len(raw) <= 12:
        raise ValueError('方案须为含 1–12 项的 JSON 数组')
    plans = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict) or set(item) - PLAN_KEYS:
            raise ValueError('方案须为对象，且不能包含未知字段')
        plan = defaults | item
        name = plan.get('name', f'方案 {index + 1}')
        if not isinstance(name, str) or not name.strip() or len(name) > 80:
            raise ValueError('方案 name 须为 1–80 字符')
        width, height = dimensions(plan, image.size)
        integer(plan['max_colors'], 2, 36, 'max_colors')
        # Reuse the existing explicit-palette and processing validation contract.
        build.validate(
            plan
            | {
                'width': width,
                'height': height,
                'mode': mode,
                'palette': palette
                or [{'id': 'a', 'hex': '#000000'}, {'id': 'b', 'hex': '#FFFFFF'}],
            }
        )
        plans.append(plan | {'name': name.strip(), 'width': width, 'height': height})
    return plans


def fit_image(image, size, fit, keep=False):
    if fit == 'cover':
        return ImageOps.fit(image, size, method=Image.Resampling.LANCZOS)
    return ImageOps.pad(
        image, size, method=Image.Resampling.LANCZOS, color='white' if keep else (0, 0, 0, 0)
    )


def generate(args):
    source = Path(args.image).expanduser().resolve()
    image = load_image(source)
    palette = None
    if args.palette:
        value = json.loads(Path(args.palette).expanduser().read_text('utf-8'))
        palette = value.get('palette') if isinstance(value, dict) else value
        if not palette:
            raise ValueError('色板文件须为颜色数组或含 palette 的对象')
    background = args.background or (
        'transparent' if image.getchannel('A').getextrema()[0] < args.alpha_threshold else 'auto'
    )
    defaults = {
        'color_detail': args.color_detail,
        'max_colors': args.max_colors,
        'background': background,
        'background_tolerance': args.background_tolerance,
        'alpha_threshold': args.alpha_threshold,
        'cleanup': args.cleanup,
        'fit': args.fit,
    }
    if args.plans:
        raw = json.loads(Path(args.plans).expanduser().read_text('utf-8'))
    elif args.compare:
        raw = DEFAULT_PLANS
    else:
        raw = [
            {
                key: value
                for key, value in {
                    'width': args.width,
                    'height': args.height,
                    'longest_edge': args.longest_edge,
                }.items()
                if value is not None
            }
        ]
    if (args.plans or args.compare) and any(
        v is not None for v in (args.width, args.height, args.longest_edge)
    ):
        raise ValueError('多方案的尺寸请在 --plans 中指定，不与单图尺寸参数混用')
    if not isinstance(args.title or source.stem, str) or len(args.title or source.stem) > 200:
        raise ValueError('标题不能超过 200 字符')
    if args.case_id and not library.CASE_ID.fullmatch(args.case_id):
        raise ValueError('案例 ID 格式无效')
    plans = validate_plans(raw, image, defaults, palette, args.mode)
    node = shutil.which('node')
    if not node:
        raise ValueError('直接出图需要 Node.js 18+；编辑器仍可独立使用')
    directory = (
        Path(args.output).expanduser()
        if args.output
        else Path.home()
        / '.craft-pattern'
        / 'outputs'
        / (datetime.now().strftime('%Y%m%d-%H%M%S-') + uuid.uuid4().hex[:8])
    ).resolve()
    directory.mkdir(parents=True, exist_ok=False)
    manifest = {
        'format': 'craft-pattern-plans',
        'version': 1,
        'source': str(source),
        'output': str(directory),
        'plans': [],
        'warnings': [],
    }
    entries, masked_sources = [], {}
    title = args.title or source.stem
    for index, plan in enumerate(plans):
        options = {
            key: plan[key]
            for key in (
                'background',
                'background_tolerance',
                'alpha_threshold',
                'cleanup',
                'color_detail',
            )
        }
        key = tuple(
            options[k] for k in ('background', 'background_tolerance', 'alpha_threshold', 'cleanup')
        )
        if key not in masked_sources:
            prepared, masked = image.copy(), False
            if options['background'] == 'auto' and options['cleanup'] == 4:
                pixels, removed = build.remove_background(
                    list(prepared.getdata()),
                    *prepared.size,
                    options['background_tolerance'],
                    options['alpha_threshold'],
                    source=True,
                )
                prepared.putdata(pixels)
                masked = removed > 0
            if options['background'] == 'keep':
                white = Image.new('RGBA', prepared.size, 'white')
                white.alpha_composite(prepared)
                prepared = white
            masked_sources[key] = prepared, masked
        prepared, masked = masked_sources[key]
        size = plan['width'], plan['height']
        target = fit_image(prepared, size, plan['fit'], options['background'] == 'keep')
        source_removed = 0
        if masked:
            before = fit_image(image, size, plan['fit'])
            source_removed = sum(
                a[3] >= options['alpha_threshold'] > b[3]
                for a, b in zip(before.getdata(), target.getdata())
            )
        request = {
            'width': size[0],
            'height': size[1],
            'options': options,
            'max_colors': plan['max_colors'],
            'title': f'{title} · {plan["name"]}',
            'mode': args.mode,
            'source': {'name': source.name, 'fit': plan['fit']},
            'rgba': base64.b64encode(target.tobytes()).decode('ascii'),
            'background_masked': masked,
            'source_removed': source_removed,
        }
        if palette is not None:
            request['palette'] = palette
        if options['cleanup'] == 4:
            detail = fit_image(
                prepared, (size[0] * 6, size[1] * 6), plan['fit'], options['background'] == 'keep'
            )
            request['detail'] = base64.b64encode(detail.tobytes()).decode('ascii')
        result = subprocess.run(
            [node, str(ROOT / 'scripts' / 'generate.cjs')],
            input=json.dumps(request),
            text=True,
            capture_output=True,
            timeout=60,
            check=False,
        )
        if result.returncode:
            raise ValueError(result.stderr.strip() or '配色生成失败')
        generated = json.loads(result.stdout)
        pattern = generated['pattern']
        output = directory / f'plan-{index + 1:02d}'
        output.mkdir()
        paths = {
            key: str(output / filename)
            for key, filename in (
                ('preview', 'preview.png'),
                ('chart', 'pattern.png'),
                ('json', 'pattern.json'),
                ('svg', 'pattern.svg'),
                ('materials', 'materials.csv'),
            )
        }
        Path(paths['json']).write_text(json.dumps(pattern, ensure_ascii=False, indent=2), 'utf-8')
        Path(paths['svg']).write_text(generated['svg'], 'utf-8')
        Path(paths['materials']).write_text(generated['csv'], 'utf-8')
        render.chart(pattern, paths['preview'], pattern['title'])
        render.chart(pattern, paths['chart'], pattern['title'], symbols=True)
        entry = {
            'name': plan['name'],
            'width': size[0],
            'height': size[1],
            'color_detail': plan['color_detail'],
            'max_colors': plan['max_colors'],
            'color_count': sum(n > 0 for n in render.counts(pattern)),
            'bead_count': pattern['metrics']['bead_count'],
            'blank_cells': pattern['metrics']['blank_cells'],
            'files': paths,
            'archive': None,
            'warnings': [],
        }
        if not entry['bead_count']:
            entry['warnings'].append(
                '该方案全为空格；请检查原图、背景模式和透明阈值，不应作为可制作图纸交付。'
            )
        manifest['plans'].append(entry)
        entries.append({'pattern': pattern, **entry})
    if len(entries) > 1:
        manifest['comparison'] = str(directory / 'comparison.png')
        render.comparison(entries, manifest['comparison'])
    manifest['recommended_plan'] = next(
        (i + 1 for i, p in enumerate(plans) if p['color_detail'] == 'medium'), (len(plans) + 1) // 2
    )
    if not args.no_archive:
        case_id = args.case_id
        metadata = {'title': title}
        if args.tags is not None:
            metadata['tags'] = [t.strip() for t in args.tags.split(',') if t.strip()]
        # Existing case metadata is preserved unless the user supplies replacements.
        if args.case_id and args.title is None:
            metadata.pop('title')
        for entry, artifact in zip(manifest['plans'], entries):
            try:
                saved = library.save_case(
                    artifact['pattern'],
                    source_path=source,
                    metadata=metadata,
                    case_id=case_id,
                    library_dir=args.library,
                )
                case_id = saved['case']['id']
                entry['archive'] = {
                    'case_id': case_id,
                    'version': saved['case']['version'],
                    'library': str(library.library_path(args.library)),
                }
            except Exception as error:
                entry['warnings'].append(f'图纸已生成，但未能归档：{error}')
                # Do not split remaining variants into unrelated cases after failure.
                manifest['warnings'].append('归档中断；全部生成文件仍已保留，可稍后重试收录。')
                break
    manifest['status'] = (
        'completed_with_warnings'
        if manifest['warnings'] or any(p['warnings'] for p in manifest['plans'])
        else 'completed'
    )
    manifest['manifest'] = str(directory / 'manifest.json')
    Path(manifest['manifest']).write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), 'utf-8'
    )
    return manifest


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('image', help='本地原图路径（GIF 取首帧）')
    group = p.add_mutually_exclusive_group()
    group.add_argument('--compare', action='store_true', help='48/低、64/中、96/高三个起始方案')
    group.add_argument('--plans', help='自定义 1–12 个方案的 JSON 文件')
    p.add_argument('--width', type=int)
    p.add_argument('--height', type=int)
    p.add_argument('--longest-edge', type=int)
    p.add_argument('--color-detail', choices=('low', 'medium', 'high'), default='medium')
    p.add_argument('--max-colors', type=int, default=8)
    p.add_argument('--background', choices=('transparent', 'auto', 'keep'))
    p.add_argument('--background-tolerance', type=int, default=32)
    p.add_argument('--alpha-threshold', type=int, default=128)
    p.add_argument('--cleanup', type=int, default=4)
    p.add_argument('--fit', choices=('contain', 'cover'), default='contain')
    p.add_argument('--mode', choices=('bead', 'cross-stitch'), default='bead')
    p.add_argument('--palette', help='用户明确提供的色板 JSON；不自动合并色号')
    p.add_argument('--output', help='新的独立输出目录；存在时拒绝覆盖')
    p.add_argument('--title')
    p.add_argument('--tags')
    p.add_argument('--library')
    p.add_argument('--case-id')
    p.add_argument('--no-archive', action='store_true')
    return p


if __name__ == '__main__':
    try:
        print(json.dumps(generate(parser().parse_args()), ensure_ascii=False, indent=2))
    except (ValueError, OSError, subprocess.SubprocessError, Image.DecompressionBombError) as error:
        print(json.dumps({'error': str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(2)
