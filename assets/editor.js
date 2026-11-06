/* Offline UI. PatternCore owns data validation, quantization and export. */
(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const core = PatternCore;
  let data = core.validatePattern(JSON.parse($('#initial').textContent));
  const canvas = $('#grid');
  const context = canvas.getContext('2d');
  const preview = $('#source-preview');
  let sourceImage = new Image();
  sourceImage.src = preview.getAttribute('src');
  let sourceName = data.source?.name || '原图';
  let sourceAvailable = Boolean(preview.getAttribute('src'));
  let patternSourceImage = sourceImage;
  let patternSourceAvailable = sourceAvailable;
  let brush = 0;
  let highlightedColor = null;
  let erasing = false;
  let showSymbols = false;
  let painting = false;
  let lastPoint = null;
  let undoStack = [];
  let redoStack = [];
  let beforeCleanup = null;
  let comparing = false;
  let dirty = false;
  let pendingImage = false;
  let generation = 0;
  let keyboardPoint = { x: 0, y: 0 };
  let renderPending = false;
  let contentRevision = 0;
  let documentId = 1;
  let libraryUI;

  function notify(message, error = false) {
    $('#message').textContent = message;
    $('#message').classList.toggle('error', error);
  }

  function syncSettings() {
    $('#width').value = data.width;
    $('#height').value = data.height;
    $('#fit').value = data.source?.fit || 'contain';
    const processing = core.normalizeOptions(data.processing || {});
    $('#background').value = processing.background;
    $('#tolerance').value = processing.background_tolerance;
    $('#cleanup').value = processing.cleanup;
    $('#color-detail').value = processing.color_detail;
    $('#palette-mode').value = 'current';
    updateOptionHelp();
    updateResolution();
  }

  function updateOptionHelp() {
    const mode = $('#background').value;
    $('#background-help').textContent = {
      auto: '去除与外围连通的近色背景及浅灰阴影，保留封闭细节。主体与背景接近时降低容差；复杂背景请先抠图。',
      transparent: '透明像素和等比留边为空格，图片中的实色背景保留。',
      keep: '透明部分与留边以白色铺底，整幅矩形图案都使用豆子。',
    }[mode];
    $('#tolerance-label').hidden = mode !== 'auto';
    $('#tolerance-value').textContent = $('#tolerance').value;
    $('#color-limit-label').hidden = $('#palette-mode').value !== 'auto';
    $('#color-limit-value').textContent = $('#color-limit').value;
    $('#color-detail-help').textContent = {
      low: '优先合并相近色，用色更少、色块更整齐。',
      medium: '平衡用色数量与图案层次，适合大多数图案。',
      high: '保留更多细微色差和明暗层次，可能需要更多材料颜色。',
    }[$('#color-detail').value] + ' 点击“生成图纸”应用；“最多颜色”仍是数量上限。';
  }

  function contrast(hex) {
    const rgb = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
    return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722 > 140 ? '#23362a' : '#fff';
  }

  function markEdited() {
    contentRevision++;
    dirty = true;
    beforeCleanup = null;
    comparing = false;
    $('#compare').disabled = true;
    $('#save-state').textContent = '有修改 · 请保存图纸';
  }

  function updateHistoryButtons() {
    $('#undo').disabled = undoStack.length === 0;
    $('#redo').disabled = redoStack.length === 0;
  }

  function editState() {
    return { cells: data.cells.slice(), palette: data.palette.map(color => ({ ...color })), processing: data.processing ? { ...data.processing } : undefined, brush, highlightedColor };
  }

  function restoreEdit(state) {
    data.cells = state.cells; data.palette = state.palette;
    if (state.processing) data.processing = state.processing;
    else delete data.processing;
    brush = state.brush; highlightedColor = state.highlightedColor;
  }

  function snapshot() {
    undoStack.push(editState());
    if (undoStack.length > 30) undoStack.shift();
    redoStack = [];
    updateHistoryButtons();
  }

  function renderPalette() {
    const usage = core.counts(data);
    const total = usage.reduce((sum, count) => sum + count, 0);
    data.metrics = { ...data.metrics, blank_cells: data.cells.length - total, bead_count: total };
    $('#size-stat').textContent = `${data.width} × ${data.height}`;
    $('#bead-stat').textContent = total.toLocaleString() + ' 颗';
    $('#blank-stat').textContent = (data.cells.length - total).toLocaleString();
    $('#color-stat').textContent = usage.filter(count => count > 0).length + ' 色';
    $('#title').textContent = data.title || '我的拼豆图纸';
    $('#mode-badge').textContent = data.mode === 'cross-stitch' ? '十字绣图纸' : '拼豆图纸';
    const fragment = document.createDocumentFragment();
    data.palette.forEach((color, index) => {
      const row = document.createElement('div');
      row.className = 'swatch-row';
      const button = document.createElement('button');
      button.className = 'swatch' + (!erasing && brush === index ? ' active' : '');
      button.setAttribute('aria-label', `${color.id}，${usage[index]} 颗`);
      button.setAttribute('aria-pressed', String(!erasing && brush === index));
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.backgroundColor = color.hex;
      dot.style.color = contrast(color.hex);
      dot.textContent = core.symbol(index);
      const label = document.createElement('span');
      label.className = 'swatch-label';
      const name = document.createElement('strong');
      name.textContent = color.id;
      const detail = document.createElement('small');
      detail.textContent = color.hex;
      label.append(name, detail);
      const count = document.createElement('span');
      count.className = 'swatch-count';
      count.textContent = `${usage[index]} 颗`;
      button.append(dot, label, count);
      button.onclick = () => { brush = index; highlightedColor = index; setTool(false); };
      const edit = document.createElement('button');
      edit.className = 'swatch-edit';
      edit.textContent = '调色';
      edit.setAttribute('aria-label', `修改 ${color.id} 的颜色`);
      edit.onclick = () => openColorEditor(index);
      row.append(button, edit);
      fragment.append(row);
    });
    $('#palette').replaceChildren(fragment);
    $('#merge-colors').disabled = core.mergeSimilarColors(data, null, $('#color-detail').value).merged_colors === 0;
  }

  $('#merge-colors').onclick = () => {
    const result = core.mergeSimilarColors(data, null, $('#color-detail').value);
    if (!result.merged_colors) return;
    snapshot();
    data.palette = result.palette; data.cells = result.cells;
    data.processing = { ...core.normalizeOptions(data.processing || {}), color_detail: $('#color-detail').value };
    brush = result.mapping[brush];
    if (highlightedColor !== null) highlightedColor = result.mapping[highlightedColor];
    markEdited();
    $('#palette-mode').value = 'current'; updateOptionHelp();
    render();
    notify(`已合并 ${result.merged_colors} 种近似色，用豆总数与留空不变；可撤销或保存为新版本。`);
  };
  $('#clear-highlight').onclick = () => { highlightedColor = null; draw(); };
  $('#color-detail').onchange = () => {
    // Re-sample the original to recover distinctions already merged away.
    if (sourceAvailable) $('#palette-mode').value = 'auto';
    updateOptionHelp(); renderPalette();
    $('#settings-message').textContent = sourceAvailable
      ? '颜色区分度已调整，点击生成图纸按原图重新提色。'
      : '当前无原图，可点“合并近似色”；恢复更多层次需要重新选择原图。';
  };

  let editingColor = null;
  function setColorDraft(hex) {
    $('#color-picker').value = hex;
    $('#color-hex').value = hex.toUpperCase();
    $('#color-hex').setCustomValidity('');
    $('#color-new').style.backgroundColor = hex;
  }

  function openColorEditor(index) {
    editingColor = index;
    const color = data.palette[index];
    $('#color-dialog-title').textContent = `调色 · ${color.id}`;
    $('#color-usage').textContent = `将替换图纸中此色号的 ${core.counts(data)[index]} 颗豆子，格子位置和数量保持不变。`;
    $('#color-old').style.backgroundColor = color.hex;
    setColorDraft(color.hex);
    $('#color-dialog').showModal();
  }

  const quickColors = ['#FFFFFF', '#D1D5DB', '#6B7280', '#111827', '#EF4444', '#F97316', '#FACC15', '#84CC16', '#22C55E', '#14B8A6', '#38BDF8', '#2563EB', '#8B5CF6', '#D946EF', '#F472B6', '#92400E'];
  quickColors.forEach(hex => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'quick-color';
    button.style.backgroundColor = hex;
    button.title = hex; button.setAttribute('aria-label', `选择颜色 ${hex}`);
    button.onclick = () => setColorDraft(hex);
    $('#quick-colors').append(button);
  });
  $('#color-picker').oninput = () => setColorDraft($('#color-picker').value);
  $('#color-hex').oninput = () => {
    const hex = $('#color-hex').value.trim();
    const valid = /^#[0-9a-f]{6}$/i.test(hex);
    $('#color-hex').setCustomValidity(valid ? '' : '请输入 #RRGGBB 格式的颜色。');
    if (valid) { $('#color-picker').value = hex; $('#color-new').style.backgroundColor = hex; }
  };
  $('#cancel-color').onclick = () => $('#color-dialog').close();
  $('#color-dialog').onclose = () => { editingColor = null; };
  $('#color-form').onsubmit = event => {
    event.preventDefault();
    const hex = $('#color-hex').value.trim().toUpperCase();
    if (editingColor === null || !/^#[0-9A-F]{6}$/.test(hex)) return;
    const color = data.palette[editingColor];
    if (color.hex.toUpperCase() !== hex) {
      snapshot();
      color.hex = hex;
      markEdited();
      // A later resolution change should keep the user's chosen colors.
      $('#palette-mode').value = 'current'; updateOptionHelp();
      render();
      notify(`已将 ${color.id} 改为 ${hex}；可撤销，或保存为案例新版本。`);
    }
    $('#color-dialog').close();
  };

  function draw() {
    const n = Number($('#zoom').value);
    canvas.width = data.width * n;
    canvas.height = data.height * n;
    canvas.style.backgroundSize = `${n * 2}px ${n * 2}px`;
    canvas.style.backgroundPosition = `0 0,0 ${n}px,${n}px -${n}px,-${n}px 0`;
    const cells = comparing && beforeCleanup ? beforeCleanup : data.cells;
    for (let i = 0; i < cells.length; i++) {
      const value = cells[i];
      const x = i % data.width;
      const y = Math.floor(i / data.width);
      if (value !== null) {
        const hex = data.palette[value].hex;
        context.fillStyle = hex;
        context.fillRect(x * n, y * n, n, n);
        if (showSymbols) {
          context.fillStyle = contrast(hex);
          context.font = `${Math.max(7, n * .63)}px monospace`;
          context.textAlign = 'center';
          context.textBaseline = 'middle';
          context.fillText(core.symbol(value), (x + .5) * n, (y + .53) * n);
        }
      }
    }
    context.lineWidth = .5;
    for (let x = 0; x <= data.width; x++) {
      context.strokeStyle = x % 10 === 0 ? '#3d514047' : '#3d51401b';
      context.beginPath(); context.moveTo(x * n + .25, 0); context.lineTo(x * n + .25, canvas.height); context.stroke();
    }
    for (let y = 0; y <= data.height; y++) {
      context.strokeStyle = y % 10 === 0 ? '#3d514047' : '#3d51401b';
      context.beginPath(); context.moveTo(0, y * n + .25); context.lineTo(canvas.width, y * n + .25); context.stroke();
    }
    let highlighted = 0;
    if (highlightedColor !== null) {
      context.beginPath();
      cells.forEach((value, index) => {
        if (value !== highlightedColor) return;
        highlighted++;
        // Trace only the boundary of the selected color, leaving internal
        // shared edges untouched so connected cells form one outlined region.
        const x = index % data.width, y = Math.floor(index / data.width);
        const left = x * n + .5, top = y * n + .5;
        const right = Math.min(canvas.width - .5, (x + 1) * n + .5);
        const bottom = Math.min(canvas.height - .5, (y + 1) * n + .5);
        if (y === 0 || cells[index - data.width] !== value) { context.moveTo(left, top); context.lineTo(right, top); }
        if (x === data.width - 1 || cells[index + 1] !== value) { context.moveTo(right, top); context.lineTo(right, bottom); }
        if (y === data.height - 1 || cells[index + data.width] !== value) { context.moveTo(right, bottom); context.lineTo(left, bottom); }
        if (x === 0 || cells[index - 1] !== value) { context.moveTo(left, bottom); context.lineTo(left, top); }
      });
      // A one-pixel vivid line with a fine light halo stays visible on both
      // dark and bright beads, without covering their fill or symbols.
      context.strokeStyle = '#FFFFFF'; context.lineWidth = 1.5; context.stroke();
      context.strokeStyle = '#E6007E'; context.lineWidth = 1; context.stroke();
    }
    const selection = highlightedColor === null ? '' : `已标出 ${data.palette[highlightedColor].id} · ${highlighted} 格`;
    $('#highlight-info').textContent = selection;
    $('#highlight-bar').hidden = highlightedColor === null;
    canvas.setAttribute('aria-label', `可编辑拼豆图纸，${data.width} 乘 ${data.height} 格。${selection ? selection + '。' : ''}方向键移动，空格键绘制。`);
  }

  function render() { draw(); renderPalette(); updateHistoryButtons(); }
  function fitZoom() {
    const available = $('#viewport').clientWidth - 50;
    $('#zoom').value = Math.max(6, Math.min(22, Math.floor(available / data.width)));
  }
  function queueRender() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(() => { renderPending = false; render(); });
  }

  function setTool(erase) {
    erasing = erase;
    if (erase) highlightedColor = null;
    $('#brush').classList.toggle('active', !erase);
    $('#eraser').classList.toggle('active', erase);
    $('#brush').setAttribute('aria-pressed', String(!erase));
    $('#eraser').setAttribute('aria-pressed', String(erase));
    render();
  }

  function eventPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: Math.floor((event.clientX - rect.left) / rect.width * data.width), y: Math.floor((event.clientY - rect.top) / rect.height * data.height) };
  }

  function paintPoint(point) {
    if (point.x < 0 || point.y < 0 || point.x >= data.width || point.y >= data.height) return;
    const index = point.y * data.width + point.x;
    const value = erasing ? null : brush;
    if (data.cells[index] !== value) { data.cells[index] = value; markEdited(); }
  }

  function paintLine(from, to) {
    // Interpolate fast pointer movements so a drag does not skip cells.
    const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
    for (let i = 0; i <= steps; i++) {
      const fraction = steps === 0 ? 0 : i / steps;
      paintPoint({ x: Math.round(from.x + (to.x - from.x) * fraction), y: Math.round(from.y + (to.y - from.y) * fraction) });
    }
    queueRender();
  }

  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    canvas.focus({ preventScroll: true });
    snapshot();
    painting = true;
    lastPoint = eventPoint(event);
    keyboardPoint = lastPoint;
    canvas.setPointerCapture(event.pointerId);
    paintLine(lastPoint, lastPoint);
  });
  canvas.addEventListener('pointermove', event => {
    const point = eventPoint(event);
    if (point.x >= 0 && point.x < data.width && point.y >= 0 && point.y < data.height) $('#cursor-info').textContent = `第 ${point.y + 1} 行 · 第 ${point.x + 1} 列`;
    if (painting && lastPoint) { paintLine(lastPoint, point); lastPoint = point; }
  });
  const endStroke = () => { painting = false; lastPoint = null; };
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);
  canvas.addEventListener('keydown', event => {
    const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (moves[event.key]) {
      event.preventDefault();
      const [dx, dy] = moves[event.key];
      keyboardPoint = { x: Math.max(0, Math.min(data.width - 1, keyboardPoint.x + dx)), y: Math.max(0, Math.min(data.height - 1, keyboardPoint.y + dy)) };
      $('#cursor-info').textContent = `第 ${keyboardPoint.y + 1} 行 · 第 ${keyboardPoint.x + 1} 列（空格键绘制）`;
    } else if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault(); snapshot(); paintPoint(keyboardPoint); render();
    }
  });
  $('#brush').onclick = () => setTool(false);
  $('#eraser').onclick = () => setTool(true);
  $('#undo').onclick = () => {
    if (!undoStack.length) return;
    redoStack.push(editState()); restoreEdit(undoStack.pop()); markEdited(); render();
  };
  $('#redo').onclick = () => {
    if (!redoStack.length) return;
    undoStack.push(editState()); restoreEdit(redoStack.pop()); markEdited(); render();
  };
  $('#zoom').oninput = draw;
  $('#symbols').onclick = () => {
    showSymbols = !showSymbols;
    $('#symbols').setAttribute('aria-pressed', String(showSymbols));
    $('#symbols').classList.toggle('active', showSymbols);
    draw();
  };
  const finishCompare = () => { if (comparing) { comparing = false; draw(); } };
  $('#compare').onpointerdown = event => {
    if (!beforeCleanup) return;
    event.preventDefault(); comparing = true; $('#compare').setPointerCapture(event.pointerId); draw();
  };
  $('#compare').onpointerup = finishCompare;
  $('#compare').onpointercancel = finishCompare;
  $('#compare').onkeydown = event => { if ((event.key === ' ' || event.key === 'Enter') && beforeCleanup) { event.preventDefault(); comparing = true; draw(); } };
  $('#compare').onkeyup = finishCompare;
  $('#compare').onblur = finishCompare;

  function fitDimensions(axis) {
    if (!$('#lock-ratio').checked || !sourceAvailable || !sourceImage.naturalWidth) return;
    const ratio = sourceImage.naturalWidth / sourceImage.naturalHeight;
    const value = Number($('#' + axis).value);
    if (!Number.isInteger(value) || value < 4 || value > 160) return;
    let w = axis === 'width' ? value : Math.round(value * ratio);
    let h = axis === 'height' ? value : Math.round(value / ratio);
    if (w > 160) { h = Math.max(4, Math.round(h * 160 / w)); w = 160; }
    if (h > 160) { w = Math.max(4, Math.round(w * 160 / h)); h = 160; }
    $('#width').value = Math.max(4, w); $('#height').value = Math.max(4, h);
  }

  function updateResolution() {
    const width = Number($('#width').value), height = Number($('#height').value);
    if (![width, height].every(value => Number.isInteger(value) && value >= 4 && value <= 160)) {
      $('#resolution-summary').textContent = '请输入 4–160 之间的整数格数。';
      return;
    }
    const edge = Math.max(width, height);
    $('#resolution').value = edge;
    $('#resolution-value').textContent = edge;
    const pending = pendingImage || width !== data.width || height !== data.height;
    $('#resolution-summary').textContent = `${pending ? '待生成' : '当前'}：${width} × ${height} = ${(width * height).toLocaleString()} 个格位`;
    document.querySelectorAll('[data-resolution]').forEach(button => {
      button.classList.toggle('active', Number(button.dataset.resolution) === edge);
      button.setAttribute('aria-pressed', String(Number(button.dataset.resolution) === edge));
    });
  }

  function setResolution(edge) {
    const useOriginal = $('#lock-ratio').checked && sourceAvailable && sourceImage.naturalWidth;
    const width = useOriginal ? sourceImage.naturalWidth : Number($('#width').value) || data.width;
    const height = useOriginal ? sourceImage.naturalHeight : Number($('#height').value) || data.height;
    const scale = edge / Math.max(width, height);
    $('#width').value = Math.max(4, Math.min(160, Math.round(width * scale)));
    $('#height').value = Math.max(4, Math.min(160, Math.round(height * scale)));
    updateResolution();
    $('#settings-message').textContent = '分辨率已调整，点击生成图纸应用。';
  }

  $('#resolution').oninput = () => setResolution(Number($('#resolution').value));
  document.querySelectorAll('[data-resolution]').forEach(button => {
    button.onclick = () => setResolution(Number(button.dataset.resolution));
  });
  for (const axis of ['width', 'height']) $('#' + axis).onchange = () => {
    fitDimensions(axis);
    updateResolution();
  };

  $('#settings').addEventListener('input', event => {
    updateResolution();
    updateOptionHelp();
    $('#settings-message').textContent = '设置已调整，点击生成图纸应用。';
  });
  $('#lock-ratio').onchange = () => { fitDimensions('width'); updateResolution(); };

  async function loadImage(file) {
    if (!file) return;
    const accepted = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'];
    if (!accepted.includes(file.type)) throw Error('请选择 PNG、JPEG、WebP、GIF 或 AVIF 图片。');
    if (file.size > 20 * 1024 * 1024) throw Error('图片不能超过 20 MB。');
    const token = ++generation;
    $('#generate').disabled = true;
    let image;
    try {
      image = await createImageBitmap(file);
      if (image.width * image.height > 40_000_000) throw Error('图片不能超过 4000 万像素。');
      if (token !== generation) return;
      // createImageBitmap decodes a static first frame and honors EXIF orientation.
      const copy = document.createElement('canvas');
      const scale = Math.min(1, 1024 / Math.max(image.width, image.height));
      copy.width = Math.max(1, Math.round(image.width * scale));
      copy.height = Math.max(1, Math.round(image.height * scale));
      copy.getContext('2d').drawImage(image, 0, 0, copy.width, copy.height);
      const pixels = copy.getContext('2d').getImageData(0, 0, copy.width, copy.height).data;
      let hasTransparency = false;
      for (let offset = 3; offset < pixels.length; offset += 4) {
        if (pixels[offset] < 128) { hasTransparency = true; break; }
      }
      // Decode independently: changing preview.src before commit would let an
      // overlapping generate operation read a new image with old metadata.
      const thumbnail = new Image();
      thumbnail.src = copy.toDataURL('image/png');
      await thumbnail.decode();
      if (token !== generation) return;
      sourceImage = thumbnail;
      preview.src = thumbnail.src;
      preview.hidden = false;
      sourceName = file.name;
      sourceAvailable = true;
      pendingImage = true;
      $('#source-name').textContent = sourceName;
      $('#generate').disabled = false;
      $('#palette-mode').value = 'auto';
      $('#cleanup').value = '4';
      $('#background').value = hasTransparency ? 'transparent' : 'auto';
      fitDimensions('width');
      updateResolution();
      updateOptionHelp();
      $('#settings-message').textContent = '图片已载入，正在按原图提色生成…';
      await generatePattern();
    } finally {
      if (image) image.close();
      if (token === generation) $('#generate').disabled = !sourceAvailable;
    }
  }

  $('#upload').onclick = () => $('#image-file').click();
  $('#image-file').onchange = async event => {
    try { await loadImage(event.target.files[0]); } catch (error) { notify(error.message || '图片读取失败，请更换文件。', true); }
    event.target.value = '';
  };
  const drop = $('#drop-zone');
  drop.addEventListener('dragover', event => { event.preventDefault(); drop.classList.add('dragover'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
  drop.addEventListener('drop', async event => {
    event.preventDefault(); drop.classList.remove('dragover');
    try { await loadImage(event.dataTransfer.files[0]); } catch (error) { notify(error.message, true); }
  });

  async function generatePattern() {
    if (!sourceAvailable) { notify('请先选择原图，再生成新图纸。', true); return; }
    const button = $('#generate');
    const token = ++generation;
    button.disabled = true;
    button.textContent = '正在生成…';
    try {
      await sourceImage.decode();
      if (token !== generation || !sourceAvailable) return;
      await new Promise(resolve => requestAnimationFrame(resolve));
      if (token !== generation || !sourceAvailable) return;
      if (dirty && libraryUI) {
        await libraryUI.archive();
        if (token !== generation || !sourceAvailable) return;
      }
      const width = Number($('#width').value);
      const height = Number($('#height').value);
      const options = core.normalizeOptions({ background: $('#background').value, background_tolerance: Number($('#tolerance').value), alpha_threshold: data.processing?.alpha_threshold ?? 128, cleanup: Number($('#cleanup').value), color_detail: $('#color-detail').value });
      // Validate bounds before allocating a work canvas.
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 4 || height < 4 || width > 160 || height > 160) throw Error('宽高须为 4–160 的整数。');
      const work = document.createElement('canvas'); work.width = width; work.height = height;
      const ctx = work.getContext('2d', { willReadFrequently: true });
      if (options.background === 'keep') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height); }
      const fit = $('#fit').value;
      const scale = (fit === 'cover' ? Math.max : Math.min)(width / sourceImage.naturalWidth, height / sourceImage.naturalHeight);
      const w = sourceImage.naturalWidth * scale;
      const h = sourceImage.naturalHeight * scale;
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(sourceImage, (width - w) / 2, (height - h) / 2, w, h);
      const unmasked = ctx.getImageData(0, 0, width, height).data;
      let sourceRemoved = 0;
      let sourceBackgroundRemoved = false;
      let samplingImage = sourceImage;
      if (options.cleanup === 4 && options.background === 'auto') {
        // Mask the normalized source before reducing it to beads. Otherwise
        // interpolation bakes the backdrop into grey fringe colors at the edge.
        const mask = document.createElement('canvas');
        mask.width = sourceImage.naturalWidth; mask.height = sourceImage.naturalHeight;
        const maskContext = mask.getContext('2d', { willReadFrequently: true });
        maskContext.drawImage(sourceImage, 0, 0);
        const original = maskContext.getImageData(0, 0, mask.width, mask.height);
        const prepared = core.prepareSourceRGBA(original.data, mask.width, mask.height, options);
        sourceBackgroundRemoved = prepared.removed_background > 0;
        original.data.set(prepared.pixels); maskContext.putImageData(original, 0, 0);
        samplingImage = mask;
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(mask, (width - w) / 2, (height - h) / 2, w, h);
      }
      let rgba = ctx.getImageData(0, 0, width, height).data;
      for (let i = 3; i < rgba.length; i += 4) if (unmasked[i] >= options.alpha_threshold && rgba[i] < options.alpha_threshold) sourceRemoved++;
      if (options.cleanup === 4) {
        const detail = document.createElement('canvas'); detail.width = width * 3; detail.height = height * 3;
        const detailContext = detail.getContext('2d', { willReadFrequently: true });
        if (options.background === 'keep') { detailContext.fillStyle = '#fff'; detailContext.fillRect(0, 0, detail.width, detail.height); }
        detailContext.imageSmoothingQuality = 'high';
        detailContext.drawImage(samplingImage, (width - w) * 1.5, (height - h) * 1.5, w * 3, h * 3);
        rgba = core.sampleCraftRGBA(rgba, detailContext.getImageData(0, 0, detail.width, detail.height).data, width, height, options.alpha_threshold);
      }
      // Once the source is masked, transparent margins surround the subject.
      // Re-detecting a backdrop from that silhouette can select the clothes.
      const samplingOptions = sourceBackgroundRemoved ? { ...options, background: 'transparent' } : options;
      const palette = $('#palette-mode').value === 'auto' ? core.derivePalette(rgba, width, height, samplingOptions, Number($('#color-limit').value)) : data.palette;
      const result = core.processRGBA(rgba, width, height, palette, samplingOptions);
      result.processing = options;
      result.metrics.removed_background += sourceRemoved;
      beforeCleanup = result.metrics.cleaned_cells > 0 ? core.processRGBA(rgba, width, height, palette, { ...samplingOptions, cleanup: 0 }).cells : null;
      const title = pendingImage ? sourceName.replace(/\.[^.]+$/, '') + ' · 我的拼豆图纸' : data.title;
      const newCase = pendingImage;
      data = core.validatePattern({ version: 2, title, mode: data.mode, width, height, palette, ...result, source: { name: sourceName, fit }, notes: ['自动提色为通用 RGB 参考，不是品牌官方色号。', '去底仅针对外围纯色背景，请检查主体轮廓。'] });
      patternSourceImage = sourceImage;
      patternSourceAvailable = sourceAvailable;
      contentRevision++;
      if (newCase) { documentId++; libraryUI?.newDocument(); }
      pendingImage = false; dirty = true; comparing = false; undoStack = []; redoStack = []; brush = 0; highlightedColor = null;
      keyboardPoint = { x: 0, y: 0 };
      $('#compare').disabled = !beforeCleanup;
      fitZoom(); setTool(false); render();
      updateResolution();
      const metrics = data.metrics;
      const removal = metrics.removed_background ? `去除 ${metrics.removed_background} 格外围背景，` : '';
      const cleanupSummary = options.cleanup === 4 ? `整理 ${metrics.cleaned_cells} 格碎色` : `合并 ${metrics.cleaned_cells} 格近色杂点`;
      notify(`已生成：${removal}${metrics.blank_cells} 格留空，${cleanupSummary}。${metrics.bead_count === 0 ? '当前全部留空；可降低去底容差或更换背景模式。' : ''}`);
      $('#save-state').textContent = '新图纸 · 请保存';
      $('#settings-message').textContent = '已应用当前设置。';
      libraryUI?.archive().catch(() => {});
    } catch (error) { notify(error.message || '生成失败，请检查图片与设置。', true); }
    finally { button.disabled = !sourceAvailable; button.innerHTML = '生成图纸 <span aria-hidden="true">↗</span>'; }
  }
  $('#settings').onsubmit = event => { event.preventDefault(); return generatePattern(); };

  function download(name, body, type) {
    const link = document.createElement('a');
    const url = URL.createObjectURL(new Blob([body], { type }));
    link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  $('#save').onclick = () => {
    const normalized = core.validatePattern(data);
    download('pattern.json', JSON.stringify(normalized, null, 2), 'application/json');
    dirty = false; $('#save-state').textContent = '已导出 JSON 图纸';
    libraryUI?.archive().catch(() => {});
  };
  $('#svg').onclick = () => download('pattern.svg', core.toSVG(data, showSymbols), 'image/svg+xml');
  $('#csv').onclick = () => download('materials.csv', core.toCSV(data), 'text/csv;charset=utf-8');
  $('#print').onclick = () => window.print();
  let printHighlight = null;
  window.addEventListener('beforeprint', () => { printHighlight = highlightedColor; highlightedColor = null; draw(); });
  window.addEventListener('afterprint', () => { highlightedColor = printHighlight; draw(); });
  $('#load').onclick = () => $('#json-file').click();
  $('#json-file').onchange = async event => {
    try {
      const file = event.target.files[0];
      if (!file) return;
      if (file.size > 5_000_000) throw Error('图纸 JSON 不能超过 5 MB。');
      const token = ++generation;
      const content = await file.text();
      if (token !== generation) return;
      const imported = core.validatePattern(JSON.parse(content));
      if (dirty && libraryUI) {
        await libraryUI.archive();
        if (token !== generation) return;
      }
      // JSON stores the pattern, not the original image. Do not silently regenerate
      // an imported pattern from the unrelated image that was open before import.
      data = imported; undoStack = []; redoStack = []; beforeCleanup = null; comparing = false;
      brush = 0; highlightedColor = null; dirty = false; sourceAvailable = false; pendingImage = false;
      patternSourceAvailable = false;
      documentId++; contentRevision++;
      libraryUI?.newDocument();
      keyboardPoint = { x: 0, y: 0 };
      preview.hidden = true; $('#source-name').textContent = '图纸已导入 · 重新生成需选择原图';
      $('#generate').disabled = true; $('#compare').disabled = true;
      syncSettings(); fitZoom(); setTool(false); render();
      $('#save-state').textContent = '已导入图纸';
      notify('已导入图纸，可以继续改色和导出。重新生成时，请先选择对应原图。');
      libraryUI?.archive().catch(() => {});
    } catch (error) { notify(error.message || '无法读取这份图纸。', true); }
    event.target.value = '';
  };
  window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  $('#source-name').textContent = sourceName;
  syncSettings(); fitZoom(); render();
  notify(`图纸已就绪：${data.metrics.blank_cells} 格留空，合并 ${data.metrics.cleaned_cells} 格近色杂点。`);

  function patternPreview(pattern) {
    const picture = document.createElement('canvas');
    const scale = Math.max(2, Math.min(10, Math.floor(400 / Math.max(pattern.width, pattern.height))));
    picture.width = pattern.width * scale; picture.height = pattern.height * scale;
    const ctx = picture.getContext('2d');
    pattern.cells.forEach((color, index) => {
      if (color === null) return;
      ctx.fillStyle = pattern.palette[color].hex;
      ctx.fillRect(index % pattern.width * scale, Math.floor(index / pattern.width) * scale, scale, scale);
    });
    return picture.toDataURL('image/png');
  }

  async function librarySnapshot() {
    const pattern = core.validatePattern(data);
    const revision = contentRevision;
    const identity = documentId;
    const original = patternSourceImage;
    const available = patternSourceAvailable;
    const previewData = patternPreview(pattern);
    let sourceData = null;
    if (available) {
      await original.decode();
      const copy = document.createElement('canvas');
      const scale = Math.min(1, 1024 / Math.max(original.naturalWidth, original.naturalHeight));
      copy.width = Math.max(1, Math.round(original.naturalWidth * scale));
      copy.height = Math.max(1, Math.round(original.naturalHeight * scale));
      copy.getContext('2d').drawImage(original, 0, 0, copy.width, copy.height);
      sourceData = copy.toDataURL('image/png');
    }
    return { pattern, source_data: sourceData, preview_data: previewData, editor_revision: revision, document_id: identity };
  }

  async function openLibraryCase(record, intent) {
    if (intent && (intent.generation !== generation || intent.revision !== contentRevision)) throw Error('当前图纸已更新，请重新打开案例。');
    const token = intent ? generation : ++generation;
    const pattern = core.validatePattern(record.pattern);
    let original = null;
    if (record.source_url) {
      const url = new URL(record.source_url, location.href);
      const embedded = /^data:image\/(png|jpeg|webp|gif|avif);base64,/.test(record.source_url);
      if (!embedded && (url.origin !== location.origin || !url.pathname.startsWith('/api/library/cases/'))) throw Error('案例原图地址无效。');
      original = new Image(); original.src = record.source_url;
      await original.decode();
    }
    if (token !== generation || (intent && intent.revision !== contentRevision)) throw Error('图纸操作已更新，请重新打开案例。');
    data = pattern;
    data.title = record.case.title;
    documentId++; contentRevision++;
    sourceAvailable = Boolean(original);
    patternSourceAvailable = sourceAvailable;
    sourceImage = original; patternSourceImage = original;
    sourceName = pattern.source?.name || record.case.title;
    preview.src = original?.src || '';
    preview.hidden = !sourceAvailable;
    $('#source-name').textContent = sourceAvailable ? sourceName : '本案例未保存原图，可继续修改格子';
    undoStack = []; redoStack = []; beforeCleanup = null; comparing = false;
    dirty = false; pendingImage = false; brush = 0; highlightedColor = null; keyboardPoint = { x: 0, y: 0 };
    $('#compare').disabled = true; $('#generate').disabled = !sourceAvailable;
    syncSettings(); setTool(false); fitZoom(); render();
    $('#save-state').textContent = '已打开案例';
    notify(sourceAvailable ? '已从案例库恢复图纸与原图，可以继续编辑或重新生成。' : '已恢复图纸；重新生成前需选择对应原图。');
    return documentId;
  }

  libraryUI = CaseLibraryUI.mount({
    snapshot: librarySnapshot,
    open: openLibraryCase,
    documentId: () => documentId,
    cancelPending: () => ({ generation: ++generation, revision: contentRevision }),
    fit: () => { fitZoom(); draw(); },
    isDirty: () => dirty,
    rename: title => { data.title = title; renderPalette(); },
    archived: snapshot => {
      if (snapshot.document_id === documentId && snapshot.editor_revision === contentRevision) {
        dirty = false;
        $('#save-state').textContent = '已保存到案例库';
      }
    },
  });
})();
