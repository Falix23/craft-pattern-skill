/* Case storage: localhost SQLite when available, otherwise this browser's IndexedDB. */
(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CaseLibrary = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const FORMAT = 'craft-pattern-library';
  const DATABASE = 'craft-pattern-library';
  const STATUSES = ['draft', 'final', 'made'];
  const MISSING_API = Symbol('missing-library-api');
  const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key) && object[key] !== undefined;
  const copy = value => JSON.parse(JSON.stringify(value));

  function core() {
    if (root.PatternCore) return root.PatternCore;
    if (typeof require === 'function') return require('./pattern-core.js');
    throw Error('图纸处理模块尚未载入');
  }

  function object(value, message) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(message);
    return value;
  }

  function text(value, fallback, maximum, label) {
    if (value === undefined) value = fallback;
    if (typeof value !== 'string' || value.length > maximum) throw Error(`${label}须为不超过 ${maximum} 字符的文字`);
    return value.trim();
  }

  function normalizeMetadata(input = {}, defaults = {}) {
    object(input, '案例信息须为对象');
    const title = text(input.title, defaults.title ?? '未命名案例', 300, '案例标题') || '未命名案例';
    const description = text(input.description, defaults.description ?? '', 5000, '案例说明');
    const status = input.status ?? defaults.status ?? 'draft';
    if (!STATUSES.includes(status)) throw Error('案例状态须为 draft、final 或 made');
    const inputTags = input.tags ?? defaults.tags ?? [];
    if (!Array.isArray(inputTags) || inputTags.length > 20) throw Error('标签须为不超过 20 项的数组');
    const tags = [];
    for (const tag of inputTags) {
      const normalized = text(tag, '', 50, '标签');
      if (normalized && !tags.includes(normalized)) tags.push(normalized);
    }
    return { title, tags, description, status };
  }

  function imageData(value, label) {
    if (value == null || value === '') return null;
    if (typeof value !== 'string' || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z\d+/=\r\n]+$/.test(value)) {
      throw Error(`${label}须为 PNG、JPEG 或 WebP 的 base64 图片`);
    }
    if (value.length > Math.floor(10 * 1024 * 1024 * 4 / 3) + 100) throw Error(`${label}不能超过 10 MB，请先缩小图片`);
    return value;
  }

  function validID(value) {
    if (typeof value !== 'string' || !/^[A-Za-z\d][A-Za-z\d._-]{0,127}$/.test(value)) throw Error('案例 ID 无效');
    return value;
  }

  function timestamp(value, label) {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw Error(`${label}无效`);
    return new Date(value).toISOString();
  }

  function stable(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  }

  function fingerprint(pattern, sourceData = null) {
    const normalized = core().validatePattern(pattern);
    return stable({
      mode: normalized.mode,
      width: normalized.width,
      height: normalized.height,
      palette: normalized.palette,
      cells: normalized.cells,
      processing: core().normalizeOptions(normalized.processing || {}),
      source_data: sourceData ?? null,
    });
  }

  function latestVersion(record) {
    if (!Array.isArray(record.versions) || record.versions.length === 0) throw Error('案例缺少图纸版本');
    return record.versions.reduce((latest, version) => version.version > latest.version ? version : latest);
  }

  function createSummary(record, version = latestVersion(record)) {
    const pattern = core().validatePattern(version.pattern);
    const counts = core().counts(pattern);
    const beadCount = counts.reduce((sum, count) => sum + count, 0);
    return {
      id: record.id,
      ...normalizeMetadata(record),
      width: pattern.width,
      height: pattern.height,
      color_count: counts.filter(count => count > 0).length,
      bead_count: beadCount,
      blank_cells: pattern.cells.length - beadCount,
      version_count: record.versions.length,
      created_at: record.created_at,
      updated_at: record.updated_at,
      preview_url: version.preview_data || null,
      source_name: pattern.source?.name || '',
    };
  }

  function normalizeFilters(input = {}) {
    object(input, '筛选条件须为对象');
    const filters = { q: input.q == null ? '' : String(input.q).trim(), limit: 24, offset: 0 };
    if (filters.q.length > 500) throw Error('搜索内容不能超过 500 字符');
    for (const [field, maximum] of [['max_width', 160], ['max_height', 160], ['max_colors', 36], ['max_beads', 25600]]) {
      if (input[field] === undefined || input[field] === null || input[field] === '') continue;
      const value = Number(input[field]);
      if (!Number.isInteger(value) || value < 0 || value > maximum) throw Error('筛选数量超出范围');
      filters[field] = value;
    }
    if (input.status != null && input.status !== '') {
      if (!STATUSES.includes(input.status)) throw Error('案例筛选状态无效');
      filters.status = input.status;
    }
    for (const field of ['limit', 'offset']) {
      if (input[field] === undefined || input[field] === null || input[field] === '') continue;
      const value = Number(input[field]);
      if (!Number.isSafeInteger(value) || value < (field === 'limit' ? 1 : 0) || value > (field === 'limit' ? 100 : 1_000_000)) throw Error('案例分页参数无效');
      filters[field] = value;
    }
    return filters;
  }

  function filterCases(records, input = {}) {
    const filters = normalizeFilters(input);
    const words = filters.q.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
    const items = records.map(record => record.versions ? createSummary(record) : copy(record)).filter(item => {
      const haystack = [item.title, ...(item.tags || []), item.description, item.source_name].join(' ').toLocaleLowerCase();
      if (!words.every(word => haystack.includes(word))) return false;
      if (filters.status && item.status !== filters.status) return false;
      for (const [filter, field] of [['max_width', 'width'], ['max_height', 'height'], ['max_colors', 'color_count'], ['max_beads', 'bead_count']]) {
        if (filters[filter] !== undefined && item[field] > filters[filter]) return false;
      }
      return true;
    });
    items.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || String(b.id).localeCompare(String(a.id)));
    return { items: items.slice(filters.offset, filters.offset + filters.limit), total: items.length };
  }

  function validateBackup(input) {
    object(input, '案例库备份须为对象');
    if (input.format !== FORMAT || input.version !== 1 || !Array.isArray(input.cases)) throw Error('不支持的案例库备份格式');
    if (input.cases.length > 10000) throw Error('备份案例数量超过 10000 项');
    const ids = new Set();
    const cases = input.cases.map(record => {
      object(record, '备份案例格式无效');
      const id = validID(record.id);
      if (ids.has(id)) throw Error('备份包含重复案例 ID');
      ids.add(id);
      if (!Array.isArray(record.versions) || record.versions.length === 0 || record.versions.length > 1000) throw Error('备份案例需要 1–1000 个图纸版本');
      const numbers = new Set();
      const versions = record.versions.map(version => {
        object(version, '备份图纸版本无效');
        if (!Number.isSafeInteger(version.version) || version.version < 1 || numbers.has(version.version)) throw Error('备份版本编号无效或重复');
        numbers.add(version.version);
        return {
          version: version.version,
          pattern: core().validatePattern(version.pattern),
          source_data: imageData(version.source_data, '原图'),
          preview_data: imageData(version.preview_data, '预览图'),
          created_at: timestamp(version.created_at, '版本时间'),
        };
      }).sort((a, b) => a.version - b.version);
      return {
        id,
        ...normalizeMetadata(record),
        created_at: timestamp(record.created_at, '案例创建时间'),
        updated_at: timestamp(record.updated_at, '案例更新时间'),
        versions,
      };
    });
    return { format: FORMAT, version: 1, cases };
  }

  function defaultID() {
    return root.crypto?.randomUUID?.() || 'case-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }

  // The adapter has readAll() and mutate(fn). mutate calls fn(records) atomically;
  // its result is { records: changedRecordsToPut, value: returnValue }.
  function createStoreClient(store, options = {}) {
    const now = options.now || (() => new Date().toISOString());
    const newID = options.idFactory || defaultID;
    const path = options.path || '此浏览器 · IndexedDB / craft-pattern-library';
    const uniqueID = records => {
      const used = new Set(records.map(record => record.id));
      let id;
      for (let tries = 0; tries < 100; tries++) {
        id = validID(newID());
        if (!used.has(id)) return id;
      }
      throw Error('无法分配新的案例 ID，请重试');
    };
    function notFound() { const error = Error('未找到这份案例或图纸版本'); error.status = 404; throw error; }

    return {
      backend: 'indexeddb',
      path,
      async info() { return { backend: 'indexeddb', path, case_count: (await store.readAll()).length }; },
      async list(filters = {}) { return filterCases(await store.readAll(), filters); },
      async save(input) {
        object(input, '保存内容须为对象');
        const pattern = core().validatePattern(input.pattern);
        const suppliedSource = has(input, 'source_data') ? imageData(input.source_data, '原图') : undefined;
        const suppliedPreview = has(input, 'preview_data') ? imageData(input.preview_data, '预览图') : undefined;
        if (input.case_id != null) validID(input.case_id);
        normalizeMetadata(input, { title: pattern.title });
        return store.mutate(records => {
          let existing = input.case_id != null ? records.find(record => record.id === input.case_id) : null;
          if (input.case_id != null && !existing) return notFound();
          const previous = existing ? latestVersion(existing) : null;
          const sourceData = suppliedSource !== undefined ? suppliedSource : previous?.source_data ?? null;
          const signature = fingerprint(pattern, sourceData);
          if (!existing) {
            const duplicate = records.find(record => {
              const latest = latestVersion(record);
              return fingerprint(latest.pattern, latest.source_data) === signature;
            });
            if (duplicate) return { records: [], value: { case: createSummary(duplicate), created: false, version_added: false } };
          }
          const date = timestamp(now(), '保存时间');
          const metadata = normalizeMetadata(input, existing || { title: pattern.title });
          if (!existing) {
            const record = { id: uniqueID(records), ...metadata, created_at: date, updated_at: date, versions: [{ version: 1, pattern, source_data: sourceData, preview_data: suppliedPreview ?? null, created_at: date }] };
            return { records: [record], value: { case: createSummary(record), created: true, version_added: true } };
          }
          const duplicate = fingerprint(previous.pattern, previous.source_data) === signature;
          const record = { ...existing, ...metadata, versions: existing.versions.slice() };
          if (!duplicate) record.versions.push({ version: previous.version + 1, pattern, source_data: sourceData, preview_data: suppliedPreview ?? null, created_at: date });
          const metadataChanged = stable(normalizeMetadata(existing)) !== stable(metadata);
          if (!duplicate || metadataChanged) record.updated_at = date;
          return { records: !duplicate || metadataChanged ? [record] : [], value: { case: createSummary(record), created: false, version_added: !duplicate } };
        });
      },
      async get(id, version) {
        validID(id);
        if (version != null && (!Number.isSafeInteger(Number(version)) || Number(version) < 1)) throw Error('版本编号无效');
        const record = (await store.readAll()).find(item => item.id === id);
        if (!record) return notFound();
        const selected = version == null ? latestVersion(record) : record.versions.find(item => item.version === Number(version));
        if (!selected) return notFound();
        return {
          case: createSummary(record),
          pattern: core().validatePattern(selected.pattern),
          source_url: selected.source_data || null,
          preview_url: selected.preview_data || null,
          versions: record.versions.map(item => ({ version: item.version, created_at: item.created_at })).sort((a, b) => b.version - a.version),
        };
      },
      async update(id, metadata) {
        validID(id);
        object(metadata, '案例信息须为对象');
        return store.mutate(records => {
          const existing = records.find(record => record.id === id);
          if (!existing) return notFound();
          const normalized = normalizeMetadata(metadata, existing);
          const changed = stable(normalizeMetadata(existing)) !== stable(normalized);
          const record = { ...existing, ...normalized, updated_at: changed ? timestamp(now(), '保存时间') : existing.updated_at };
          return { records: changed ? [record] : [], value: { case: createSummary(record) } };
        });
      },
      async backup() {
        const cases = (await store.readAll()).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
        return validateBackup({ format: FORMAT, version: 1, cases });
      },
      async importBackup(input) {
        const backup = validateBackup(input); // Validate every version before opening a write transaction.
        return store.mutate(records => {
          const existing = records.slice();
          const changed = [];
          const conflicts = [];
          let skipped = 0;
          const contentKey = record => stable(record.versions.map(version => fingerprint(version.pattern, version.source_data)));
          const signatures = new Set(existing.map(contentKey));
          for (const candidate of backup.cases) {
            const key = contentKey(candidate);
            if (signatures.has(key)) { skipped++; continue; }
            const record = copy(candidate);
            if (existing.some(item => item.id === record.id)) {
              const oldID = record.id;
              record.id = uniqueID(existing);
              conflicts.push({ old_id: oldID, new_id: record.id });
            }
            existing.push(record); changed.push(record); signatures.add(key);
          }
          return { records: changed, value: { imported: changed.length, skipped, conflicts } };
        });
      },
    };
  }

  function openIndexedDB(indexedDB) {
    if (!indexedDB) return Promise.reject(Error('此浏览器不支持 IndexedDB；请通过本地案例库服务使用，或更换浏览器。'));
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('cases')) request.result.createObjectStore('cases', { keyPath: 'id' });
      };
      request.onerror = () => reject(request.error || Error('无法打开浏览器案例库'));
      request.onblocked = () => reject(Error('案例库升级被其他页面阻塞，请关闭其他拼豆页面后重试。'));
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => database.close();
        const failure = transaction => transaction.error?.name === 'QuotaExceededError'
          ? Error('浏览器案例库空间不足，请先导出备份并迁移到本地 SQLite 案例库。')
          : transaction.error || Error('浏览器案例库读写失败');
        resolve({
          readAll() {
            return new Promise((done, fail) => {
              const transaction = database.transaction('cases', 'readonly');
              const result = transaction.objectStore('cases').getAll();
              transaction.oncomplete = () => done(result.result);
              transaction.onabort = () => fail(failure(transaction));
              transaction.onerror = () => { /* onabort returns the final transaction error. */ };
            });
          },
          mutate(transform) {
            return new Promise((done, fail) => {
              const transaction = database.transaction('cases', 'readwrite');
              const store = transaction.objectStore('cases');
              const result = store.getAll();
              let value;
              let localError;
              result.onsuccess = () => {
                try {
                  const update = transform(result.result);
                  value = update.value;
                  for (const record of update.records) store.put(record);
                } catch (error) { localError = error; transaction.abort(); }
              };
              transaction.oncomplete = () => done(value);
              transaction.onabort = () => fail(localError || failure(transaction));
              transaction.onerror = () => { /* Failed writes abort the whole transaction. */ };
            });
          },
        });
      };
    });
  }

  async function responseJSON(response) {
    let body;
    try { body = await response.json(); } catch (cause) {
      // A response can arrive before the connection drops while reading its
      // body. Keep that distinct from a server returning malformed JSON.
      if (cause?.name === 'AbortError' || cause instanceof TypeError) throw cause;
      const error = Error(`案例库服务返回了无效数据（HTTP ${response.status}）`);
      error.status = response.status;
      throw error;
    }
    if (!response.ok) {
      const detail = typeof body?.error === 'string' ? body.error : body?.error?.message || body?.message;
      const error = Error(detail || `案例库请求失败（HTTP ${response.status}）`);
      error.status = response.status;
      throw error;
    }
    return body;
  }

  function connectionError(cause, timedOut = false) {
    const error = Error(timedOut
      ? '本地案例库服务连接超时，图纸尚未确认归档。恢复服务后请重试保存。'
      : '本地案例库服务未连接，图纸尚未归档。恢复服务后请重试保存。');
    error.code = timedOut ? 'LIBRARY_TIMEOUT' : 'LIBRARY_CONNECTION';
    error.retryable = true;
    if (cause) error.cause = cause;
    return error;
  }

  async function fetchLibraryJSON(fetcher, url, options, timeoutMs, allowMissing = false) {
    const controller = typeof root.AbortController === 'function' ? new root.AbortController() : null;
    let timer;
    let timedOut = false;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller?.abort();
        reject(connectionError(null, true));
      }, timeoutMs);
    });
    const request = (async () => {
      let response;
      try {
        response = await fetcher(url, { ...options, ...(controller ? { signal: controller.signal } : {}) });
      } catch (cause) {
        throw connectionError(cause, timedOut);
      }
      // A static-hosted editor has no API. This is the only HTTP response that
      // permits selecting IndexedDB; an unavailable existing service does not.
      if (allowMissing && response.status === 404) return MISSING_API;
      return responseJSON(response);
    })();
    try { return await Promise.race([request, timeout]); }
    catch (error) {
      if (error.code === 'LIBRARY_CONNECTION' || error.code === 'LIBRARY_TIMEOUT' || error.status !== undefined) throw error;
      throw connectionError(error, timedOut);
    } finally { clearTimeout(timer); }
  }

  function createHTTPClient(fetcher, initialInfo, timeoutMs) {
    const request = async (url, method = 'GET', payload) => {
      const options = { method, credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } };
      if (payload !== undefined) { options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(payload); }
      return fetchLibraryJSON(fetcher, url, options, timeoutMs);
    };
    const route = id => '/api/library/cases/' + encodeURIComponent(validID(id));
    return {
      backend: 'sqlite', path: initialInfo.path,
      info: () => request('/api/library/info'),
      list(filters = {}) {
        const normalized = normalizeFilters(filters);
        const query = new URLSearchParams();
        for (const [key, value] of Object.entries(normalized)) if (value !== '') query.set(key, String(value));
        return request('/api/library/cases?' + query.toString());
      },
      save(input) {
        object(input, '保存内容须为对象');
        const pattern = core().validatePattern(input.pattern);
        const metadata = normalizeMetadata(input, { title: pattern.title });
        const body = { pattern };
        // Keep omitted metadata omitted so saving an existing case preserves its
        // independently edited title, tags, notes and production status.
        for (const key of ['title', 'tags', 'description', 'status']) if (has(input, key)) body[key] = metadata[key];
        for (const key of ['source_data', 'preview_data']) if (has(input, key)) body[key] = imageData(input[key], key === 'source_data' ? '原图' : '预览图');
        if (input.case_id != null) body.case_id = validID(input.case_id);
        return request('/api/library/cases', 'POST', body);
      },
      get(id, version) {
        let url = route(id);
        if (version != null) {
          if (!Number.isSafeInteger(Number(version)) || Number(version) < 1) throw Error('版本编号无效');
          url += '?version=' + Number(version);
        }
        return request(url);
      },
      update(id, metadata) {
        const normalized = normalizeMetadata(metadata);
        const body = {};
        for (const key of ['title', 'tags', 'description', 'status']) if (has(metadata, key)) body[key] = normalized[key];
        return request(route(id), 'PATCH', body);
      },
      backup: () => request('/api/library/backup'),
      importBackup: input => request('/api/library/import', 'POST', validateBackup(input)),
    };
  }

  async function createClient(options = {}) {
    if (options.store) return createStoreClient(options.store, options);
    const location = options.location || root.location;
    const fetcher = options.fetch || (typeof root.fetch === 'function' ? root.fetch.bind(root) : null);
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw Error('案例库连接超时时间无效');
    if (location?.protocol !== 'file:' && fetcher) {
      const info = await fetchLibraryJSON(fetcher, '/api/library/info', {
        credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' },
      }, timeoutMs, true);
      if (info !== MISSING_API) {
        if (!info || info.backend !== 'sqlite') throw Error('本地案例库服务类型不受支持');
        return createHTTPClient(fetcher, info, timeoutMs);
      }
    } else if (['http:', 'https:'].includes(location?.protocol)) {
      throw connectionError();
    }
    return createStoreClient(await openIndexedDB(options.indexedDB || root.indexedDB), options);
  }

  return { createClient, createStoreClient, createSummary, validateBackup, normalizeMetadata, filterCases, fingerprint };
}));
