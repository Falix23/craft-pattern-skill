'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const Core = require('../assets/pattern-core.js');
const { generate } = require('../scripts/generate.cjs');

const spec = { text: 'BILIBILI GAMING', box: [0, .65, 1, .35], foreground: '#2ACDEB', background: '#FFFFFF' };
function fixture(size) {
  const cells = Array(size * size).fill(0);
  for (let y = 2; y < Math.round(size * .65); y++) for (let x = 3; x < size - 3; x++) cells[y * size + x] = 1;
  return { version: 2, width: size, height: size, title: 'logo',
    palette: [{ id: 'paper', hex: '#FFFFFF' }, { id: 'blue', hex: '#2ACDEB' }], cells };
}

test('confirmed lettering fits a full single line at 48/64, wraps words at 32, and rejects impossible budgets', () => {
  for (const n of [48, 64]) {
    const layout = Core.layoutGridText(spec.text, n, Math.round(n * .35));
    assert.deepEqual(layout.lines, ['BILIBILI GAMING']);
    assert.equal(layout.width, 48);
    assert.equal(layout.height, 5);
  }
  assert.deepEqual(Core.layoutGridText(spec.text, 32, 11).lines, ['BILIBILI', 'GAMING']);
  assert.throws(() => Core.layoutGridText(spec.text, 32, 10), /11格高/);
  assert.throws(() => Core.layoutGridText(spec.text, 32, 11, 'single'), /48格宽/);
  assert.throws(() => Core.layoutGridText('BILIBILI', 22, 5), /23格宽/);
  assert.throws(() => Core.layoutGridText('中文', 64, 16), /确认/);
});

test('letter regions preserve the entire graphic outside the reserved strip and do not add colors', () => {
  for (const n of [32, 48, 64]) {
    const source = fixture(n), before = structuredClone(source);
    const { pattern, reports } = Core.composeTextLayers(source, [spec]);
    const y = Math.round(n * .65);
    assert.deepEqual(pattern.cells.slice(0, y * n), source.cells.slice(0, y * n));
    assert.deepEqual(pattern.palette, before.palette);
    assert.deepEqual(source, before);
    assert.equal(pattern.width, n);
    assert.equal(pattern.height, n);
    assert.equal(reports[0].lines.length, n === 32 ? 2 : 1);
    const baseline = y * n;
    const x = n === 32 ? 4 : n === 48 ? 0 : 8;
    // Independent expected B glyph and the full empty separator column.
    assert.deepEqual([0, 1, 2, 3, 4].map(dy => pattern.cells.slice(baseline + dy * n + x, baseline + dy * n + x + 4)),
      [[1, 1, 0, 0], [1, 0, 1, 0], [1, 1, 0, 0], [1, 0, 1, 0], [1, 1, 0, 0]]);
    assert.equal(Core.counts(pattern).reduce((a, b) => a + b), n * n);
    assert.deepEqual(Core.validatePattern(JSON.parse(JSON.stringify(pattern))).text_layers[0].text, spec.text);
  }
});

test('transparent lettering has real blank cells and survives exports with exact material counts', () => {
  const result = Core.composeTextLayers(fixture(64), [{ ...spec, background: null }]).pattern;
  assert.ok(result.metrics.blank_cells > 0);
  assert.equal(result.metrics.bead_count, Core.counts(result).reduce((a, b) => a + b));
  assert.match(Core.toSVG(result), /fill="none"/);
  const csv = Core.toCSV(result).trim().split('\r\n').slice(1);
  assert.equal(csv.reduce((sum, row) => sum + Number(row.split(',').at(-1)), 0), result.metrics.bead_count);
});

test('invalid, overlapping, uncertain or low-contrast lettering cannot silently garble a pattern', () => {
  for (const bad of [{ text: 'BLG中文' }, { text: 'blg' }, { text: '   ' }, { box: [-.1, 0, 1, 1] },
    { box: [0, 0, Infinity, .2] }, { box: [0, .9, 1, .2] }, { clear_box: null }, { foreground: null }, { layout: null }, { unknown: true }]) {
    assert.throws(() => Core.validateTextLayers([{ ...spec, ...bad }]));
  }
  assert.throws(() => Core.validateTextLayers([spec, spec]), /重叠/);
  assert.throws(() => Core.composeTextLayers(fixture(64), [{ ...spec, foreground: '#FFFFFF' }]), /可区分/);
});

test('headless exports compose lettering after cleanup and keep the sampled graphic byte-for-byte', () => {
  const width = 64, height = 64;
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) rgba.set(i % width < 20 ? [42, 205, 235, 255] : [255, 255, 255, 255], i * 4);
  const req = { width, height, options: { background: 'keep', cleanup: 4 }, rgba: rgba.toString('base64') };
  const base = generate(req), out = generate({ ...req, text_layers: [spec] });
  assert.throws(() => generate({ ...req, text_layers: {} }), /数组/);
  assert.deepEqual(out.pattern.cells.slice(0, 42 * 64), base.pattern.cells.slice(0, 42 * 64));
  assert.deepEqual(out.pattern.palette, base.pattern.palette);
  assert.deepEqual(out.lettering[0].lines, ['BILIBILI GAMING']);
  assert.match(out.pattern.notes.join(' '), /非原品牌字体/);
  assert.equal(Number(out.csv.trim().split('\r\n').slice(1).reduce((n, line) => n + Number(line.split(',').at(-1)), 0)), out.pattern.metrics.bead_count);
});
