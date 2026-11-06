/* Shared, dependency-free image processing and pattern export helpers. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PatternCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SYMBOLS = '123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0';
  const WEIGHTS = [0.2126, 0.7152, 0.0722];
  const COLOR_DETAILS = {
    low: { tolerance: .11, blackL: .36, blackC: .04 },
    medium: { tolerance: .075, blackL: .32, blackC: .035 },
    high: { tolerance: .035, blackL: 0, blackC: 0 },
  };

  function colorDetailSettings(level) {
    if (typeof level !== 'string' || !Object.prototype.hasOwnProperty.call(COLOR_DETAILS, level)) throw Error('颜色区分度须为 low、medium 或 high');
    return COLOR_DETAILS[level];
  }
  const LINEAR = Array.from({ length: 256 }, (_, value) => {
    const v = value / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });

  function integer(value, min, max, message) {
    if (!Number.isInteger(value) || value < min || value > max) throw Error(message);
    return value;
  }

  function dimensions(width, height) {
    integer(width, 4, 160, '图纸宽度须为 4–160 的整数');
    integer(height, 4, 160, '图纸高度须为 4–160 的整数');
  }

  function normalizeOptions(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('处理参数须为对象');
    const options = {
      background: input.background ?? 'transparent',
      background_tolerance: input.background_tolerance ?? 32,
      alpha_threshold: input.alpha_threshold ?? 128,
      cleanup: input.cleanup ?? 1,
      color_detail: input.color_detail === undefined ? 'medium' : input.color_detail,
    };
    if (!['keep', 'transparent', 'auto'].includes(options.background)) throw Error('背景模式无效');
    integer(options.background_tolerance, 0, 120, '去背景容差须为 0–120 的整数');
    integer(options.alpha_threshold, 1, 255, '透明阈值须为 1–255 的整数');
    integer(options.cleanup, 0, 4, '杂色清理强度须为 0–4 的整数');
    colorDetailSettings(options.color_detail);
    return options;
  }

  function validatePalette(input) {
    if (!Array.isArray(input) || input.length < 2 || input.length > 36) throw Error('色板需要 2–36 种颜色');
    const ids = new Set();
    return input.map(color => {
      if (!color || typeof color !== 'object' || typeof color.id !== 'string' || !color.id.trim() || ids.has(color.id)) {
        throw Error('色号须非空且唯一');
      }
      if (typeof color.hex !== 'string' || !/^#[\da-f]{6}$/i.test(color.hex)) throw Error('颜色格式须为 #RRGGBB');
      ids.add(color.id);
      const result = { id: color.id, hex: color.hex.toUpperCase() };
      return result;
    });
  }

  function validatePattern(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || ![1, 2].includes(input.version)) {
      throw Error('不支持的图纸版本');
    }
    dimensions(input.width, input.height);
    const palette = validatePalette(input.palette);
    const size = input.width * input.height;
    const mode = input.mode ?? 'bead';
    if (!['bead', 'cross-stitch'].includes(mode)) throw Error('图纸模式无效');
    if (!Array.isArray(input.cells) || input.cells.length !== size) throw Error('格子数量与图纸尺寸不一致');
    const cells = input.cells.map(value => {
      if (value === null && input.version === 2) return null;
      return integer(value, 0, palette.length - 1, '格子色号无效');
    });
    const result = {
      version: 2,
      title: typeof input.title === 'string' ? input.title : '手工图纸',
      mode,
      width: input.width,
      height: input.height,
      palette,
      cells,
    };
    if (input.source && typeof input.source === 'object' && !Array.isArray(input.source)) {
      result.source = {};
      if (typeof input.source.name === 'string') result.source.name = input.source.name;
      if (['contain', 'cover'].includes(input.source.fit)) result.source.fit = input.source.fit;
    }
    if (input.processing != null) result.processing = normalizeOptions(input.processing);
    if (Array.isArray(input.notes)) result.notes = input.notes.filter(note => typeof note === 'string').slice(0, 50);
    const blanks = cells.filter(value => value === null).length;
    result.metrics = { blank_cells: blanks, bead_count: size - blanks, removed_background: 0, cleaned_cells: 0 };
    if (input.metrics && typeof input.metrics === 'object' && !Array.isArray(input.metrics)) {
      for (const key of ['removed_background', 'cleaned_cells']) {
        const value = input.metrics[key];
        if (Number.isInteger(value) && value >= 0 && value <= size) result.metrics[key] = value;
      }
    }
    return result;
  }

  function neighbours(index, width, height) {
    const x = index % width;
    const y = Math.floor(index / width);
    const items = [];
    if (x > 0) items.push(index - 1);
    if (x + 1 < width) items.push(index + 1);
    if (y > 0) items.push(index - width);
    if (y + 1 < height) items.push(index + width);
    return items;
  }

  function edge(index, width, height) {
    return index % width === 0 || index % width === width - 1 || index < width || index >= width * (height - 1);
  }

  function prepareRGBA(rgba, width, height, input = {}, source = false) {
    if (source) {
      integer(width, 1, 1024, '源图预处理宽度无效');
      integer(height, 1, 1024, '源图预处理高度无效');
    } else dimensions(width, height);
    const processing = normalizeOptions(input);
    const size = width * height;
    if (!rgba || rgba.length !== size * 4) throw Error('图片像素数量无效');
    const pixels = new Uint8ClampedArray(rgba);
    const opaque = new Uint8Array(size);
    let left = width;
    let right = -1;
    let top = height;
    let bottom = -1;

    for (let index = 0; index < size; index++) {
      const offset = index * 4;
      if (processing.background === 'keep') {
        const alpha = pixels[offset + 3] / 255;
        for (let channel = 0; channel < 3; channel++) pixels[offset + channel] = Math.round(pixels[offset + channel] * alpha + 255 * (1 - alpha));
        pixels[offset + 3] = 255;
      } else if (pixels[offset + 3] < processing.alpha_threshold) {
        pixels[offset + 3] = 0;
      }
      if (pixels[offset + 3] !== 0) {
        opaque[index] = 1;
        const x = index % width;
        const y = Math.floor(index / width);
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }

    let removed = 0;
    if (processing.background === 'auto' && right >= left) {
      const histogram = new Map();
      let samples = 0;
      for (let y = top; y <= bottom; y++) {
        for (let x = left; x <= right; x++) {
          if (x !== left && x !== right && y !== top && y !== bottom) continue;
          const index = y * width + x;
          if (!opaque[index]) continue;
          const offset = index * 4;
          const rgb = [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
          const sourceNeutral = source && Math.min(...rgb) >= 140 && Math.max(...rgb) - Math.min(...rgb) <= 24;
          const key = sourceNeutral ? 'neutral-backdrop' : rgb.map(value => Math.floor(value / 16)).join(',');
          if (!histogram.has(key)) histogram.set(key, { count: 0, sum: [0, 0, 0] });
          const bin = histogram.get(key);
          bin.count++;
          rgb.forEach((value, channel) => { bin.sum[channel] += value; });
          samples++;
        }
      }
      let best = null;
      for (const bin of histogram.values()) if (!best || bin.count > best.count) best = bin;
      if (best && best.count / samples >= 0.35) {
        const reference = best.sum.map(value => value / best.count);
        const referenceMean = reference.reduce((a, b) => a + b) / 3;
        const neutralBackdrop = referenceMean >= 150 && Math.max(...reference) - Math.min(...reference) <= 24;
        const tolerance2 = processing.background_tolerance ** 2;
        const candidates = new Uint8Array(size);
        for (let index = 0; index < size; index++) {
          if (!opaque[index]) continue;
          const offset = index * 4;
          let distance = 0;
          for (let channel = 0; channel < 3; channel++) distance += (pixels[offset + channel] - reference[channel]) ** 2;
          const rgb = Array.from(pixels.slice(offset, offset + 3));
          const mean = rgb.reduce((a, b) => a + b) / 3;
          // Studio backdrops vary mainly in brightness. Accept a bounded range
          // of neutral shadows, but never walk into dark clothes or skin hues.
          const shadow = neutralBackdrop && processing.background_tolerance > 0 &&
            Math.max(...rgb) - Math.min(...rgb) <= 24 && mean >= 140 &&
            Math.abs(mean - referenceMean) <= Math.min(64, processing.background_tolerance * 1.75) &&
            Math.hypot(...rgb.map((v, c) => v - mean - reference[c] + referenceMean)) <= Math.max(8, processing.background_tolerance * .45);
          if (distance <= tolerance2 || shadow) candidates[index] = 1;
        }
        const seen = new Uint8Array(size);
        const queue = [];
        for (let index = 0; index < size; index++) {
          if (candidates[index] && (edge(index, width, height) || neighbours(index, width, height).some(next => !opaque[next]))) {
            queue.push(index);
            seen[index] = 1;
          }
        }
        for (let cursor = 0; cursor < queue.length; cursor++) {
          const index = queue[cursor];
          pixels[index * 4 + 3] = 0;
          removed++;
          for (const next of neighbours(index, width, height)) {
            if (candidates[next] && !seen[next]) {
              seen[next] = 1;
              queue.push(next);
            }
          }
        }
      }
    }
    return { pixels, processing, removed_background: removed };
  }

  function paletteRGB(palette) {
    return palette.map(color => [1, 3, 5].map(offset => parseInt(color.hex.slice(offset, offset + 2), 16)));
  }

  function distance(a, b) {
    return WEIGHTS.reduce((sum, weight, channel) => sum + weight * (LINEAR[a[channel]] - LINEAR[b[channel]]) ** 2, 0);
  }

  // sRGB to Oklab; see https://www.w3.org/TR/css-color-4/#color-conversion-code.
  // The craft tolerance below is intentionally larger than a just-noticeable difference.
  function oklab(rgb) {
    const [r, g, b] = rgb.map(value => LINEAR[value]);
    const l = Math.cbrt(.4122214708 * r + .5363325363 * g + .0514459929 * b);
    const m = Math.cbrt(.2119034982 * r + .6806995451 * g + .1073969566 * b);
    const s = Math.cbrt(.0883024619 * r + .2817188376 * g + .6299787005 * b);
    return [.2104542553 * l + .793617785 * m - .0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + .4505937099 * s,
      .0259040371 * l + .7827717662 * m - .808675766 * s];
  }

  function colorDistance(a, b) {
    const delta = a.reduce((sum, v, c) => sum + (v - b[c]) ** 2, 0);
    const ca = Math.hypot(a[1], a[2]), cb = Math.hypot(b[1], b[2]);
    if (ca < .025 || cb < .025) return delta;
    // Perceptual lightness alone can make pale yellow map to pale pink.
    // Penalize hue rotation while still permitting limited explicit palettes.
    const cosine = Math.max(-1, Math.min(1, (a[1] * b[1] + a[2] * b[2]) / (ca * cb)));
    return delta + 4 * ca * cb * (1 - cosine);
  }

  function mergePalette(inputPalette, weights, tolerance = null, colorDetail = 'medium') {
    const palette = validatePalette(inputPalette);
    const settings = colorDetailSettings(colorDetail);
    tolerance = tolerance ?? settings.tolerance;
    if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > .2) throw Error('近色合并容差无效');
    const rgb = paletteRGB(palette), labs = rgb.map(oklab);
    // Near-neutral blacks are one practical bead shade. A fixed, bounded band
    // avoids spending materials on tiny shadow differences, without swallowing
    // dark blue/red accents or extending a grey gradient through neighbour links.
    const nearBlack = lab => colorDetail !== 'high' && lab[0] <= settings.blackL && Math.hypot(lab[1], lab[2]) <= settings.blackC;
    const deltas = labs.map(a => labs.map(b => {
      if (tolerance > 0 && nearBlack(a) && nearBlack(b)) return 0;
      const ca = Math.hypot(a[1], a[2]), cb = Math.hypot(b[1], b[2]);
      // Pink accents and tan fur can be close in total distance yet convey
      // different colors. Use a tighter hue guard for clearly chromatic
      // pastels, so yellow cheeks cannot merge into tan fur before mapping.
      if (ca >= .025 && cb >= .025 && (a[1] * b[1] + a[2] * b[2]) / (ca * cb) < Math.cos(Math.PI / 12)) return Infinity;
      return Math.hypot(...a.map((value, i) => value - b[i]));
    }));
    const groups = palette.map((_, index) => [index]);
    // Complete-link clustering: every original color in a group must be close.
    // This prevents a long gradient from collapsing through a chain of neighbours.
    while (groups.length > 1) {
      let pair = null, best = Infinity;
      for (let a = 0; a < groups.length; a++) for (let b = a + 1; b < groups.length; b++) {
        let diameter = 0;
        for (const i of groups[a]) for (const j of groups[b]) diameter = Math.max(diameter, deltas[i][j]);
        if (diameter <= tolerance && diameter < best) { pair = [a, b]; best = diameter; }
      }
      if (!pair) break;
      groups[pair[0]].push(...groups[pair[1]]);
      groups.splice(pair[1], 1);
    }
    const mapping = Array(palette.length);
    const merged = groups.map((members, index) => {
      let representative = members[0];
      const total = members.reduce((sum, i) => sum + weights[i], 0);
      const sum = [0, 0, 0];
      for (const i of members) {
        mapping[i] = index;
        if (weights[i] > weights[representative]) representative = i;
        rgb[i].forEach((value, channel) => { sum[channel] += value * (total ? weights[i] : 1); });
      }
      const hex = '#' + sum.map(value => Math.round(value / (total || members.length)).toString(16).padStart(2, '0')).join('').toUpperCase();
      return { id: palette[representative].id, hex };
    });
    // The existing file format requires at least two palette entries. The spare
    // stays unused and contrasting, so repeated merging is a no-op.
    if (merged.length === 1) {
      let id = 'SPARE';
      while (merged.some(color => color.id === id)) id += '_';
      merged.push({ id, hex: oklab(paletteRGB(merged)[0])[0] < .5 ? '#FFFFFF' : '#000000' });
    }
    return { palette: merged, mapping, merged_colors: palette.length - groups.length };
  }

  function mergeSimilarColors(input, tolerance = null, colorDetail = undefined) {
    const pattern = validatePattern(input);
    const detail = colorDetail ?? pattern.processing?.color_detail ?? 'medium';
    const result = mergePalette(pattern.palette, counts(pattern), tolerance, detail);
    return { ...result, cells: pattern.cells.map(value => value === null ? null : result.mapping[value]) };
  }

  // Classical local features: grayscale closing/black-hat and the minimum
  // eigenvalue of a Sobel structure tensor (Shi–Tomasi). No learned detector.
  function extractCraftFeatures(detail, width, height, alphaThreshold = 128) {
    dimensions(width, height);
    const scale = Math.sqrt(detail.length / (width * height * 4));
    if (![3, 6].includes(scale)) throw Error('细节采样尺寸无效');
    const w = width * scale, h = height * scale, n = w * h;
    const light = new Float32Array(n), valid = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      valid[i] = detail[i * 4 + 3] >= alphaThreshold;
      light[i] = valid[i] ? oklab(Array.from(detail.slice(i * 4, i * 4 + 3)))[0] : 1;
    }
    const radius = scale === 6 ? 2 : 1;
    function filter(input, maximum, horizontal) {
      const out = new Float32Array(n);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let value = maximum ? -Infinity : Infinity;
        for (let d = -radius; d <= radius; d++) {
          const xx = horizontal ? Math.max(0, Math.min(w - 1, x + d)) : x;
          const yy = horizontal ? y : Math.max(0, Math.min(h - 1, y + d));
          const j = yy * w + xx;
          if (valid[j]) value = maximum ? Math.max(value, input[j]) : Math.min(value, input[j]);
        }
        out[i] = Number.isFinite(value) ? value : light[i];
      }
      return out;
    }
    const closed = filter(filter(filter(filter(light, true, true), true, false), false, true), false, false);
    const gx = new Float32Array(n), gy = new Float32Array(n), corner = new Float32Array(n);
    const candidate = new Uint8Array(n);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!valid[i]) continue;
      const at = (dx, dy) => light[i + dy * w + dx];
      gx[i] = (at(1, -1) + 2 * at(1, 0) + at(1, 1) - at(-1, -1) - 2 * at(-1, 0) - at(-1, 1)) / 8;
      gy[i] = (at(-1, 1) + 2 * at(0, 1) + at(1, 1) - at(-1, -1) - 2 * at(0, -1) - at(1, -1)) / 8;
      if (closed[i] - light[i] >= .09 && light[i] < .62) candidate[i] = 1;
    }
    for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
      let xx = 0, xy = 0, yy = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const j = (y + dy) * w + x + dx;
        xx += gx[j] ** 2; xy += gx[j] * gy[j]; yy += gy[j] ** 2;
      }
      corner[y * w + x] = (xx + yy - Math.hypot(xx - yy, 2 * xy)) / 18;
    }
    const coverage = new Float32Array(width * height);
    const strengths = new Float32Array(width * height), colors = new Uint8ClampedArray(width * height * 3);
    const owners = new Int32Array(width * height).fill(-1), components = [];
    const seen = new Uint8Array(n);
    for (let start = 0; start < n; start++) {
      if (!candidate[start] || seen[start]) continue;
      const items = [start]; seen[start] = 1;
      let left = w, right = 0, top = h, bottom = 0, peak = 0, blanks = 0;
      for (let cursor = 0; cursor < items.length; cursor++) {
        const i = items[cursor], x = i % w, y = Math.floor(i / w);
        left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
        peak = Math.max(peak, corner[i]);
        let blank = false;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || xx >= w || yy < 0 || yy >= h) { blank = true; continue; }
          const j = yy * w + xx;
          if (!valid[j]) blank = true;
          if (candidate[j] && !seen[j]) { seen[j] = 1; items.push(j); }
        }
        if (blank) blanks++;
      }
      if (items.length < Math.max(2, Math.round(scale * scale * .055)) || items.length > scale * scale * 4 ||
          right - left > scale * 4 || bottom - top > scale * 4 || blanks / items.length > .15 || peak < .0005) continue;
      // Closed rings are object outlines (e.g. a red sphere), not compact
      // interior strokes. Filling them with dark beads would erase their fill.
      const member = new Set(items), outside = new Set(), queue = [];
      for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
        const i = y * w + x;
        if (!member.has(i) && (x === left || x === right || y === top || y === bottom)) { outside.add(i); queue.push(i); }
      }
      for (let cursor = 0; cursor < queue.length; cursor++) {
        const i = queue[cursor], x = i % w, y = Math.floor(i / w);
        for (const [xx, yy] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
          const j = yy * w + xx;
          if (xx >= left && xx <= right && yy >= top && yy <= bottom && !member.has(j) && !outside.has(j)) { outside.add(j); queue.push(j); }
        }
      }
      if ((right - left + 1) * (bottom - top + 1) - member.size - outside.size >= 2) continue;
      const overlaps = new Map();
      for (const i of items) {
        const cell = Math.floor(Math.floor(i / w) / scale) * width + Math.floor(i % w / scale);
        if (!overlaps.has(cell)) overlaps.set(cell, []);
        overlaps.get(cell).push(i);
      }
      const maximum = Math.max(...Array.from(overlaps.values(), a => a.length));
      const id = components.length;
      components.push({ left, right, top, bottom });
      const budget = Math.max(1, Math.ceil(items.length / (scale * scale * .45)));
      const ranked = Array.from(overlaps.entries()).sort((a, b) => b[1].length - a[1].length);
      for (const [cell, group] of ranked.slice(0, budget)) {
        if (group.length < Math.max(2, maximum * .4, scale * scale * .15) && group.length !== maximum) continue;
        const strength = peak * group.length;
        if (strength <= strengths[cell]) continue;
        strengths[cell] = strength; owners[cell] = id; coverage[cell] = group.length / (scale * scale);
        const minimum = Math.min(...group.map(i => light[i]));
        const ink = group.filter(i => light[i] <= minimum + .1);
        for (let c = 0; c < 3; c++) colors[cell * 3 + c] = Math.round(ink.reduce((sum, i) => sum + detail[i * 4 + c], 0) / ink.length);
      }
    }
    // Keep distinct source strokes separated when the grid can represent a
    // gap. Never delete the last anchor of a feature just to create whitespace.
    const sizes = Array(components.length).fill(0);
    for (const owner of owners) if (owner >= 0) sizes[owner]++;
    for (let i = 0; i < owners.length; i++) {
      if (!strengths[i]) continue;
      for (const j of neighbours(i, width, height)) {
        if (!strengths[j] || owners[i] === owners[j]) continue;
        const a = components[owners[i]], b = components[owners[j]];
        const gap = Math.max(b.left - a.right - 1, a.left - b.right - 1, b.top - a.bottom - 1, a.top - b.bottom - 1);
        if (gap < scale * .4) continue;
        const remove = strengths[i] < strengths[j] ? i : j;
        if (sizes[owners[remove]] > 1) { strengths[remove] = 0; sizes[owners[remove]]--; }
        if (!strengths[i]) break;
      }
    }
    return { strengths, colors, coverage };
  }

  function sampleCraftRGBA(rgba, detail, width, height, alphaThreshold = 128) {
    dimensions(width, height);
    const scale = Math.sqrt(detail.length / (width * height * 4));
    if (rgba.length !== width * height * 4 || ![3, 6].includes(scale)) throw Error('细节采样尺寸无效');
    const result = new Uint8ClampedArray(rgba);
    const features = extractCraftFeatures(detail, width, height, alphaThreshold);
    for (let i = 0; i < width * height; i++) {
      if (rgba[i * 4 + 3] < alphaThreshold) continue;
      const base = oklab(Array.from(rgba.slice(i * 4, i * 4 + 3)));
      if (features.strengths[i] > 0 && base[0] >= .55 &&
          oklab(Array.from(features.colors.slice(i * 3, i * 3 + 3)))[0] < base[0] - .1) {
        const mix = Math.min(.85, .35 + features.coverage[i] * .65);
        for (let c = 0; c < 3; c++) result[i * 4 + c] = Math.round(rgba[i * 4 + c] * (1 - mix) + features.colors[i * 3 + c] * mix);
        continue;
      }
      const samples = [];
      for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) {
        const offset = ((Math.floor(i / width) * scale + Math.floor((dy + .5) * scale / 3)) * width * scale + i % width * scale + Math.floor((dx + .5) * scale / 3)) * 4;
        if (detail[offset + 3] < alphaThreshold) continue;
        const rgb = Array.from(detail.slice(offset, offset + 3));
        const lab = oklab(rgb);
        samples.push({ rgb, lab, light: lab[0], x: dx, y: dy });
      }
      if (samples.length < 5) continue; // Never expand the sampled silhouette.
      const delta = (a, b) => Math.hypot(...a.map((v, c) => v - b[c]));
      const average = group => [0, 1, 2].map(c => Math.round(group.reduce((n, p) => n + p.rgb[c], 0) / group.length));
      // A supported source-color cluster is preferable to a muddy average of
      // black outlines and colored fill. Do not invent accents from one sample.
      const clusters = samples.map(anchor => samples.filter(p => delta(p.lab, anchor.lab) < .09));
      const accents = clusters.filter(group => {
        if (group.length < 3) return false;
        const lab = oklab(average(group)), chroma = Math.hypot(lab[1], lab[2]);
        const baseChroma = Math.hypot(base[1], base[2]);
        return chroma >= .075 && lab[0] >= .45 && baseChroma >= .025 &&
          (lab[1] * base[1] + lab[2] * base[2]) / (chroma * baseChroma) > .8;
      }).sort((a, b) => b.length - a.length);
      if (accents.length) {
        const rgb = average(accents[0]);
        for (let c = 0; c < 3; c++) result[i * 4 + c] = rgb[c];
        continue;
      }
      if (samples.length < 8 || base[0] < .45) continue;
      samples.sort((a, b) => a.light - b.light);
      if (samples.at(-1).light - samples[0].light < .22 || samples[4].light - samples[1].light < .06) continue;
      const light = (samples[0].light + samples[1].light) / 2;
      if (light >= .52 || base[0] - light < .1) continue;
      // Preserve compact eye/mouth strokes, rather than dilating every dark
      // boundary into the fill. Disconnected sub-pixel noise is not a feature.
      if (Math.abs(samples[0].x - samples[1].x) + Math.abs(samples[0].y - samples[1].y) !== 1) continue;
      const dark = samples.filter(p => p.light <= light + .08);
      if (dark.length > 3) continue;
      for (let c = 0; c < 3; c++) result[i * 4 + c] = Math.round((samples[0].rgb[c] + samples[1].rgb[c]) / 2);
    }
    return result;
  }

  function cleanCells(input, width, height, inputPalette, strength = 1) {
    dimensions(width, height);
    integer(strength, 0, 4, '杂色清理强度须为 0–4 的整数');
    const palette = validatePalette(inputPalette);
    if (!Array.isArray(input) || input.length !== width * height) throw Error('格子数量无效');
    for (const value of input) if (value !== null) integer(value, 0, palette.length - 1, '格子色号无效');
    const cells = input.slice();
    if (strength === 0) return { cells, cleaned: 0 };
    if (strength === 4) return simplifyRegions(input, width, height, palette);
    const maxSize = [0, 1, 2, 4][strength];
    const limit = strength === 3 ? 0.06 : 0.035;
    const rgb = paletteRGB(palette);
    const seen = new Uint8Array(cells.length);
    let cleaned = 0;
    for (let start = 0; start < input.length; start++) {
      if (seen[start] || input[start] === null) continue;
      const color = input[start];
      const component = [start];
      seen[start] = 1;
      const border = new Map();
      let boundary = false;
      let perimeter = 0;
      for (let cursor = 0; cursor < component.length; cursor++) {
        const index = component[cursor];
        if (edge(index, width, height)) boundary = true;
        for (const next of neighbours(index, width, height)) {
          if (input[next] === color) {
            if (!seen[next]) { seen[next] = 1; component.push(next); }
          } else {
            if (input[next] === null) boundary = true;
            perimeter++;
            border.set(input[next], (border.get(input[next]) ?? 0) + 1);
          }
        }
      }
      if (boundary || component.length > maxSize || perimeter === 0) continue;
      let replacement = null;
      let votes = 0;
      for (const [candidate, count] of border) if (candidate !== null && count > votes) { replacement = candidate; votes = count; }
      if (replacement !== null && votes / perimeter >= 0.75 && distance(rgb[color], rgb[replacement]) <= limit) {
        for (const index of component) cells[index] = replacement;
        cleaned += component.length;
      }
    }
    return { cells, cleaned };
  }

  function simplifyRegions(input, width, height, palette) {
    const cells = input.slice(), labs = paletteRGB(palette).map(oklab);
    const maximum = Math.max(4, Math.min(12, Math.round(width * height * .003)));
    // Two bounded passes absorb fragments into substantially larger neighbours.
    // Each pass reads a frozen partition to limit cascaded flattening.
    for (let pass = 0; pass < 2; pass++) {
      const labels = new Int32Array(cells.length).fill(-1), regions = [];
      cells.forEach((color, start) => {
        if (color === null || labels[start] >= 0) return;
        const region = { color, items: [start], border: new Map(), blank: false };
        labels[start] = regions.length;
        for (let cursor = 0; cursor < region.items.length; cursor++) {
          const i = region.items[cursor];
          if (edge(i, width, height)) region.blank = true;
          for (const next of neighbours(i, width, height)) {
            if (cells[next] === null) region.blank = true;
            if (cells[next] === color && labels[next] < 0) { labels[next] = regions.length; region.items.push(next); }
          }
        }
        regions.push(region);
      });
      for (const region of regions) for (const i of region.items) for (const next of neighbours(i, width, height)) {
        const id = labels[next];
        if (id >= 0 && regions[id] !== region) region.border.set(id, (region.border.get(id) || 0) + 1);
      }
      let changed = false;
      for (const region of regions) {
        const size = region.items.length;
        if (size > maximum || !region.border.size) continue;
        const perimeter = Array.from(region.border.values()).reduce((a, b) => a + b, 0);
        let replacement = null, best = Infinity;
        for (const [id, votes] of region.border) {
          const target = regions[id];
          if (target.items.length < Math.max(8, size * 3) || votes / perimeter < .5) continue;
          const a = labs[region.color], b = labs[target.color];
          const delta = Math.hypot(...a.map((v, c) => v - b[c]));
          // Keep dark eyes/linework and vivid accents even when only one bead wide.
          const chroma = Math.hypot(a[1], a[2]), targetChroma = Math.hypot(b[1], b[2]);
          const distinctHue = chroma >= .03 && (targetChroma < .025 ||
            (a[1] * b[1] + a[2] * b[2]) / (chroma * targetChroma) < Math.cos(Math.PI / 12));
          if (((!region.blank || a[0] < .3) && a[0] < b[0] - .075) || chroma > .1 || distinctHue) continue;
          const lightFleck = !region.blank && size <= 3 && votes / perimeter >= .7 &&
            a[0] > .35 && a[0] < .88 && Math.hypot(a[1], a[2]) < .045 && b[0] < .32;
          if (delta > (lightFleck ? .55 : region.blank ? .27 : .18)) continue;
          const score = delta + .06 * (1 - votes / perimeter);
          if (score < best) { best = score; replacement = target.color; }
        }
        if (replacement === null) continue;
        for (const i of region.items) cells[i] = replacement;
        changed = true;
      }
      if (!changed) break;
    }
    return { cells, cleaned: cells.reduce((sum, color, i) => sum + (color !== input[i] ? 1 : 0), 0) };
  }

  function processRGBA(rgba, width, height, inputPalette, input = {}) {
    const palette = validatePalette(inputPalette);
    const prepared = prepareRGBA(rgba, width, height, input);
    const labs = paletteRGB(palette).map(oklab);
    const cache = new Map();
    const cells = [];
    for (let index = 0; index < width * height; index++) {
      const offset = index * 4;
      if (prepared.pixels[offset + 3] === 0) { cells.push(null); continue; }
      const pixel = Array.from(prepared.pixels.slice(offset, offset + 3));
      const key = pixel.join(',');
      if (!cache.has(key)) {
        let best = 0;
        let bestDistance = Infinity;
        const lab = oklab(pixel);
        labs.forEach((candidate, color) => {
          const delta = colorDistance(lab, candidate);
          if (delta < bestDistance) { best = color; bestDistance = delta; }
        });
        cache.set(key, best);
      }
      cells.push(cache.get(key));
    }
    const clean = cleanCells(cells, width, height, palette, prepared.processing.cleanup);
    const blanks = clean.cells.filter(value => value === null).length;
    return {
      cells: clean.cells,
      processing: prepared.processing,
      metrics: {
        blank_cells: blanks,
        bead_count: clean.cells.length - blanks,
        removed_background: prepared.removed_background,
        cleaned_cells: clean.cleaned,
      },
    };
  }

  function derivePalette(rgba, width, height, options = {}, maxColors = 12) {
    integer(maxColors, 2, 36, '自动提色数量须为 2–36 的整数');
    const { pixels, processing } = prepareRGBA(rgba, width, height, options);
    const histogram = new Map();
    for (let index = 0; index < width * height; index++) {
      const offset = index * 4;
      if (!pixels[offset + 3]) continue;
      const rgb = Array.from(pixels.slice(offset, offset + 3));
      const key = rgb.join(',');
      if (!histogram.has(key)) histogram.set(key, { rgb, count: 0 });
      histogram.get(key).count++;
    }
    const points = Array.from(histogram.values());
    const candidateLimit = Math.min(36, maxColors * 3);
    if (!points.length) return [{ id: 'AUTO01', hex: '#FFFFFF' }, { id: 'AUTO02', hex: '#000000' }];

    function box(items) {
      const min = [255, 255, 255];
      const max = [0, 0, 0];
      let count = 0;
      for (const item of items) {
        item.rgb.forEach((value, channel) => { min[channel] = Math.min(min[channel], value); max[channel] = Math.max(max[channel], value); });
        count += item.count;
      }
      const ranges = max.map((value, channel) => value - min[channel]);
      let channel = 0;
      ranges.forEach((range, index) => { if (range > ranges[channel]) channel = index; });
      return { items, count, channel, score: ranges[channel] * Math.sqrt(count) };
    }

    // Seed by hue before median cuts. A small pink heart must not be averaged
    // into a large tan character merely because their RGB ranges overlap.
    const families = new Map();
    for (const point of points) {
      const lab = oklab(point.rgb);
      const hue = (Math.atan2(lab[2], lab[1]) + Math.PI * 2) % (Math.PI * 2);
      const family = Math.hypot(lab[1], lab[2]) < .025 ? 'neutral' : Math.floor(hue / (Math.PI / 6));
      // Dark outlines can share a hue with bright pink accents. Keep the two
      // broad lightness bands independent before distributing the color budget.
      const key = family + ':' + (lab[0] < .5 ? 'dark' : 'light');
      if (!families.has(key)) families.set(key, []);
      families.get(key).push(point);
    }
    const seeds = Array.from(families.values()).map(box).sort((a, b) => b.count - a.count);
    const center = group => oklab([0, 1, 2].map(channel => Math.round(group.items.reduce((sum, p) => sum + p.rgb[channel] * p.count, 0) / group.count)));
    // Frequency alone spends the budget on several similar shadows before
    // cheeks/lips. Distribute seeds by perceptual separation and support.
    const remaining = seeds.slice(1), boxes = [seeds[0]];
    while (boxes.length < candidateLimit && remaining.length) {
      const centers = boxes.map(center);
      let best = 0, score = -1;
      remaining.forEach((group, i) => {
        const lab = center(group);
        const nearest = Math.min(...centers.map(other => Math.hypot(...lab.map((v, c) => v - other[c]))));
        const value = nearest * Math.sqrt(group.count);
        if (value > score) { score = value; best = i; }
      });
      boxes.push(remaining.splice(best, 1)[0]);
    }
    if (remaining.length) {
      const centers = boxes.map(group => oklab([0, 1, 2].map(channel => Math.round(group.items.reduce((sum, p) => sum + p.rgb[channel] * p.count, 0) / group.count))));
      for (const group of remaining) for (const point of group.items) {
        const lab = oklab(point.rgb);
        let best = 0, nearest = Infinity;
        centers.forEach((center, i) => {
          const delta = Math.hypot(...lab.map((value, c) => value - center[c]));
          if (delta < nearest) { best = i; nearest = delta; }
        });
        boxes[best].items.push(point);
      }
      boxes.forEach((group, i) => { boxes[i] = box(group.items); });
    }
    while (boxes.length < candidateLimit) {
      let selected = -1;
      boxes.forEach((item, index) => {
        if (item.items.length > 1 && (selected < 0 || item.score > boxes[selected].score)) selected = index;
      });
      if (selected < 0) break;
      const current = boxes[selected];
      const ordered = current.items.slice().sort((a, b) => a.rgb[current.channel] - b.rgb[current.channel] || a.rgb[0] - b.rgb[0] || a.rgb[1] - b.rgb[1] || a.rgb[2] - b.rgb[2]);
      let running = 0;
      let cut = 1;
      for (let index = 0; index < ordered.length - 1; index++) {
        running += ordered[index].count;
        cut = index + 1;
        if (running >= current.count / 2) break;
      }
      boxes.splice(selected, 1, box(ordered.slice(0, cut)), box(ordered.slice(cut)));
    }
    const colors = [], weights = [];
    for (const current of boxes) {
      const sum = [0, 0, 0];
      current.items.forEach(item => item.rgb.forEach((value, channel) => { sum[channel] += value * item.count; }));
      const hex = '#' + sum.map(value => Math.round(value / current.count).toString(16).padStart(2, '0')).join('').toUpperCase();
      const existing = colors.indexOf(hex);
      if (existing < 0) { colors.push(hex); weights.push(current.count); }
      else weights[existing] += current.count;
    }
    if (colors.length === 1) { colors.push(colors[0] === '#000000' ? '#FFFFFF' : '#000000'); weights.push(0); }
    const candidate = colors.map((hex, index) => ({ id: 'AUTO' + String(index + 1).padStart(2, '0'), hex }));
    const first = mergePalette(candidate, weights, null, processing.color_detail);
    const usage = Array(first.palette.length).fill(0);
    weights.forEach((weight, i) => { usage[first.mapping[i]] += weight; });
    // Reconcile representative averages once: quantization boxes can have
    // different extremes while their final displayed colors are nearly equal.
    const merged = mergePalette(first.palette, usage, null, processing.color_detail);
    const support = Array(merged.palette.length).fill(0);
    usage.forEach((weight, i) => { support[merged.mapping[i]] += weight; });
    const labs = paletteRGB(merged.palette).map(oklab);
    const selected = [support.indexOf(Math.max(...support))];
    // Merge redundant candidate shades before enforcing the material budget.
    // Otherwise several near-identical cuts can crowd out a small genuine hue.
    while (selected.length < Math.min(maxColors, merged.palette.length)) {
      let best = -1, score = -1;
      labs.forEach((lab, i) => {
        if (selected.includes(i)) return;
        const nearest = Math.min(...selected.map(j => Math.hypot(...lab.map((v, c) => v - labs[j][c]))));
        const chroma = Math.hypot(lab[1], lab[2]);
        const distinctHue = selected.every(j => {
          const other = labs[j], c = Math.hypot(other[1], other[2]);
          return c < .03 || (lab[1] * other[1] + lab[2] * other[2]) / (chroma * c) < Math.cos(Math.PI / 12);
        });
        const accent = selected.length >= 3 && chroma >= .03 && lab[0] >= .55 &&
          support[i] >= Math.max(2, width * height * .002) && distinctHue;
        const value = nearest * Math.sqrt(support[i]) * (accent ? 4 : 1);
        if (value > score) { score = value; best = i; }
      });
      selected.push(best);
    }
    return selected.map((i, index) => ({ ...merged.palette[i], id: 'AUTO' + String(index + 1).padStart(2, '0') }));
  }

  function counts(pattern) {
    const result = Array(pattern.palette.length).fill(0);
    for (const value of pattern.cells) {
      if (value === null) continue;
      integer(value, 0, result.length - 1, '格子色号无效');
      result[value]++;
    }
    return result;
  }

  function symbol(index) {
    return SYMBOLS[integer(index, 0, 35, '颜色符号超出范围')];
  }

  function escapeXML(value) {
    return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character]));
  }

  function toSVG(input, showSymbols = false) {
    const pattern = validatePattern(input);
    const parts = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${pattern.width * 5}mm" height="${pattern.height * 5}mm" viewBox="0 0 ${pattern.width * 20} ${pattern.height * 20}">`,
      `<title>${escapeXML(pattern.title)}</title>`,
      '<desc>空白格不放豆；图纸每格 5 mm，实际颗粒间距另行核对。</desc>',
    ];
    pattern.cells.forEach((value, index) => {
      const x = index % pattern.width * 20;
      const y = Math.floor(index / pattern.width) * 20;
      if (value === null) {
        parts.push(`<rect x="${x}" y="${y}" width="20" height="20" fill="none" stroke="#cbd5d1" stroke-width=".4"/>`);
        return;
      }
      const hex = pattern.palette[value].hex;
      parts.push(`<rect x="${x}" y="${y}" width="20" height="20" fill="${hex}" stroke="#81938a" stroke-width=".5"/>`);
      if (showSymbols) {
        const rgb = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
        const luminance = rgb.reduce((sum, channel, position) => sum + channel * WEIGHTS[position], 0);
        parts.push(`<text x="${x + 10}" y="${y + 14}" text-anchor="middle" font-family="monospace" font-size="12" fill="${luminance > 140 ? '#111111' : '#FFFFFF'}">${symbol(value)}</text>`);
      }
    });
    parts.push('</svg>');
    return parts.join('\n');
  }

  function toCSV(input) {
    const pattern = validatePattern(input);
    const usage = counts(pattern);
    const quote = value => '"' + String(value).replace(/"/g, '""') + '"';
    const rows = ['符号,色号,颜色,数量'];
    pattern.palette.forEach((color, index) => {
      const safeID = /^[\s]*[=+@\-]/.test(color.id) || /^[\t\r\n]/.test(color.id) ? "'" + color.id : color.id;
      rows.push([symbol(index), quote(safeID), color.hex, usage[index]].join(','));
    });
    return '\uFEFF' + rows.join('\r\n') + '\r\n';
  }

  const prepareSourceRGBA = (rgba, width, height, options) => prepareRGBA(rgba, width, height, options, true);
  return { normalizeOptions, validatePattern, prepareRGBA, prepareSourceRGBA, extractCraftFeatures, sampleCraftRGBA, processRGBA, cleanCells, derivePalette, mergeSimilarColors, counts, symbol, toSVG, toCSV };
}));
