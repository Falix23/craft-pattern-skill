#!/usr/bin/env node
/* Headless adapter: use the editor's actual quantization, cleanup and exports. */
'use strict';
const fs = require('node:fs');
const core = require('../assets/pattern-core.js');

function generate(request) {
  const { width, height } = request;
  if (![width, height].every(n => Number.isInteger(n) && n >= 4 && n <= 160)) throw Error('宽高须为 4–160 的整数');
  const options = core.normalizeOptions(request.options);
  const textLayers = request.text_layers === undefined ? [] : core.validateTextLayers(request.text_layers);
  let rgba = Buffer.from(request.rgba, 'base64');
  if (rgba.length !== width * height * 4) throw Error('采样像素数量无效');
  const sampling = request.background_masked ? { ...options, background: 'transparent' } : options;
  const limit = request.max_colors ?? 8;
  if (!Number.isInteger(limit) || limit < 2 || limit > 36) throw Error('颜色上限须为 2–36 的整数');
  const detail = request.detail ? Buffer.from(request.detail, 'base64') : null;
  const flat = detail ? core.flatCraftRGBA(rgba, detail, width, height, sampling, request.palette, limit) : null;
  if (flat) rgba = flat.rgba;
  else if (detail) rgba = core.sampleCraftRGBA(rgba, detail, width, height, options.alpha_threshold);
  const palette = flat?.palette ?? request.palette ?? core.derivePalette(rgba, width, height, sampling, limit);
  const result = core.processRGBA(rgba, width, height, palette, sampling);
  result.processing = options;
  result.metrics.removed_background += request.source_removed || 0;
  let pattern = core.validatePattern({ version: 2, title: request.title, mode: request.mode || 'bead',
    width, height, palette, ...result, source: request.source,
    notes: [request.palette ? '按用户提供的色板映射；屏幕色与实物材料可能有差异。' : '自动配色为通用 RGB 参考，不是品牌官方色号。',
      ...(flat ? ['纯色区域采样；短线按源图弯折重建，局部可在一格范围内调整。'] : []),
      '格子图不是实物尺寸模板；请检查轮廓与关键细节。'] });
  let lettering;
  if (textLayers.length) {
    const composed = core.composeTextLayers(pattern, textLayers);
    pattern = composed.pattern;
    lettering = composed.reports;
  }
  return { pattern, svg: core.toSVG(pattern, true), csv: core.toCSV(pattern), ...(lettering ? { lettering } : {}) };
}

if (require.main === module) {
  try { process.stdout.write(JSON.stringify(generate(JSON.parse(fs.readFileSync(0, 'utf8'))))); }
  catch (error) { process.stderr.write((error.message || '生成失败') + '\n'); process.exitCode = 2; }
}
module.exports = { generate };
