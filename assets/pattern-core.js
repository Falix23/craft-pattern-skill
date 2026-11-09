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
  // Hand-drawn grid glyphs, not resized outlines or OCR. Narrow I and a wider
  // M/W leave a full blank column between letters at very small bead counts.
  const GRID_FONT = Object.fromEntries(Object.entries({
    A: '010/101/111/101/101', B: '110/101/110/101/110', C: '011/100/100/100/011',
    D: '110/101/101/101/110', E: '111/100/110/100/111', F: '111/100/110/100/100',
    G: '011/100/101/101/011', H: '101/101/111/101/101', I: '1/1/1/1/1',
    J: '001/001/001/101/010', K: '101/101/110/101/101', L: '100/100/100/100/111',
    M: '10001/11011/10101/10001/10001', N: '101/111/111/111/101', O: '010/101/101/101/010',
    P: '110/101/110/100/100', Q: '010/101/101/111/011', R: '110/101/110/101/101',
    S: '011/100/010/001/110', T: '111/010/010/010/010', U: '101/101/101/101/111',
    V: '101/101/101/101/010', W: '10001/10001/10101/11011/10001', X: '101/101/010/101/101',
    Y: '101/101/010/010/010', Z: '111/001/010/100/111',
    0: '111/101/101/101/111', 1: '01/11/01/01/01', 2: '110/001/010/100/111',
    3: '110/001/010/001/110', 4: '101/101/111/001/001', 5: '111/100/110/001/110',
    6: '011/100/111/101/111', 7: '111/001/010/010/010', 8: '111/101/111/101/111',
    9: '111/101/111/001/110', '-': '000/000/111/000/000',
    '.': '0/0/0/0/1', '/': '001/001/010/100/100',
  }).map(([key, rows]) => [key, rows.split('/')]));

  function validateTextLayers(input) {
    if (!Array.isArray(input) || input.length > 4) throw Error('文字配置须为最多4项的数组');
    const allowed = new Set(['text', 'box', 'clear_box', 'foreground', 'background', 'layout']);
    const rectangle = box => {
      if (!Array.isArray(box) || box.length !== 4 || box.some(n => typeof n !== 'number' || !Number.isFinite(n)) ||
        box[0] < 0 || box[1] < 0 || box[2] <= 0 || box[3] <= 0 || box[0] + box[2] > 1 + 1e-9 || box[1] + box[3] > 1 + 1e-9) {
        throw Error('文字区域须为画布比例 [x,y,width,height]，范围在0–1内');
      }
      return box.slice();
    };
    const layers = input.map(layer => {
      if (!layer || typeof layer !== 'object' || Array.isArray(layer) || Object.keys(layer).some(k => !allowed.has(k))) throw Error('文字配置含未知字段');
      if (typeof layer.text !== 'string' || !layer.text.trim() || layer.text.length > 80 || /[^A-Z0-9 .\/\n-]/.test(layer.text)) {
        throw Error('文字须先确认内容；目前支持1–80个大写英文字母、数字、空格、换行及 - . /');
      }
      const color = (value, nullable) => {
        if (nullable && value === null) return null;
        if (typeof value !== 'string' || !/^#[\da-f]{6}$/i.test(value)) throw Error('文字颜色须为 #RRGGBB；背景可为 null 留空');
        return value.toUpperCase();
      };
      const box = rectangle(layer.box);
      const result = { text: layer.text.trim(), box, clear_box: rectangle(layer.clear_box === undefined ? box : layer.clear_box),
        foreground: color(layer.foreground === undefined ? '#000000' : layer.foreground, false),
        background: color(layer.background === undefined ? null : layer.background, true), layout: layer.layout === undefined ? 'auto' : layer.layout };
      if (!['auto', 'single'].includes(result.layout)) throw Error('文字 layout 须为 auto 或 single');
      return result;
    });
    // A later layer must not silently erase a previously drawn text box.
    for (let i = 0; i < layers.length; i++) for (let j = i + 1; j < layers.length; j++) {
      for (const a of [layers[i].box, layers[i].clear_box]) for (const b of [layers[j].box, layers[j].clear_box]) {
        if (a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]) throw Error('文字区域不能相互重叠');
      }
    }
    return layers;
  }

  function textRectangle(box, width, height) {
    const x = Math.round(box[0] * width), y = Math.round(box[1] * height);
    return { x, y, w: Math.round((box[0] + box[2]) * width) - x, h: Math.round((box[1] + box[3]) * height) - y };
  }

  function textWidth(line) {
    return line.split(' ').reduce((sum, word, i) => sum + (i ? 2 : 0) +
      Array.from(word).reduce((n, c, j) => n + GRID_FONT[c][0].length + (j ? 1 : 0), 0), 0);
  }

  function layoutGridText(text, width, height, layout = 'auto') {
    if (typeof text !== 'string' || !text.trim() || text.length > 80 || /[^A-Z0-9 .\/\n-]/.test(text)) throw Error('请先确认大写英文或数字文字内容');
    integer(width, 1, 160, '文字区域宽度不足或无效');
    integer(height, 1, 160, '文字区域高度不足或无效');
    if (!['auto', 'single'].includes(layout)) throw Error('文字 layout 须为 auto 或 single');
    if (layout === 'single' && (text.includes('\n') || textWidth(text.trim().replace(/ +/g, ' ')) > width)) throw Error(`文字单行放不下：至少需要${textWidth(text.trim().replace(/\n/g, ' ').replace(/ +/g, ' '))}格宽`);
    const lines = [];
    for (const paragraph of text.split('\n')) {
      const words = paragraph.split(' ').filter(Boolean);
      if (!words.length) throw Error('文字不能包含空白行');
      let line = '';
      for (const word of words) {
        if (textWidth(word) > width) throw Error(`文字放不下：${word} 至少需要${textWidth(word)}格宽，请提高格数或明确分行`);
        const next = line ? line + ' ' + word : word;
        if (line && textWidth(next) > width) { lines.push(line); line = word; }
        else line = next;
      }
      lines.push(line);
    }
    if ((layout === 'single' && lines.length !== 1) || lines.length * 6 - 1 > height) {
      throw Error(`文字放不下：当前需要${lines.length * 6 - 1}格高，区域只有${height}格；请提高格数、扩大区域或减少文字`);
    }
    const scale = Math.min(Math.floor(width / Math.max(...lines.map(textWidth))), Math.floor(height / (lines.length * 6 - 1)));
    if (scale < 1) throw Error('文字区域不足，无法保证完整笔画');
    return { lines, scale, font: 'compact-5', width: Math.max(...lines.map(textWidth)) * scale, height: (lines.length * 6 - 1) * scale };
  }

  function composeTextLayers(input, configs) {
    const pattern = validatePattern(input), layers = validateTextLayers(configs);
    const labs = paletteRGB(pattern.palette).map(oklab);
    const match = hex => {
      const lab = oklab([1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)));
      let best = 0, distance = Infinity;
      labs.forEach((candidate, i) => { const d = colorDistance(lab, candidate); if (d < distance) { best = i; distance = d; } });
      return best;
    };
    const reports = [];
    for (const layer of layers) {
      const ink = match(layer.foreground), paper = layer.background === null ? null : match(layer.background);
      if (ink === paper || (paper !== null && colorDistance(labs[ink], labs[paper]) < .08 ** 2)) throw Error('色板中没有可区分的文字与背景颜色；请调整色板或颜色上限');
      const r = textRectangle(layer.box, pattern.width, pattern.height);
      const layout = layoutGridText(layer.text, r.w, r.h, layer.layout);
      const clear = textRectangle(layer.clear_box, pattern.width, pattern.height);
      for (const region of [clear, r]) for (let y = region.y; y < region.y + region.h; y++) for (let x = region.x; x < region.x + region.w; x++) pattern.cells[y * pattern.width + x] = paper;
      layout.lines.forEach((line, row) => {
        let x = r.x + Math.floor((r.w - textWidth(line) * layout.scale) / 2);
        const y = r.y + row * 6 * layout.scale;
        line.split(' ').forEach((word, wi) => {
          if (wi) x += 2 * layout.scale;
          Array.from(word).forEach((letter, ci) => {
            if (ci) x += layout.scale;
            GRID_FONT[letter].forEach((bits, gy) => Array.from(bits).forEach((bit, gx) => {
              if (bit !== '1') return;
              for (let dy = 0; dy < layout.scale; dy++) for (let dx = 0; dx < layout.scale; dx++) pattern.cells[(y + gy * layout.scale + dy) * pattern.width + x + gx * layout.scale + dx] = ink;
            }));
            x += GRID_FONT[letter][0].length * layout.scale;
          });
        });
      });
      reports.push({ text: layer.text, lines: layout.lines, scale: layout.scale, font: layout.font, box: r });
    }
    pattern.text_layers = layers;
    pattern.notes = [...(pattern.notes || []), ...layers.map(layer => `文字分区重排：${JSON.stringify(layer.text)}；内容已确认，使用独立点阵字，非原品牌字体。`)];
    return { pattern: validatePattern(pattern), reports };
  }

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
    if (input.text_layers !== undefined) result.text_layers = validateTextLayers(input.text_layers);
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

  function simplifyCurve(points, epsilon) {
    if (points.length < 3) return points;
    const a = points[0], b = points.at(-1), dx = b[0] - a[0], dy = b[1] - a[1];
    let maximum = 0, cut = 0;
    for (let i = 1; i < points.length - 1; i++) {
      const p = points[i];
      const t = dx || dy ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy))) : 0;
      const distance = Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
      if (distance > maximum) { maximum = distance; cut = i; }
    }
    return maximum > epsilon ? [...simplifyCurve(points.slice(0, cut + 1), epsilon).slice(0, -1), ...simplifyCurve(points.slice(cut), epsilon)] : [a, b];
  }

  function rasterLine(a, b, put) {
    let [x, y] = a;
    const [xx, yy] = b, dx = Math.abs(xx - x), dy = -Math.abs(yy - y), sx = x < xx ? 1 : -1, sy = y < yy ? 1 : -1;
    let error = dx + dy;
    for (;;) {
      put(x, y);
      if (x === xx && y === yy) break;
      const e = 2 * error;
      if (e >= dy) { error += dy; x += sx; }
      if (e <= dx) { error += dx; y += sy; }
    }
  }

  function retainFlatStrokes(cells, labels, stable, width, height, scale, rgb) {
    const w = width * scale, h = height * scale, seen = new Uint8Array(w * h), protectedInk = new Set();
    let reconstructed = 0;
    for (let start = 0; start < labels.length; start++) {
      const ink = labels[start];
      if (ink < 0 || Math.max(...rgb[ink]) > 145 || seen[start]) continue;
      const items = [start]; seen[start] = 1;
      let left = w, right = 0, top = h, bottom = 0, blank = false, border = new Map();
      for (let cursor = 0; cursor < items.length; cursor++) {
        const i = items[cursor], x = i % w, y = Math.floor(i / w);
        left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || xx >= w || yy < 0 || yy >= h) { blank = true; continue; }
          const j = yy * w + xx;
          if (labels[j] === ink) { if (!seen[j]) { seen[j] = 1; items.push(j); } }
          else if (labels[j] < 0) blank = true;
          else border.set(labels[j], (border.get(labels[j]) || 0) + 1);
        }
      }
      if (blank || items.length < 3 || items.length > scale * scale * 4 || right - left > scale * 4 || bottom - top > scale * 4 || !border.size) continue;
      // A ring enclosing another color is not an open eye/mouth stroke.
      const member = new Set(items), outside = new Set(), flood = [];
      for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
        const j = y * w + x;
        if (!member.has(j) && (x === left || x === right || y === top || y === bottom)) { outside.add(j); flood.push(j); }
      }
      for (let cursor = 0; cursor < flood.length; cursor++) {
        const j = flood[cursor], x = j % w, y = Math.floor(j / w);
        for (const [xx, yy] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
          const k = yy * w + xx;
          if (xx >= left && xx <= right && yy >= top && yy <= bottom && !member.has(k) && !outside.has(k)) { outside.add(k); flood.push(k); }
        }
      }
      if ((right - left + 1) * (bottom - top + 1) - items.length - outside.size >= 2) continue;
      // Infer the surrounding field from stable source pixels, not interpolated
      // grey/tan fringes around a dark stroke on a white face.
      const ring = new Set();
      for (const i of items) {
        const x = i % w, y = Math.floor(i / w);
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx, yy = y + dy, j = yy * w + xx;
          if (xx >= 0 && xx < w && yy >= 0 && yy < h && stable[j] && labels[j] >= 0 && labels[j] !== ink) ring.add(j);
        }
      }
      if (ring.size >= 4) { border = new Map(); for (const j of ring) border.set(labels[j], (border.get(labels[j]) || 0) + 1); }
      const sorted = Array.from(border).sort((a, b) => b[1] - a[1]), field = sorted[0][0];
      if (sorted[0][1] / Array.from(border.values()).reduce((a, b) => a + b, 0) < .8 || Math.max(...rgb[field]) < 170) continue;
      function profile(vertical) {
        const groups = new Map();
        for (const i of items) {
          const x = i % w, y = Math.floor(i / w), key = vertical ? y : x;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(vertical ? x : y);
        }
        const points = Array.from(groups).sort((a, b) => a[0] - b[0]).map(([v, group]) => vertical ? [group.reduce((a, b) => a + b, 0) / group.length, v] : [v, group.reduce((a, b) => a + b, 0) / group.length]);
        const a = points[0], b = points.at(-1);
        let score = 0;
        points.forEach((p, i) => { const t = i / Math.max(1, points.length - 1); score = Math.max(score, Math.hypot(p[0] - a[0] - (b[0] - a[0]) * t, p[1] - a[1] - (b[1] - a[1]) * t)); });
        return { points, score, vertical };
      }
      const profiles = [profile(true), profile(false)].sort((a, b) => b.score - a.score);
      let chosen = profiles[0];
      if (chosen.score < .7 || right - left > (bottom - top) * 2.2 || bottom - top > (right - left) * 2.2) chosen = profiles.find(p => p.vertical === (bottom - top > right - left));
      const path = chosen.points;
      if (path.length < 2) continue;
      let length = 0;
      for (let i = 1; i < path.length; i++) length += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
      if (items.length / Math.max(1, length) > Math.max(scale * .9, Math.max(right - left, bottom - top) * .75)) continue;
      const poly = simplifyCurve(path, Math.max(.35, Math.max(right - left, bottom - top) * .07));
      const bent = chosen.score > .6 && poly.length > 2;
      const pl = Math.min(...path.map(p => p[0])), pr = Math.max(...path.map(p => p[0])), pt = Math.min(...path.map(p => p[1])), pb = Math.max(...path.map(p => p[1]));
      let tw = Math.max(1, Math.ceil((pr - pl + 1) / scale)), th = Math.max(1, Math.ceil((pb - pt + 1) / scale));
      if (bent) { tw = Math.max(tw, chosen.vertical ? 2 : 3); th = Math.max(th, chosen.vertical ? 3 : 2); }
      if (bent && !chosen.vertical && poly.length >= 5) tw = Math.max(tw, 5);
      tw = Math.min(tw, 5); th = Math.min(th, 4);
      const cx = (left + right) / 2 / scale - .5, cy = (top + bottom) / 2 / scale - .5;
      const anchorX = Math.round(cx - (tw - 1) / 2), anchorY = Math.round(cy - (th - 1) / 2);
      const overlap = new Map();
      for (const i of items) { const cell = Math.floor(Math.floor(i / w) / scale) * width + Math.floor(i % w / scale); overlap.set(cell, (overlap.get(cell) || 0) + 1); }
      let stamp = null, best = Infinity;
      // Only bounded translations within one bead. Prefer the true fractional
      // source center; do not force a wink down into the cheek to avoid a line.
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const projected = poly.map(([x, y]) => [anchorX + dx + Math.round((x - pl) / Math.max(1, pr - pl) * (tw - 1)), anchorY + dy + Math.round((y - pt) / Math.max(1, pb - pt) * (th - 1))]);
        const candidate = new Set(); let invalid = false;
        for (let i = 1; i < projected.length; i++) rasterLine(projected[i - 1], projected[i], (x, y) => { if (x < 0 || x >= width || y < 0 || y >= height) invalid = true; else candidate.add(y * width + x); });
        let cost = invalid ? Infinity : 4 * ((anchorX + dx + (tw - 1) / 2 - cx) ** 2 + (anchorY + dy + (th - 1) / 2 - cy) ** 2);
        for (const i of candidate) {
          if (cells[i] === null || (cells[i] !== ink && cells[i] !== field)) { cost = Infinity; break; }
          if (cells[i] === ink && !overlap.has(i)) cost += 8;
          if (protectedInk.has(i)) cost += 30;
          for (const j of neighbours(i, width, height)) if (protectedInk.has(j)) cost += 10;
        }
        if (cost < best) { best = cost; stamp = candidate; }
      }
      if (!stamp || best >= 30) continue;
      for (const [cell, count] of overlap) {
        if (cells[cell] !== ink || protectedInk.has(cell)) continue;
        const x = cell % width, y = Math.floor(cell / width); let inkCount = 0;
        for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) if (labels[(y * scale + dy) * w + x * scale + dx] === ink) inkCount++;
        if (count / inkCount > .8) cells[cell] = field;
      }
      for (const i of stamp) { cells[i] = ink; protectedInk.add(i); }
      reconstructed++;
    }
    return reconstructed;
  }

  function flatCraftRGBA(rgba, detail, width, height, input = {}, inputPalette = null, maxColors = 8) {
    dimensions(width, height);
    const options = normalizeOptions(input), scale = Math.sqrt(detail.length / (width * height * 4));
    integer(maxColors, 2, 36, '自动提色数量须为 2–36 的整数');
    if (options.cleanup !== 4) return null;
    if (![3, 6].includes(scale) || rgba.length !== width * height * 4) throw Error('细节采样尺寸无效');
    const w = width * scale, h = height * scale, n = w * h, stable = new Uint8Array(n), sample = new Uint8ClampedArray(detail);
    const labCache = new Map(), labs = [];
    let solid = 0, opaque = 0;
    for (let i = 0; i < n; i++) {
      const rgb = Array.from(detail.slice(i * 4, i * 4 + 3)), key = rgb.join(',');
      if (!labCache.has(key)) labCache.set(key, oklab(rgb));
      labs.push(labCache.get(key));
    }
    for (let i = 0; i < n; i++) {
      if (detail[i * 4 + 3] < options.alpha_threshold) { sample[i * 4 + 3] = 0; continue; }
      opaque++; const x = i % w, y = Math.floor(i / w); let count = 0;
      for (const j of [x > 0 ? i - 1 : -1, x + 1 < w ? i + 1 : -1, y > 0 ? i - w : -1, y + 1 < h ? i + w : -1]) {
        if (j >= 0 && detail[j * 4 + 3] >= options.alpha_threshold && Math.hypot(...labs[i].map((v, c) => v - labs[j][c])) < .025) count++;
      }
      if (count >= 3) { stable[i] = 1; solid++; } else sample[i * 4 + 3] = 0;
    }
    if (!opaque || solid / opaque < .72) return null;
    let palette = inputPalette ? validatePalette(inputPalette) : derivePalette(sample, w, h, { ...options, background: 'transparent' }, maxColors, true);
    if (!inputPalette) {
      const groups = paletteRGB(palette).map(rgb => ({ rgb, weight: 0 }));
      const groupLabs = groups.map(g => oklab(g.rgb)), assignments = new Map();
      const nearest = lab => {
        if (!assignments.has(lab)) { let best = 0, distance = Infinity; groupLabs.forEach((g, j) => { const d = colorDistance(lab, g); if (d < distance) { best = j; distance = d; } }); assignments.set(lab, best); }
        return assignments.get(lab);
      };
      for (let i = 0; i < n; i++) if (stable[i]) groups[nearest(labs[i])].weight++;
      const tolerance = options.color_detail === 'high' ? .025 : options.color_detail === 'low' ? .05 : .04;
      for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
        const a = oklab(groups[i].rgb), b = oklab(groups[j].rgb), delta = Math.hypot(...a.map((v, c) => v - b[c]));
        if (delta >= (a[0] < .4 && b[0] < .4 ? Math.max(tolerance, .06) : tolerance)) continue;
        const count = groups[i].weight + groups[j].weight;
        groups[i].rgb = groups[i].rgb.map((v, c) => Math.round((v * groups[i].weight + groups[j].rgb[c] * groups[j].weight) / (count || 1)));
        groups[i].weight = count; groups.splice(j--, 1);
      }
      palette = groups.map((g, i) => ({ id: 'AUTO' + String(i + 1).padStart(2, '0'), hex: '#' + g.rgb.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase() }));
      if (palette.length < 2) return null;
    }
    const rgb = paletteRGB(palette), plab = rgb.map(oklab);
    if (palette.length > 8 || Math.max(...plab.map(l => l[0])) - Math.min(...plab.map(l => l[0])) < .3) return null;
    const labels = new Int16Array(n).fill(-1), cache = new Map();
    for (let i = 0; i < n; i++) {
      if (detail[i * 4 + 3] < options.alpha_threshold) continue;
      const key = labs[i];
      if (!cache.has(key)) { let best = 0, distance = Infinity; plab.forEach((p, c) => { const d = colorDistance(key, p); if (d < distance) { best = c; distance = d; } }); cache.set(key, best); }
      labels[i] = cache.get(key);
    }
    const cells = Array(width * height).fill(null);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (rgba[i * 4 + 3] < options.alpha_threshold) continue;
      const votes = Array(palette.length).fill(0);
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) { const c = labels[(y * scale + dy) * w + x * scale + dx]; if (c >= 0) votes[c]++; }
      let best = 0, score = -1;
      votes.forEach((v, c) => { const value = v * (plab[c][0] < .45 ? 1.8 : 1); if (value > score) { score = value; best = c; } });
      cells[i] = best;
    }
    const strokes = retainFlatStrokes(cells, labels, stable, width, height, scale, rgb);
    const result = new Uint8ClampedArray(rgba);
    cells.forEach((c, i) => { if (c !== null) for (let channel = 0; channel < 3; channel++) result[i * 4 + channel] = rgb[c][channel]; });
    return { rgba: result, palette, reconstructed_strokes: strokes };
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

  function derivePalette(rgba, width, height, options = {}, maxColors = 12, source = false) {
    integer(maxColors, 2, 36, '自动提色数量须为 2–36 的整数');
    const { pixels, processing } = prepareRGBA(rgba, width, height, options, source);
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
  return { normalizeOptions, validatePattern, validateTextLayers, layoutGridText, composeTextLayers, prepareRGBA, prepareSourceRGBA, extractCraftFeatures, flatCraftRGBA, sampleCraftRGBA, processRGBA, cleanCells, derivePalette, mergeSimilarColors, counts, symbol, toSVG, toCSV };
}));
