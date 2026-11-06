'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const Core = require('../assets/pattern-core.js');

const palette = [{ id: 'WHITE', hex: '#ffffff', stock: 10 }, { id: 'BLACK', hex: '#000000' }, { id: 'NEAR_WHITE', hex: '#eeeeee' }];
const pattern = (cells = Array(16).fill(0)) => ({ version: 2, title: '测试 & <图纸>', mode: 'bead', width: 4, height: 4, palette, cells });
function rgba(width, height, color = [255, 255, 255, 255]) {
  return Uint8ClampedArray.from(Array.from({ length: width * height }, () => color).flat());
}
function pixel(buffer, width, x, y, color) { buffer.set(color, (y * width + x) * 4); }

test('version 1 imports migrate without mutating the original and reject null', () => {
  const source = { ...pattern(), version: 1 };
  const normalized = Core.validatePattern(source);
  assert.equal(normalized.version, 2);
  normalized.cells[0] = 1;
  assert.equal(source.cells[0], 0);
  assert.equal(normalized.palette[0].hex, '#FFFFFF');
  assert.deepEqual(normalized.palette[0], { id: 'WHITE', hex: '#FFFFFF' });
  assert.throws(() => Core.validatePattern({ ...source, cells: [null, ...source.cells.slice(1)] }), /色号/);
});

test('null is an empty cell, distinct from color index zero in counts and exports', () => {
  const source = pattern([0, 1, null, ...Array(13).fill(null)]);
  assert.deepEqual(Core.counts(source), [1, 1, 0]);
  assert.equal(Core.validatePattern(source).metrics.bead_count, 2);
  const svg = Core.toSVG(source, true);
  assert.equal((svg.match(/fill="none"/g) || []).length, 14);
  assert.equal((svg.match(/<text /g) || []).length, 2);
  assert.match(svg, /测试 &amp; &lt;图纸&gt;/);
});

test('invalid patterns and processing options are rejected', () => {
  for (const patch of [{ version: 3 }, { width: 4.2 }, { mode: 'unknown' }, { palette: [{ id: 'x', hex: '#fff' }] }, { cells: Array(16).fill(false) }]) {
    assert.throws(() => Core.validatePattern({ ...pattern(), ...patch }));
  }
  for (const options of [{ cleanup: 5 }, { background: 'erase' }, { alpha_threshold: 0 }, { background_tolerance: 121 }]) {
    assert.throws(() => Core.normalizeOptions(options));
  }
});

test('transparent input stays empty while keep mode composites it onto white', () => {
  const pixels = rgba(4, 4, [12, 34, 56, 0]);
  assert.deepEqual(Core.processRGBA(pixels, 4, 4, palette, { cleanup: 0 }).cells, Array(16).fill(null));
  assert.deepEqual(Core.processRGBA(pixels, 4, 4, palette, { background: 'keep', cleanup: 0 }).cells, Array(16).fill(0));
  assert.equal(pixels[3], 0);
});

test('auto background removes only connected exterior and keeps enclosed white details', () => {
  const pixels = rgba(7, 7);
  for (let y = 1; y < 6; y++) for (let x = 1; x < 6; x++) pixel(pixels, 7, x, y, [0, 0, 0, 255]);
  pixel(pixels, 7, 3, 3, [255, 255, 255, 255]);
  const result = Core.processRGBA(pixels, 7, 7, palette, { background: 'auto', cleanup: 0 });
  assert.equal(result.metrics.removed_background, 24);
  assert.equal(result.metrics.blank_cells, 24);
  assert.equal(result.cells[24], 0);
  assert.equal(result.cells[8], 1);
});

test('auto background samples the opaque bounding box inside transparent padding', () => {
  const pixels = rgba(8, 6, [0, 0, 0, 0]);
  for (let y = 1; y < 5; y++) for (let x = 1; x < 7; x++) pixel(pixels, 8, x, y, [255, 255, 255, 255]);
  for (let y = 2; y < 4; y++) for (let x = 2; x < 6; x++) pixel(pixels, 8, x, y, [0, 0, 0, 255]);
  const result = Core.processRGBA(pixels, 8, 6, palette, { background: 'auto', cleanup: 0 });
  assert.equal(result.metrics.removed_background, 16);
  assert.equal(result.metrics.bead_count, 8);
});

test('cleanup removes a near-color isolated fleck but protects black eyes and outlines', () => {
  const input = Array(49).fill(0);
  input[16] = 2;
  input[32] = 1;
  input[1] = 2;
  const result = Core.cleanCells(input, 7, 7, palette, 1);
  assert.equal(result.cells[16], 0);
  assert.equal(result.cells[32], 1);
  assert.equal(result.cells[1], 2); // touches the outer edge
  assert.equal(result.cleaned, 1);
  assert.equal(input[16], 2);
});

test('cleanup never fills blanks or changes a component bordering a blank', () => {
  const input = Array(25).fill(0);
  input[12] = 2;
  input[13] = null;
  const result = Core.cleanCells(input, 5, 5, palette, 3);
  assert.equal(result.cells[12], 2);
  assert.equal(result.cells[13], null);
  assert.equal(result.cleaned, 0);
});

test('cleanup strength selects component sizes without iterative erosion', () => {
  const input = Array(49).fill(0);
  input[16] = input[17] = 2;
  assert.equal(Core.cleanCells(input, 7, 7, palette, 1).cleaned, 0);
  assert.equal(Core.cleanCells(input, 7, 7, palette, 2).cleaned, 2);
  assert.equal(Core.cleanCells(input, 7, 7, palette, 0).cleaned, 0);
});

test('craft mode consolidates small edge regions without filling blanks or changing the silhouette', () => {
  const colors = [{ id: 'SKIN', hex: '#B48E7B' }, { id: 'EDGE', hex: '#947C70' }];
  const cells = Array(49).fill(0);
  for (let y = 0; y < 7; y++) cells[y * 7] = null;
  cells[15] = cells[22] = 1;
  const result = Core.cleanCells(cells, 7, 7, colors, 4);
  assert.equal(result.cleaned, 2);
  assert.equal(result.cells[15], 0);
  assert.deepEqual(result.cells.map(c => c === null), cells.map(c => c === null));
  assert.equal(cells[15], 1);
});

test('craft mode removes grey shirt flecks but protects white accents and dark eyes', () => {
  const colors = [{ id: 'BLACK', hex: '#15191E' }, { id: 'GREY', hex: '#777777' }, { id: 'WHITE', hex: '#FFFFFF' }, { id: 'SKIN', hex: '#D2A894' }];
  const shirt = Array(49).fill(0); shirt[16] = 1; shirt[32] = 2;
  const result = Core.cleanCells(shirt, 7, 7, colors, 4);
  assert.equal(result.cells[16], 0);
  assert.equal(result.cells[32], 2);
  const face = Array(49).fill(3); face[16] = face[18] = 0;
  assert.deepEqual(Core.cleanCells(face, 7, 7, colors, 4).cells, face);
  assert.deepEqual(Core.cleanCells(shirt, 7, 7, colors, 0).cells, shirt);
});

test('source masking removes a varied grey backdrop before sampling and protects colored skin and enclosed white', () => {
  const pixels = rgba(32, 24);
  for (let y = 0; y < 24; y++) for (let x = 0; x < 32; x++) {
    const grey = 180 + (x * 7 + y * 3) % 45;
    pixel(pixels, 32, x, y, [grey, grey, grey + 2, 255]);
  }
  for (let y = 6; y < 18; y++) for (let x = 8; x < 24; x++) pixel(pixels, 32, x, y, [20, 24, 29, 255]);
  pixel(pixels, 32, 16, 10, [240, 240, 240, 255]);
  pixel(pixels, 32, 4, 8, [210, 170, 150, 255]);
  const prepared = Core.prepareSourceRGBA(pixels, 32, 24, { background: 'auto', cleanup: 4 });
  assert.equal(prepared.removed_background, 32 * 24 - 12 * 16 - 1);
  assert.equal(prepared.pixels[(10 * 32 + 16) * 4 + 3], 255);
  assert.equal(prepared.pixels[(8 * 32 + 4) * 4 + 3], 255);
  assert.equal(pixels[3], 255);
  assert.equal(Core.normalizeOptions({ cleanup: 4 }).cleanup, 4);
  assert.throws(() => Core.prepareSourceRGBA([], 1025, 4), /宽度/);
});

test('craft sampling retains a two-sample dark feature, ignores one-sample noise and leaves alpha untouched', () => {
  const base = rgba(4, 4, [210, 168, 148, 255]);
  const detail = rgba(12, 12, [210, 168, 148, 255]);
  pixel(detail, 12, 0, 0, [40, 35, 30, 255]);
  pixel(detail, 12, 1, 0, [60, 45, 35, 255]);
  pixel(detail, 12, 3, 0, [0, 0, 0, 255]); // isolated noise in the next cell
  const sampled = Core.sampleCraftRGBA(base, detail, 4, 4);
  assert.deepEqual([...sampled.slice(0, 3)], [50, 40, 33]);
  assert.deepEqual([...sampled.slice(4, 8)], [...base.slice(4, 8)]);
  assert.deepEqual([...sampled].filter((_, i) => i % 4 === 3), [...base].filter((_, i) => i % 4 === 3));
  assert.deepEqual([...base.slice(0, 3)], [210, 168, 148]);
});

test('automatic palette ignores transparent background and is deterministic', () => {
  const pixels = rgba(4, 4, [255, 255, 255, 0]);
  pixel(pixels, 4, 1, 1, [255, 0, 0, 255]);
  pixel(pixels, 4, 2, 2, [0, 0, 255, 255]);
  const colors = Core.derivePalette(pixels, 4, 4, {}, 12);
  assert.deepEqual(colors.map(color => color.hex).sort(), ['#0000FF', '#FF0000']);
  assert.deepEqual(colors, Core.derivePalette(pixels, 4, 4, {}, 12));
  assert.equal(Core.derivePalette(rgba(4, 4, [0, 0, 0, 0]), 4, 4).length, 2);
});

test('automatic palette removes solid background before sampling', () => {
  const pixels = rgba(6, 6);
  for (let y = 1; y < 5; y++) for (let x = 1; x < 5; x++) pixel(pixels, 6, x, y, [255, 0, 0, 255]);
  const colors = Core.derivePalette(pixels, 6, 6, { background: 'auto' }, 6);
  assert.equal(colors.some(color => color.hex === '#FFFFFF'), false);
  assert.equal(colors.some(color => color.hex === '#FF0000'), true);
});

test('near-black shades merge across large areas without changing blanks or bead totals', () => {
  const source = {
    ...pattern(),
    palette: [{ id: 'BLACK1', hex: '#0E1014' }, { id: 'BLACK2', hex: '#14181D' }, { id: 'BLACK3', hex: '#1D1E22' }, { id: 'RED', hex: '#EF4444' }],
    cells: [...Array(8).fill(0), ...Array(3).fill(1), ...Array(2).fill(2), 3, null, null],
  };
  const copy = JSON.stringify(source);
  const result = Core.mergeSimilarColors(source);
  assert.equal(result.merged_colors, 2);
  assert.equal(new Set(result.cells.slice(0, 13)).size, 1);
  assert.notEqual(result.cells[0], result.cells[13]);
  assert.deepEqual(result.cells.slice(14), [null, null]);
  assert.equal(Core.counts({ ...source, ...result }).reduce((a, b) => a + b), 14);
  assert.equal(JSON.stringify(source), copy);
  assert.equal(Core.validatePattern({ ...source, ...result }).palette.length, 2);
});

test('automatic extraction does not spend its color budget on almost identical blacks', () => {
  const pixels = rgba(6, 4, [20, 24, 29, 255]);
  for (let y = 0; y < 4; y++) {
    for (let x = 2; x < 4; x++) pixel(pixels, 6, x, y, [29, 30, 34, 255]);
    for (let x = 4; x < 6; x++) pixel(pixels, 6, x, y, [239, 68, 68, 255]);
  }
  const colors = Core.derivePalette(pixels, 6, 4, { cleanup: 0 }, 12);
  assert.equal(colors.length, 2);
  const result = Core.processRGBA(pixels, 6, 4, colors, { cleanup: 0 });
  assert.equal(result.cells[0], result.cells[2]);
  assert.notEqual(result.cells[0], result.cells[4]);
});

test('merging weights the representative color by bead usage and keeps strong contrasts', () => {
  const source = { ...pattern(),
    palette: [{ id: 'MAJOR', hex: '#14181D' }, { id: 'MINOR', hex: '#1D1E22' }, { id: 'LIGHT', hex: '#FFFFFF' }],
    cells: [...Array(10).fill(0), 1, ...Array(5).fill(2)],
  };
  const result = Core.mergeSimilarColors(source);
  assert.equal(result.palette[result.mapping[0]].id, 'MAJOR');
  assert.equal(result.palette[result.mapping[0]].hex, '#15191D');
  assert.notEqual(result.mapping[0], result.mapping[2]);
  const vivid = { ...pattern(), palette: [{ id: 'R', hex: '#FF0000' }, { id: 'G', hex: '#00FF00' }, { id: 'B', hex: '#0000FF' }, { id: 'K', hex: '#000000' }, { id: 'W', hex: '#FFFFFF' }] };
  assert.equal(Core.mergeSimilarColors(vivid).merged_colors, 0);
});

test('a chain of close grey steps cannot collapse a distinct gradient into one color', () => {
  const source = { ...pattern(), palette: [{ id: 'A', hex: '#202020' }, { id: 'B', hex: '#303030' }, { id: 'C', hex: '#404040' }] };
  const result = Core.mergeSimilarColors(source);
  assert.ok(new Set(result.mapping).size >= 2);
  assert.notEqual(result.mapping[0], result.mapping[2]);
});

test('practical black shades #121419 and #2B2625 share one material while occupancy and totals stay fixed', () => {
  const source = { ...pattern(),
    palette: [{ id: 'BLACK', hex: '#121419' }, { id: 'SHADOW', hex: '#2B2625' }, { id: 'GREY', hex: '#626164' }],
    cells: [...Array(8).fill(0), ...Array(3).fill(1), 2, ...Array(4).fill(null)],
  };
  const result = Core.mergeSimilarColors(source);
  assert.equal(result.mapping[0], result.mapping[1]);
  assert.notEqual(result.mapping[0], result.mapping[2]);
  assert.equal(Core.counts({ ...source, ...result })[result.mapping[0]], 11);
  assert.deepEqual(result.cells.map(c => c === null), source.cells.map(c => c === null));
  assert.notEqual(Core.mergeSimilarColors(source, 0).mapping[0], Core.mergeSimilarColors(source, 0).mapping[1]);
});

test('near-black consolidation keeps deep blue, deep red and mid-grey distinct', () => {
  const source = { ...pattern(), palette: [
    { id: 'BLACK', hex: '#121419' }, { id: 'SHADOW', hex: '#2B2625' },
    { id: 'NAVY', hex: '#052443' }, { id: 'RED', hex: '#3C0707' }, { id: 'GREY', hex: '#626164' },
  ] };
  const result = Core.mergeSimilarColors(source);
  assert.equal(result.mapping[0], result.mapping[1]);
  assert.equal(new Set([result.mapping[0], ...result.mapping.slice(2)]).size, 4);
});

test('automatic extraction also treats neutral black shadows as one used color', () => {
  const pixels = rgba(4, 4, [18, 20, 25, 255]);
  for (let y = 0; y < 4; y++) for (let x = 2; x < 4; x++) pixel(pixels, 4, x, y, [43, 38, 37, 255]);
  const colors = Core.derivePalette(pixels, 4, 4, {}, 12);
  const result = Core.processRGBA(pixels, 4, 4, colors, { cleanup: 0 });
  assert.equal(new Set(result.cells).size, 1);
  assert.equal(Core.counts({ ...result, palette: colors }).filter(n => n > 0).length, 1);
});

test('similar-distance pink accents stay separate from tan fur while nearby tan shades merge', () => {
  const source = { ...pattern(), palette: [
    { id: 'TAN', hex: '#DFA68D' }, { id: 'NEAR_TAN', hex: '#DCA388' },
    { id: 'PINK', hex: '#F39AAD' }, { id: 'WHITE', hex: '#FFFFFF' },
  ], cells: [...Array(5).fill(0), ...Array(3).fill(1), ...Array(4).fill(2), ...Array(4).fill(3)] };
  const result = Core.mergeSimilarColors(source);
  assert.equal(result.mapping[0], result.mapping[1]);
  assert.notEqual(result.mapping[0], result.mapping[2]);
  const pixels = rgba(4, 4, [223, 166, 141, 255]);
  for (let y = 0; y < 4; y++) for (let x = 2; x < 4; x++) pixel(pixels, 4, x, y, [243, 154, 173, 255]);
  const colors = Core.derivePalette(pixels, 4, 4, {}, 8);
  assert.equal(colors.length, 2);
  const converted = Core.processRGBA(pixels, 4, 4, colors, { cleanup: 0 });
  assert.notEqual(converted.cells[0], converted.cells[2]);
});

test('a small pink accent survives an eight-color budget dominated by varied tan pixels', () => {
  const pixels = rgba(24, 24);
  for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) pixel(pixels, 24, x, y, [215 + x % 8, 160 + y % 8, 135 + (x + y) % 8, 255]);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) pixel(pixels, 24, x, y, [255, 255, 255, 255]);
  for (let y = 12; y < 14; y++) for (let x = 12; x < 14; x++) pixel(pixels, 24, x, y, [243, 154, 173, 255]);
  const colors = Core.derivePalette(pixels, 24, 24, {}, 8);
  assert.ok(colors.length <= 8);
  const result = Core.processRGBA(pixels, 24, 24, colors, { cleanup: 4 });
  const hex = colors[result.cells[12 * 24 + 12]].hex;
  assert.ok(parseInt(hex.slice(5, 7), 16) - parseInt(hex.slice(3, 5), 16) >= 10);
  assert.notEqual(result.cells[12 * 24 + 12], result.cells[20 * 24 + 20]);
});

test('color distinction levels produce progressively finer grey layers at the same color budget', () => {
  const shades = ['#979797', '#ACACAC', '#C0C0C0', '#E0E0E0'];
  const pixels = Uint8ClampedArray.from(Array.from({ length: 16 }, (_, i) => [...shades[i % 4].slice(1).match(/../g).map(v => parseInt(v, 16)), 255]).flat());
  const used = [];
  for (const color_detail of ['low', 'medium', 'high']) {
    const options = { color_detail, cleanup: 0 };
    const colors = Core.derivePalette(pixels, 4, 4, options, 8);
    const result = Core.processRGBA(pixels, 4, 4, colors, options);
    used.push(new Set(result.cells).size);
    assert.equal(result.processing.color_detail, color_detail);
    assert.equal(result.metrics.bead_count, 16);
  }
  assert.deepEqual(used, [2, 3, 4]);
});

test('saved color distinction controls explicit merging and high can retain dark shading', () => {
  const source = { ...pattern(), palette: [{ id: 'BLACK', hex: '#121419' }, { id: 'SHADE', hex: '#2B2625' }, { id: 'PINK', hex: '#F39AAD' }],
    cells: [...Array(8).fill(0), ...Array(4).fill(1), 2, null, null, null], processing: { color_detail: 'low' } };
  assert.equal(Core.mergeSimilarColors(source).mapping[0], Core.mergeSimilarColors(source).mapping[1]);
  const high = Core.mergeSimilarColors(source, null, 'high');
  assert.notEqual(high.mapping[0], high.mapping[1]);
  assert.deepEqual(high.cells.map(c => c === null), source.cells.map(c => c === null));
  assert.equal(Core.validatePattern(JSON.parse(JSON.stringify(source))).processing.color_detail, 'low');
  assert.equal(Core.normalizeOptions({}).color_detail, 'medium');
  for (const color_detail of ['unknown', '', null, ['medium'], 1]) assert.throws(() => Core.normalizeOptions({ color_detail }), /区分度/);
});

test('a single merged color remains a valid exportable pattern and does not repeatedly merge', () => {
  const source = { ...pattern(), palette: [{ id: 'SPARE', hex: '#14181D' }, { id: 'OTHER', hex: '#1D1E22' }] };
  const result = Core.mergeSimilarColors(source);
  const merged = Core.validatePattern({ ...source, ...result });
  assert.equal(new Set(merged.cells).size, 1);
  assert.equal(merged.palette.length, 2);
  assert.equal(new Set(merged.palette.map(color => color.id)).size, 2);
  assert.equal(Core.mergeSimilarColors(merged).merged_colors, 0);
  assert.match(Core.toCSV(merged), /16/);
  assert.throws(() => Core.mergeSimilarColors(source, NaN), /容差/);
});

test('CSV includes a real BOM and line breaks, quotes IDs and neutralizes formulas', () => {
  const source = { ...pattern(), palette: [{ id: '=HYPERLINK("bad")', hex: '#ffffff' }, { id: ' a,b\n"c"', hex: '#000000', stock: 0 }] };
  source.cells[1] = 1;
  const csv = Core.toCSV(source);
  assert.equal(csv.charCodeAt(0), 0xFEFF);
  assert.equal(csv.split('\r\n')[0], '\uFEFF符号,色号,颜色,数量');
  assert.match(csv, /\r\n/);
  assert.equal(csv.includes('\\n'), false);
  assert.match(csv, /"'=HYPERLINK\(""bad""\)"/);
  assert.match(csv, /" a,b\n""c"""/);
});

test('all 36 colors have distinct single-character symbols', () => {
  const symbols = Array.from({ length: 36 }, (_, index) => Core.symbol(index));
  assert.equal(new Set(symbols).size, 36);
  assert.equal(symbols.every(value => value.length === 1), true);
  assert.equal(symbols[35], '0');
});
