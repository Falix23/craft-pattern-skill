#!/usr/bin/env python3
"""Deterministic photo-to-grid conversion with an explicit material palette."""

import argparse
import base64
import io
import json
import math
import re
from array import array
from collections import Counter, deque
from pathlib import Path

from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[1]


def validate(config):
    if not isinstance(config, dict):
        raise ValueError('输入必须为 JSON 对象')
    width, height = config.get('width', 40), config.get('height', 40)
    if (
        type(width) is not int
        or type(height) is not int
        or not (4 <= width <= 160 and 4 <= height <= 160)
    ):
        raise ValueError('width/height 必须为 4–160 的整数')
    palette = config.get('palette', [])
    if not isinstance(palette, list) or not (2 <= len(palette) <= 36):
        raise ValueError('palette 需要 2–36 种颜色')
    ids = set()
    for color in palette:
        if (
            not isinstance(color, dict)
            or not isinstance(color.get('id'), str)
            or not color['id']
            or color['id'] in ids
        ):
            raise ValueError('色号须非空且唯一')
        ids.add(color['id'])
        if not re.fullmatch(r'#[0-9a-fA-F]{6}', str(color.get('hex', ''))):
            raise ValueError('颜色格式应为 #RRGGBB')
    mode = config.get('mode', 'bead')
    if mode not in ('bead', 'cross-stitch'):
        raise ValueError('mode 仅支持 bead / cross-stitch')
    if config.get('fit', 'contain') not in ('contain', 'cover'):
        raise ValueError('fit 仅支持 contain / cover')
    if config.get('background', 'transparent') not in ('keep', 'transparent', 'auto'):
        raise ValueError('background 仅支持 keep / transparent / auto')
    if config.get('color_detail', 'medium') not in ('low', 'medium', 'high'):
        raise ValueError('color_detail 仅支持 low / medium / high')
    for name, default, lower, upper in (
        ('background_tolerance', 32, 0, 120),
        ('alpha_threshold', 128, 1, 255),
        ('cleanup', 1, 0, 4),
    ):
        value = config.get(name, default)
        if type(value) is not int or not lower <= value <= upper:
            raise ValueError(f'{name} 必须为 {lower}–{upper} 的整数')
    return width, height, [{'id': color['id'], 'hex': color['hex']} for color in palette]


def srgb(v):
    v = v / 255
    return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4


def nearest(rgb, palette_rgb, palette_labs=None):
    a = oklab(rgb)
    labs = palette_labs if palette_labs is not None else [oklab(c) for c in palette_rgb]
    return min(range(len(labs)), key=lambda j: color_distance(a, labs[j]))


def neighbors(index, width, height):
    x, y = index % width, index // width
    if x:
        yield index - 1
    if x + 1 < width:
        yield index + 1
    if y:
        yield index - width
    if y + 1 < height:
        yield index + width


def remove_background(pixels, width, height, tolerance=32, alpha_threshold=128, source=False):
    """Remove a dominant flat edge color, preserving enclosed same-color details.

    RGB distance is measured before palette mapping. The alpha threshold defines
    both the foreground bounding box and empty neighbors used as flood seeds.
    No reference is trusted unless its 16-level RGB bin contains at least 35%
    of the nontransparent bounding-box perimeter samples.
    """
    result = [
        tuple(pixel[:3]) + (pixel[3] if pixel[3] >= alpha_threshold else 0,) for pixel in pixels
    ]
    occupied = [i for i, pixel in enumerate(result) if pixel[3] >= alpha_threshold]
    if not occupied:
        return result, 0
    left = min(i % width for i in occupied)
    right = max(i % width for i in occupied)
    top = min(i // width for i in occupied)
    bottom = max(i // width for i in occupied)
    bins = {}
    total = 0
    for y in range(top, bottom + 1):
        for x in range(left, right + 1):
            if x not in (left, right) and y not in (top, bottom):
                continue
            pixel = result[y * width + x]
            if pixel[3] < alpha_threshold:
                continue
            neutral = source and min(pixel[:3]) >= 140 and max(pixel[:3]) - min(pixel[:3]) <= 24
            key = 'neutral-backdrop' if neutral else tuple(channel // 16 for channel in pixel[:3])
            group = bins.setdefault(key, [0, 0, 0, 0])
            group[0] += 1
            for channel in range(3):
                group[channel + 1] += pixel[channel]
            total += 1
    if not total:
        return result, 0
    group = max(bins.values(), key=lambda value: value[0])
    if group[0] / total < 0.35:
        return result, 0
    reference = [channel / group[0] for channel in group[1:]]
    reference_mean = sum(reference) / 3
    neutral_backdrop = reference_mean >= 150 and max(reference) - min(reference) <= 24

    def candidate(pixel):
        if pixel[3] < alpha_threshold:
            return False
        if sum((pixel[c] - reference[c]) ** 2 for c in range(3)) <= tolerance * tolerance:
            return True
        mean = sum(pixel[:3]) / 3
        return (
            neutral_backdrop
            and tolerance > 0
            and max(pixel[:3]) - min(pixel[:3]) <= 24
            and mean >= 140
            and abs(mean - reference_mean) <= min(64, tolerance * 1.75)
            and sum((pixel[c] - mean - reference[c] + reference_mean) ** 2 for c in range(3)) ** 0.5
            <= max(8, tolerance * 0.45)
        )

    candidates = [candidate(pixel) for pixel in result]
    queue = deque()
    seen = set()
    for index, candidate in enumerate(candidates):
        if not candidate:
            continue
        x, y = index % width, index // width
        if (
            x == 0
            or x == width - 1
            or y == 0
            or y == height - 1
            or any(result[other][3] < alpha_threshold for other in neighbors(index, width, height))
        ):
            queue.append(index)
            seen.add(index)
    while queue:
        index = queue.popleft()
        for other in neighbors(index, width, height):
            if candidates[other] and other not in seen:
                seen.add(other)
                queue.append(other)
    for index in seen:
        result[index] = result[index][:3] + (0,)
    return result, len(seen)


def cleanup_cells(cells, width, height, palette_rgb, level=1):
    """Merge only small, similar-color islands strongly enclosed by one color.

    Decisions always read the original grid, never previous replacements. Each
    four-neighbor boundary edge casts one vote; boundaries and empty cells veto
    a replacement so the silhouette and open details are preserved.
    """
    result = list(cells)
    if level == 0:
        return result, 0
    if level == 4:
        return simplify_regions(cells, width, height, palette_rgb)
    maximum = (0, 1, 2, 4)[level]
    threshold = 0.06 if level == 3 else 0.035
    linear = [tuple(srgb(channel) for channel in color) for color in palette_rgb]
    visited = set()
    changed = 0
    for start, color in enumerate(cells):
        if color is None or start in visited:
            continue
        component = []
        votes = Counter()
        blocked = False
        queue = [start]
        visited.add(start)
        while queue:
            index = queue.pop()
            component.append(index)
            x, y = index % width, index // width
            if x == 0 or x == width - 1 or y == 0 or y == height - 1:
                blocked = True
            for other in neighbors(index, width, height):
                neighbor_color = cells[other]
                if neighbor_color == color:
                    if other not in visited:
                        visited.add(other)
                        queue.append(other)
                elif neighbor_color is None:
                    blocked = True
                else:
                    votes[neighbor_color] += 1
        if blocked or len(component) > maximum or not votes:
            continue
        replacement, count = votes.most_common(1)[0]
        if count / sum(votes.values()) < 0.75:
            continue
        distance = sum(
            weight * (linear[color][channel] - linear[replacement][channel]) ** 2
            for channel, weight in enumerate((0.2126, 0.7152, 0.0722))
        )
        if distance > threshold:
            continue
        for index in component:
            result[index] = replacement
        changed += len(component)
    return result, changed


def oklab(rgb):
    r, g, b = (srgb(v) for v in rgb)
    cone_l = (0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b) ** (1 / 3)
    cone_m = (0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b) ** (1 / 3)
    cone_s = (0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b) ** (1 / 3)
    return (
        0.2104542553 * cone_l + 0.793617785 * cone_m - 0.0040720468 * cone_s,
        1.9779984951 * cone_l - 2.428592205 * cone_m + 0.4505937099 * cone_s,
        0.0259040371 * cone_l + 0.7827717662 * cone_m - 0.808675766 * cone_s,
    )


def simplify_regions(cells, width, height, palette_rgb):
    result = list(cells)
    labs = [oklab(rgb) for rgb in palette_rgb]
    maximum = max(4, min(12, int(width * height * 0.003 + 0.5)))
    for _ in range(2):
        labels = [-1] * len(result)
        regions = []
        for start, color in enumerate(result):
            if color is None or labels[start] >= 0:
                continue
            region = {'color': color, 'items': [start], 'border': Counter(), 'blank': False}
            labels[start] = len(regions)
            for i in region['items']:
                x, y = i % width, i // width
                if x == 0 or x == width - 1 or y == 0 or y == height - 1:
                    region['blank'] = True
                for other in neighbors(i, width, height):
                    if result[other] is None:
                        region['blank'] = True
                    if result[other] == color and labels[other] < 0:
                        labels[other] = len(regions)
                        region['items'].append(other)
            regions.append(region)
        for region in regions:
            for i in region['items']:
                for other in neighbors(i, width, height):
                    j = labels[other]
                    if j >= 0 and regions[j] is not region:
                        region['border'][j] += 1
        changed = False
        for region in regions:
            size = len(region['items'])
            if size > maximum or not region['border']:
                continue
            perimeter = sum(region['border'].values())
            best = float('inf')
            replacement = None
            for j, votes in region['border'].items():
                target = regions[j]
                if len(target['items']) < max(8, size * 3) or votes / perimeter < 0.5:
                    continue
                a, b = labs[region['color']], labs[target['color']]
                chroma = (a[1] ** 2 + a[2] ** 2) ** 0.5
                target_chroma = (b[1] ** 2 + b[2] ** 2) ** 0.5
                distinct_hue = chroma >= 0.03 and (
                    target_chroma < 0.025
                    or (a[1] * b[1] + a[2] * b[2]) / (chroma * target_chroma)
                    < math.cos(math.pi / 12)
                )
                if (
                    ((not region['blank'] or a[0] < 0.3) and a[0] < b[0] - 0.075)
                    or chroma > 0.1
                    or distinct_hue
                ):
                    continue
                delta = sum((a[c] - b[c]) ** 2 for c in range(3)) ** 0.5
                fleck = (
                    not region['blank']
                    and size <= 3
                    and votes / perimeter >= 0.7
                    and 0.35 < a[0] < 0.88
                    and chroma < 0.045
                    and b[0] < 0.32
                )
                if delta > (0.55 if fleck else 0.27 if region['blank'] else 0.18):
                    continue
                score = delta + 0.06 * (1 - votes / perimeter)
                if score < best:
                    best = score
                    replacement = target['color']
            if replacement is not None:
                for i in region['items']:
                    result[i] = replacement
                changed = True
        if not changed:
            break
    return result, sum(a != b for a, b in zip(cells, result))


def color_distance(a, b):
    delta = sum((a[c] - b[c]) ** 2 for c in range(3))
    ca, cb = math.hypot(a[1], a[2]), math.hypot(b[1], b[2])
    if ca < 0.025 or cb < 0.025:
        return delta
    cosine = max(-1, min(1, (a[1] * b[1] + a[2] * b[2]) / (ca * cb)))
    return delta + 4 * ca * cb * (1 - cosine)


def extract_craft_features(detail, width, height, alpha_threshold=128):
    """Black-hat blobs qualified by a Sobel/Shi–Tomasi structure tensor."""
    scale = math.isqrt(len(detail) // (width * height))
    if scale not in (3, 6) or len(detail) != width * height * scale * scale:
        raise ValueError('细节采样尺寸无效')
    w, h = width * scale, height * scale
    n = w * h
    valid = [p[3] >= alpha_threshold for p in detail]
    light = array('f', (oklab(p[:3])[0] if valid[i] else 1 for i, p in enumerate(detail)))
    radius = 2 if scale == 6 else 1

    def filtered(values, maximum, horizontal):
        result = array('f', [0]) * n
        choose = max if maximum else min
        for y in range(h):
            for x in range(w):
                items = []
                for d in range(-radius, radius + 1):
                    xx = max(0, min(w - 1, x + d)) if horizontal else x
                    yy = y if horizontal else max(0, min(h - 1, y + d))
                    j = yy * w + xx
                    if valid[j]:
                        items.append(values[j])
                result[y * w + x] = choose(items) if items else light[y * w + x]
        return result

    closed = filtered(
        filtered(filtered(filtered(light, True, True), True, False), False, True), False, False
    )
    gx, gy, corner = (array('f', [0]) * n for _ in range(3))
    candidate = bytearray(n)
    for y in range(1, h - 1):
        for x in range(1, w - 1):
            i = y * w + x
            if not valid[i]:
                continue
            gx[i] = (
                light[i - w + 1]
                + 2 * light[i + 1]
                + light[i + w + 1]
                - light[i - w - 1]
                - 2 * light[i - 1]
                - light[i + w - 1]
            ) / 8
            gy[i] = (
                light[i + w - 1]
                + 2 * light[i + w]
                + light[i + w + 1]
                - light[i - w - 1]
                - 2 * light[i - w]
                - light[i - w + 1]
            ) / 8
            candidate[i] = closed[i] - light[i] >= 0.09 and light[i] < 0.62
    for y in range(2, h - 2):
        for x in range(2, w - 2):
            xx = xy = yy = 0
            for dy in range(-1, 2):
                for dx in range(-1, 2):
                    j = (y + dy) * w + x + dx
                    xx += gx[j] ** 2
                    xy += gx[j] * gy[j]
                    yy += gy[j] ** 2
            corner[y * w + x] = (xx + yy - math.hypot(xx - yy, 2 * xy)) / 18
    coverage = array('f', [0]) * (width * height)
    strengths = array('f', [0]) * (width * height)
    colors = [(0, 0, 0)] * (width * height)
    owners = [-1] * (width * height)
    components = []
    seen = bytearray(n)
    for start in range(n):
        if not candidate[start] or seen[start]:
            continue
        items = [start]
        seen[start] = 1
        left, right, top, bottom, peak, blanks = w, 0, h, 0, 0, 0
        for i in items:
            x, y = i % w, i // w
            left, right, top, bottom = min(left, x), max(right, x), min(top, y), max(bottom, y)
            peak = max(peak, corner[i])
            blank = False
            for dy in range(-1, 2):
                for dx in range(-1, 2):
                    xx, yy = x + dx, y + dy
                    if not (0 <= xx < w and 0 <= yy < h):
                        blank = True
                        continue
                    j = yy * w + xx
                    if not valid[j]:
                        blank = True
                    if candidate[j] and not seen[j]:
                        seen[j] = 1
                        items.append(j)
            blanks += blank
        if (
            len(items) < max(2, int(scale * scale * 0.055 + 0.5))
            or len(items) > scale * scale * 4
            or right - left > scale * 4
            or bottom - top > scale * 4
            or blanks / len(items) > 0.15
            or peak < 0.0005
        ):
            continue
        member, outside, queue = set(items), set(), []
        for y in range(top, bottom + 1):
            for x in range(left, right + 1):
                i = y * w + x
                if i not in member and (x in (left, right) or y in (top, bottom)):
                    outside.add(i)
                    queue.append(i)
        for i in queue:
            x, y = i % w, i // w
            for xx, yy in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                j = yy * w + xx
                if (
                    left <= xx <= right
                    and top <= yy <= bottom
                    and j not in member
                    and j not in outside
                ):
                    outside.add(j)
                    queue.append(j)
        if (right - left + 1) * (bottom - top + 1) - len(member) - len(outside) >= 2:
            continue
        overlaps = {}
        for i in items:
            cell = (i // w // scale) * width + (i % w // scale)
            overlaps.setdefault(cell, []).append(i)
        maximum = max(map(len, overlaps.values()))
        owner = len(components)
        components.append((left, right, top, bottom))
        budget = max(1, math.ceil(len(items) / (scale * scale * 0.45)))
        ranked = sorted(overlaps.items(), key=lambda v: -len(v[1]))
        for cell, group in ranked[:budget]:
            if len(group) < max(2, maximum * 0.4, scale * scale * 0.15) and len(group) != maximum:
                continue
            strength = peak * len(group)
            if strength <= strengths[cell]:
                continue
            strengths[cell], owners[cell] = strength, owner
            coverage[cell] = len(group) / (scale * scale)
            minimum = min(light[i] for i in group)
            ink = [i for i in group if light[i] <= minimum + 0.1]
            colors[cell] = tuple(
                int(sum(detail[i][c] for i in ink) / len(ink) + 0.5) for c in range(3)
            )
    sizes = [0] * len(components)
    for owner in owners:
        if owner >= 0:
            sizes[owner] += 1
    for i in range(len(owners)):
        if not strengths[i]:
            continue
        for j in neighbors(i, width, height):
            if not strengths[j] or owners[i] == owners[j]:
                continue
            a, b = components[owners[i]], components[owners[j]]
            gap = max(b[0] - a[1] - 1, a[0] - b[1] - 1, b[2] - a[3] - 1, a[2] - b[3] - 1)
            if gap < scale * 0.4:
                continue
            remove = i if strengths[i] < strengths[j] else j
            if sizes[owners[remove]] > 1:
                strengths[remove] = 0
                sizes[owners[remove]] -= 1
            if not strengths[i]:
                break
    return strengths, colors, coverage


def sample_craft(pixels, detail, width, height, alpha_threshold=128):
    """Retain supported fill and compact strokes without enlarging occupancy."""
    result = list(pixels)
    scale = math.isqrt(len(detail) // (width * height))
    strengths, colors, coverage = extract_craft_features(detail, width, height, alpha_threshold)

    def delta(a, b):
        return sum((a[c] - b[c]) ** 2 for c in range(3)) ** 0.5

    def average(group):
        return tuple(int(sum(p['rgb'][c] for p in group) / len(group) + 0.5) for c in range(3))

    for i, pixel in enumerate(pixels):
        if pixel[3] < alpha_threshold:
            continue
        base = oklab(pixel[:3])
        if strengths[i] > 0 and base[0] >= 0.55 and oklab(colors[i])[0] < base[0] - 0.1:
            mix = min(0.85, 0.35 + coverage[i] * 0.65)
            result[i] = tuple(
                int(pixel[c] * (1 - mix) + colors[i][c] * mix + 0.5) for c in range(3)
            ) + (pixel[3],)
            continue
        samples = []
        for dy in range(3):
            for dx in range(3):
                p = detail[
                    (i // width * scale + int((dy + 0.5) * scale / 3)) * width * scale
                    + i % width * scale
                    + int((dx + 0.5) * scale / 3)
                ]
                if p[3] >= alpha_threshold:
                    lab = oklab(p[:3])
                    samples.append({'rgb': p[:3], 'lab': lab, 'light': lab[0], 'x': dx, 'y': dy})
        if len(samples) < 5:
            continue
        clusters = [
            [p for p in samples if delta(p['lab'], anchor['lab']) < 0.09] for anchor in samples
        ]
        accents = []
        for group in clusters:
            if len(group) < 3:
                continue
            lab = oklab(average(group))
            chroma = (lab[1] ** 2 + lab[2] ** 2) ** 0.5
            base_chroma = (base[1] ** 2 + base[2] ** 2) ** 0.5
            if (
                chroma >= 0.075
                and lab[0] >= 0.45
                and base_chroma >= 0.025
                and (lab[1] * base[1] + lab[2] * base[2]) / (chroma * base_chroma) > 0.8
            ):
                accents.append(group)
        if accents:
            result[i] = average(max(accents, key=len)) + (pixel[3],)
            continue
        if len(samples) < 8 or base[0] < 0.45:
            continue
        samples.sort(key=lambda p: p['light'])
        if (
            samples[-1]['light'] - samples[0]['light'] < 0.22
            or samples[4]['light'] - samples[1]['light'] < 0.06
        ):
            continue
        light = (samples[0]['light'] + samples[1]['light']) / 2
        if light >= 0.52 or base[0] - light < 0.1:
            continue
        if abs(samples[0]['x'] - samples[1]['x']) + abs(samples[0]['y'] - samples[1]['y']) != 1:
            continue
        if sum(p['light'] <= light + 0.08 for p in samples) > 3:
            continue
        result[i] = average(samples[:2]) + (pixel[3],)
    return result


def convert(config, image_path):
    width, height, palette = validate(config)
    image_path = Path(image_path)
    processing = {
        name: config.get(name, default)
        for name, default in (
            ('background', 'transparent'),
            ('background_tolerance', 32),
            ('alpha_threshold', 128),
            ('cleanup', 1),
            ('color_detail', 'medium'),
        )
    }
    with Image.open(image_path) as im:
        if im.width * im.height > 40_000_000:
            raise ValueError('图片限制为 4000 万像素')
        im = ImageOps.exif_transpose(im).convert('RGBA')
        before_mask = None
        source_background_removed = False
        if processing['background'] == 'auto' and processing['cleanup'] == 4:
            im.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
            before_mask = im.copy()
            masked, source_count = remove_background(
                list(im.getdata()),
                im.width,
                im.height,
                processing['background_tolerance'],
                processing['alpha_threshold'],
                source=True,
            )
            source_background_removed = source_count > 0
            im.putdata(masked)
        if processing['background'] == 'keep':
            bg = Image.new('RGBA', im.size, 'white')
            bg.alpha_composite(im)
            im = bg
        sampling_image = im.copy() if processing['cleanup'] == 4 else None
        if config.get('fit', 'contain') == 'cover':
            im = ImageOps.fit(im, (width, height), method=Image.Resampling.LANCZOS)
        else:
            im = ImageOps.pad(
                im,
                (width, height),
                method=Image.Resampling.LANCZOS,
                color='white' if processing['background'] == 'keep' else (0, 0, 0, 0),
            )
        pixels = list(im.getdata())
        source_removed = 0
        if before_mask is not None:
            fit = ImageOps.fit if config.get('fit', 'contain') == 'cover' else ImageOps.pad
            old = fit(before_mask, (width, height), method=Image.Resampling.LANCZOS)
            source_removed = sum(
                a[3] >= processing['alpha_threshold'] and b[3] < processing['alpha_threshold']
                for a, b in zip(old.getdata(), pixels)
            )
        if sampling_image is not None:
            fit = ImageOps.fit if config.get('fit', 'contain') == 'cover' else ImageOps.pad
            detail = (
                fit(
                    sampling_image,
                    (width * 6, height * 6),
                    method=Image.Resampling.LANCZOS,
                    color='white' if processing['background'] == 'keep' else (0, 0, 0, 0),
                )
                if fit is ImageOps.pad
                else fit(sampling_image, (width * 6, height * 6), method=Image.Resampling.LANCZOS)
            )
            pixels = sample_craft(
                pixels, list(detail.getdata()), width, height, processing['alpha_threshold']
            )
    removed_background = source_removed
    if processing['background'] == 'auto' and not source_background_removed:
        pixels, removed_background = remove_background(
            pixels, width, height, processing['background_tolerance'], processing['alpha_threshold']
        )
    colors = [tuple(int(c['hex'][i : i + 2], 16) for i in (1, 3, 5)) for c in palette]
    palette_labs = [oklab(c) for c in colors]
    cache = {}
    cells = []
    for pixel in pixels:
        if pixel[3] < processing['alpha_threshold']:
            cells.append(None)
            continue
        rgb = pixel[:3]
        if rgb not in cache:
            cache[rgb] = nearest(rgb, colors, palette_labs)
        cells.append(cache[rgb])
    cells, cleaned_cells = cleanup_cells(cells, width, height, colors, processing['cleanup'])
    blank_cells = cells.count(None)
    return {
        'version': 2,
        'title': str(config.get('title', '手工图纸')),
        'mode': config.get('mode', 'bead'),
        'width': width,
        'height': height,
        'palette': palette,
        'cells': cells,
        'source': {'name': image_path.name, 'fit': config.get('fit', 'contain')},
        'processing': processing,
        'metrics': {
            'blank_cells': blank_cells,
            'bead_count': len(cells) - blank_cells,
            'removed_background': removed_background,
            'cleaned_cells': cleaned_cells,
        },
        'notes': [
            '颜色由明确色板映射，屏幕色与实物色可能有差异。',
            '自动去底仅适合与主体可区分的纯色背景；请检查轮廓和小细节。',
        ],
    }


def build(config_path, output, image_override=None):
    config_path = Path(config_path)
    config = json.loads(config_path.read_text('utf-8'))
    image_path = (
        Path(image_override)
        if image_override
        else config_path.parent / config.get('image', 'demo.png')
    )
    data = convert(config, image_path)
    page = (ROOT / 'assets/template.html').read_text('utf-8')
    for token, name in (
        ('__STYLE__', 'editor.css'),
        ('__CORE__', 'pattern-core.js'),
        ('__LIBRARY_CLIENT__', 'library-client.js'),
        ('__LIBRARY_UI__', 'library-ui.js'),
        ('__EDITOR__', 'editor.js'),
    ):
        if token in page:
            page = page.replace(token, (ROOT / 'assets' / name).read_text('utf-8'))
    if '__SOURCE_IMAGE__' in page:
        with Image.open(image_path) as source:
            source = ImageOps.exif_transpose(source).convert('RGBA')
            source.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
            buffer = io.BytesIO()
            source.save(buffer, format='PNG')
        page = page.replace(
            '__SOURCE_IMAGE__',
            'data:image/png;base64,' + base64.b64encode(buffer.getvalue()).decode('ascii'),
        )
    payload = json.dumps(data, ensure_ascii=False).replace('<', '\\u003c')
    page = page.replace('__DATA__', payload)
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(page, 'utf-8')
    output.with_suffix('.json').write_text(json.dumps(data, ensure_ascii=False, indent=2), 'utf-8')
    return data


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('input')
    p.add_argument('--image')
    p.add_argument('--output', required=True)
    p.add_argument('--library', help='案例库目录，默认 ~/.craft-pattern/library')
    p.add_argument('--no-archive', action='store_true', help='仅生成图纸，不自动收录')
    p.add_argument('--case-id', help='保存为已有案例的新版本')
    p.add_argument('--tags', help='案例标签，用逗号分隔')
    args = p.parse_args()
    try:
        result = build(args.input, args.output, args.image)
    except (ValueError, OSError, KeyError, TypeError) as e:
        p.exit(2, f'错误：{e}\n')
    print(f'已生成 {args.output} · {result["width"]}×{result["height"]} 格')
    if not args.no_archive:
        try:
            from library import save_case

            config_path = Path(args.input)
            config = json.loads(config_path.read_text('utf-8'))
            image_path = (
                Path(args.image)
                if args.image
                else config_path.parent / config.get('image', 'demo.png')
            )
            metadata = {}
            if args.tags is not None:
                metadata['tags'] = [
                    tag.strip() for tag in args.tags.replace('，', ',').split(',') if tag.strip()
                ]
            saved = save_case(
                result,
                source_path=image_path,
                metadata=metadata,
                case_id=args.case_id,
                library_dir=args.library,
            )
            print(f'已收录案例 {saved["case"]["id"]} · v{saved["case"]["version_count"]}')
        except Exception as error:
            p.exit(2, f'图纸已生成，但案例归档失败：{error}\n')
