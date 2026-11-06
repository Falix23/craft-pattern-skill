/* Collection UI: uses the same contract for SQLite and the offline browser store. */
(function (root) {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const STATES = { draft: '草稿', final: '已定稿', made: '已制作' };

  function mount(editor) {
    let client;
    let connection;
    let connectionFailed = false;
    let activeDocument = null;
    const documents = new Map();
    let saveQueue = Promise.resolve();
    let searchSequence = 0;
    let searchTimer;
    let offset = 0;
    let visible = false;
    let editingCase = null;
    let infoSequence = 0;
    let openSequence = 0;
    const limit = 24;

    function message(text, error = false) {
      $('#library-message').textContent = text;
      $('#library-message').classList.toggle('error', error);
    }

    function archiveState(text, error = false) {
      $('#archive-state').textContent = text;
      $('#archive-state').style.color = error ? '#b04c38' : '';
      $('#archive-retry').hidden = !error;
    }

    function enableLibraryControls() {
      $('#library-storage').textContent = client.backend === 'sqlite'
        ? '保存在这台电脑上 · 原图、图纸与版本一起归档'
        : '保存在当前浏览器中 · 清理浏览器数据前，请导出备份';
      for (const id of ['archive-current', 'backup-library', 'import-library']) $('#' + id).disabled = false;
    }

    function ensureReady() {
      if (client) return Promise.resolve(client);
      if (connection) return connection;
      connection = (async () => {
        try {
          const connected = await CaseLibrary.createClient();
          // Keep the selected backend even if the following count refresh fails.
          client = connected;
          await refreshInfo(connected);
          connectionFailed = false;
          enableLibraryControls();
          archiveState('生成后自动收录到案例库');
          return client;
        } catch (error) {
          connectionFailed = true;
          $('#archive-current').disabled = false;
          archiveState('案例库未连接。图纸仍保留在当前页面，可恢复服务后重试保存。', true);
          message(error.message, true);
          throw error;
        } finally { connection = null; }
      })();
      return connection;
    }
    const ready = ensureReady();
    // Initialization errors are shown in the UI; do not create an unhandled rejection.
    ready.catch(() => {});

    async function refreshInfo(current = client) {
      const info = await current.info();
      $('#library-count').textContent = info.case_count ?? 0;
    }

    function filters() {
      const result = { q: $('#case-query').value.trim(), limit, offset };
      for (const [id, key] of [['filter-width','max_width'],['filter-height','max_height'],['filter-colors','max_colors'],['filter-beads','max_beads']]) {
        if ($('#' + id).value !== '') result[key] = Number($('#' + id).value);
      }
      if ($('#filter-status').value) result.status = $('#filter-status').value;
      return result;
    }

    function showView(name) {
      visible = name === 'library';
      $('#editor-view').hidden = visible;
      $('#library-view').hidden = !visible;
      $('#show-editor').classList.toggle('active', !visible);
      $('#show-library').classList.toggle('active', visible);
      $('#show-editor').setAttribute('aria-pressed', String(!visible));
      $('#show-library').setAttribute('aria-pressed', String(visible));
      window.scrollTo({ top: 0, behavior: 'instant' });
    }

    async function search(append = false) {
      const sequence = ++searchSequence;
      if (!append) offset = 0;
      try {
        await ensureReady();
        const result = await client.list(filters());
        if (sequence !== searchSequence) return;
        if (!append) $('#case-list').replaceChildren();
        for (const item of result.items) $('#case-list').append(card(item));
        offset += result.items.length;
        $('#library-results').textContent = `找到 ${result.total} 个案例`;
        $('#library-empty').hidden = result.total > 0;
        $('#more-cases').hidden = offset >= result.total;
        message('');
      } catch (error) { if (sequence === searchSequence) message(error.message, true); }
    }

    function card(item) {
      const article = document.createElement('article');
      article.className = 'case-card';
      const image = document.createElement('img');
      image.className = 'case-thumb';
      image.alt = item.title + '图纸预览';
      image.loading = 'lazy';
      if (item.preview_url) image.src = item.preview_url;
      const body = document.createElement('div'); body.className = 'case-card-body';
      const heading = document.createElement('div'); heading.className = 'case-card-title';
      const title = document.createElement('h2'); title.textContent = item.title;
      const state = document.createElement('span'); state.className = 'case-state ' + item.status; state.textContent = STATES[item.status] || '草稿';
      heading.append(title, state);
      const spec = document.createElement('p'); spec.className = 'case-spec';
      spec.textContent = `${item.width} × ${item.height} 格 · ${item.color_count} 色 · ${item.bead_count} 颗`;
      const tags = document.createElement('div'); tags.className = 'case-tags';
      for (const tag of item.tags || []) { const chip = document.createElement('span'); chip.textContent = tag; tags.append(chip); }
      const description = document.createElement('p'); description.className = 'case-description'; description.textContent = item.description || '';
      const footer = document.createElement('div'); footer.className = 'case-card-footer';
      const versions = document.createElement('select'); versions.setAttribute('aria-label', item.title + '的版本');
      const count = Math.max(1, item.version_count || 1);
      for (let version = count; version > 0; version--) {
        const option = document.createElement('option'); option.value = version; option.textContent = version === count ? `最新 · v${version}` : `历史 · v${version}`; versions.append(option);
      }
      const open = document.createElement('button'); open.className = 'primary'; open.textContent = '打开编辑';
      open.setAttribute('aria-label', '打开编辑：' + item.title);
      open.onclick = () => openCase(item.id, Number(versions.value), open);
      const edit = document.createElement('button'); edit.className = 'text-button'; edit.textContent = '信息'; edit.setAttribute('aria-label', '编辑信息：' + item.title);
      edit.onclick = () => openMetadata(item.id).catch(error => message(error.message, true));
      footer.append(versions, open, edit);
      const date = document.createElement('div'); date.className = 'case-date';
      date.textContent = '更新于 ' + new Date(item.updated_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      body.append(heading, spec, tags, description, footer, date);
      article.append(image, body);
      return article;
    }

    function archive(options = {}) {
      // Capture immediately; a later queued save must not read a different drawing.
      const captured = editor.snapshot();
      captured.catch(() => {});
      const operation = saveQueue.catch(() => {}).then(async () => {
        await ensureReady();
        const snapshot = await captured;
        const document = snapshot.document_id;
        const existing = documents.get(document);
        const payload = { pattern: snapshot.pattern, source_data: snapshot.source_data, preview_data: snapshot.preview_data };
        if (existing && !options.newCase) payload.case_id = existing.id;
        archiveState('正在保存到案例库…');
        const result = await client.save(payload);
        connectionFailed = false;
        enableLibraryControls();
        documents.set(document, result.case);
        if (editor.documentId() === document) {
          activeDocument = document;
          archiveState(`已收录 · v${result.case.version_count}${result.version_added ? ' · 新版本' : ''}`);
          $('#archive-current').textContent = '保存新版本';
          $('#edit-case-info').disabled = false;
          editor.archived(snapshot);
        }
        try {
          await refreshInfo();
          if (visible) await search();
        } catch (error) {
          // A failed list/count refresh must not turn a committed save into a failure.
          message('图纸已保存。案例列表暂时无法刷新，请稍后重新打开案例库。', true);
        }
        return result;
      });
      saveQueue = operation;
      operation.catch(error => {
        connectionFailed = true;
        archiveState(error.retryable ? error.message : '图纸尚未归档：' + error.message, true);
      });
      return operation;
    }

    async function openCase(id, version, button) {
      const sequence = ++openSequence;
      const intent = editor.cancelPending();
      button.disabled = true;
      try {
        await ensureReady();
        // Preserve ongoing work before replacing the editor with another case.
        if (editor.isDirty()) await archive();
        if (sequence !== openSequence) return;
        const record = await client.get(id, version);
        if (sequence !== openSequence) return;
        const document = await editor.open(record, intent);
        if (sequence !== openSequence) return;
        documents.set(document, record.case);
        activeDocument = document;
        archiveState(`已打开「${record.case.title}」 · v${version}`);
        $('#archive-current').textContent = '保存新版本';
        $('#edit-case-info').disabled = false;
        showView('editor');
        editor.fit();
      } catch (error) { if (sequence === openSequence) message('案例打开失败：' + error.message, true); }
      finally { button.disabled = false; }
    }

    async function openMetadata(id) {
      const sequence = ++infoSequence;
      const record = await client.get(id);
      if (sequence !== infoSequence) return;
      editingCase = record.case;
      $('#case-name').value = record.case.title;
      $('#case-tags').value = (record.case.tags || []).join('，');
      $('#case-description').value = record.case.description || '';
      $('#case-status').value = record.case.status || 'draft';
      $('#case-info-message').textContent = '';
      $('#save-case-info').disabled = false;
      $('#case-info-dialog').showModal();
    }

    $('#case-info-form').onsubmit = async event => {
      event.preventDefault();
      if (!editingCase) return;
      const caseId = editingCase.id;
      const sequence = infoSequence;
      const button = $('#save-case-info'); button.disabled = true;
      try {
        const metadata = {
          title: $('#case-name').value.trim(),
          tags: $('#case-tags').value.split(/[,，\n]/).map(value => value.trim()).filter(Boolean),
          description: $('#case-description').value.trim(),
          status: $('#case-status').value,
        };
        await client.update(caseId, metadata);
        for (const [document, value] of documents) if (value.id === caseId) {
          documents.set(document, { ...value, ...metadata });
          if (editor.documentId() === document) editor.rename(metadata.title);
        }
        if (sequence === infoSequence && editingCase?.id === caseId) $('#case-info-dialog').close();
        if (visible) await search();
        archiveState('案例信息已更新');
      } catch (error) { if (sequence === infoSequence) $('#case-info-message').textContent = error.message; }
      finally { if (sequence === infoSequence) button.disabled = false; }
    };
    $('#close-case-info').onclick = () => $('#case-info-dialog').close();
    $('#show-library').onclick = () => { showView('library'); search(); };
    $('#show-editor').onclick = () => showView('editor');
    $('#empty-to-editor').onclick = () => showView('editor');
    $('#archive-current').onclick = () => archive().catch(() => {});
    $('#archive-retry').onclick = async () => {
      const button = $('#archive-retry');
      button.disabled = true;
      try { await archive(); } catch (_) { /* Keep the drawing and retry control. */ }
      finally { button.disabled = false; }
    };
    $('#edit-case-info').onclick = () => {
      const selected = documents.get(editor.documentId());
      if (selected) openMetadata(selected.id).catch(error => archiveState(error.message, true));
    };
    $('#library-search').onsubmit = event => { event.preventDefault(); clearTimeout(searchTimer); search(); };
    $('#library-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => search(), 250); });
    $('#clear-search').onclick = () => { $('#library-search').reset(); search(); };
    $('#more-cases').onclick = () => search(true);

    function download(name, value) {
      const url = URL.createObjectURL(new Blob([JSON.stringify(value)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = name; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    $('#backup-library').onclick = async () => {
      const button = $('#backup-library'); button.disabled = true;
      try {
        await ensureReady();
        if (editor.isDirty()) await archive();
        await saveQueue;
        download('craft-pattern-library-' + new Date().toISOString().slice(0, 10) + '.json', await client.backup());
        message('已导出完整案例库备份，包含原图、图纸和历史版本。');
      } catch (error) { message('备份失败：' + error.message, true); }
      finally { button.disabled = false; }
    };
    $('#import-library').onclick = () => $('#library-backup-file').click();
    $('#library-backup-file').onchange = async event => {
      const button = $('#import-library'); button.disabled = true;
      try {
        const file = event.target.files[0]; if (!file) return;
        if (file.size > 100 * 1024 * 1024) throw Error('备份文件不能超过 100 MB。');
        const backup = JSON.parse(await file.text());
        await ensureReady();
        const result = await client.importBackup(backup);
        await refreshInfo(); await search();
        message(`备份已导入，新增 ${result.imported ?? 0} 个案例，跳过 ${result.skipped ?? 0} 个重复案例。`);
      } catch (error) { message('导入失败：' + error.message, true); }
      finally { event.target.value = ''; button.disabled = false; }
    };

    function newDocument() {
      activeDocument = null;
      $('#archive-current').textContent = '存入案例库';
      $('#edit-case-info').disabled = true;
      if (connectionFailed) archiveState('案例库未连接。图纸仍保留在当前页面，可恢复服务后重试保存。', true);
      else archiveState('生成后自动收录到案例库');
    }
    return { archive, newDocument, ready };
  }
  root.CaseLibraryUI = { mount };
}(typeof globalThis !== 'undefined' ? globalThis : this));
