'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const Library = require('../assets/library-client.js');

const clone = value => JSON.parse(JSON.stringify(value));
const IMAGE = 'data:image/png;base64,aGVsbG8=';
const OTHER_IMAGE = 'data:image/png;base64,d29ybGQ=';
const makePattern = (patch = {}) => ({ version: 2, title: '橘猫图纸', mode: 'bead', width: 4, height: 4, palette: [{ id: 'WHITE', hex: '#ffffff' }, { id: 'BLACK', hex: '#000000' }], cells: [0, 1, ...Array(14).fill(null)], source: { name: 'cat.png', fit: 'contain' }, ...patch });
function memoryStore() {
  const records = new Map();
  let queue = Promise.resolve();
  return {
    async readAll() { await queue; return clone([...records.values()]); },
    mutate(transform) {
      const work = queue.then(() => {
        const result = transform(clone([...records.values()]));
        for (const record of result.records) records.set(record.id, clone(record));
        return result.value;
      });
      queue = work.catch(() => {});
      return work;
    },
  };
}
function client() {
  let id = 0;
  let date = 0;
  return Library.createStoreClient(memoryStore(), { idFactory: () => 'test-' + ++id, now: () => new Date(Date.UTC(2026, 10, 4, 0, 0, date++)).toISOString() });
}

test('summary counts actual beads and used colors, excluding null and unused palette colors', async () => {
  const c = client();
  const saved = await c.save({ pattern: makePattern(), source_data: IMAGE, preview_data: IMAGE });
  assert.equal(saved.case.width, 4);
  assert.equal(saved.case.bead_count, 2);
  assert.equal(saved.case.blank_cells, 14);
  assert.equal(saved.case.color_count, 2);
  assert.equal(saved.case.preview_url, IMAGE);
  assert.equal(saved.case.source_name, 'cat.png');
  assert.equal((await c.info()).case_count, 1);
});

test('fingerprints ignore incidental title, source filename, metrics, notes and property order', () => {
  const a = makePattern();
  const b = makePattern({ title: '改名', source: { name: 'different.png' }, notes: ['编辑备注'], metrics: { cleaned_cells: 1 } });
  assert.equal(Library.fingerprint(a, IMAGE), Library.fingerprint(b, IMAGE));
  assert.notEqual(Library.fingerprint(a, IMAGE), Library.fingerprint(a, OTHER_IMAGE));
});

test('saving the same generated case deduplicates without overwriting custom metadata', async () => {
  const c = client();
  const first = await c.save({ pattern: makePattern(), source_data: IMAGE });
  await c.update(first.case.id, { title: '我的猫', tags: ['宠物'], status: 'final' });
  const duplicate = await c.save({ pattern: makePattern({ title: '自动标题' }), source_data: IMAGE });
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.version_added, false);
  assert.equal(duplicate.case.id, first.case.id);
  assert.equal(duplicate.case.title, '我的猫');
  assert.equal(duplicate.case.status, 'final');
  assert.equal((await c.info()).case_count, 1);
});

test('existing case saves preserve omitted source and metadata while appending changed patterns', async () => {
  const c = client();
  const first = await c.save({ pattern: makePattern(), source_data: IMAGE, title: '定制标题', tags: ['猫'], status: 'made' });
  const pattern = makePattern(); pattern.cells[3] = 1;
  const result = await c.save({ pattern, case_id: first.case.id, preview_data: OTHER_IMAGE });
  assert.equal(result.version_added, true);
  assert.equal(result.case.version_count, 2);
  assert.equal(result.case.title, '定制标题');
  assert.equal(result.case.status, 'made');
  const latest = await c.get(first.case.id);
  assert.equal(latest.source_url, IMAGE);
  assert.equal(latest.preview_url, OTHER_IMAGE);
  assert.equal(latest.pattern.cells[3], 1);
  const old = await c.get(first.case.id, 1);
  assert.equal(old.pattern.cells[3], null);
  assert.deepEqual(latest.versions.map(version => version.version), [2, 1]);
});

test('explicit null source clears the source and differs from an omitted source', async () => {
  const c = client();
  const first = await c.save({ pattern: makePattern(), source_data: IMAGE });
  const cleared = await c.save({ pattern: makePattern(), case_id: first.case.id, source_data: null });
  assert.equal(cleared.version_added, true);
  assert.equal((await c.get(first.case.id)).source_url, null);
});

test('restoring a historical pattern appends a version rather than silently retaining a different latest pattern', async () => {
  const c = client();
  const first = await c.save({ pattern: makePattern(), source_data: IMAGE });
  const changed = makePattern(); changed.cells[3] = 1;
  await c.save({ pattern: changed, case_id: first.case.id });
  const restored = await c.save({ pattern: makePattern(), case_id: first.case.id });
  assert.equal(restored.version_added, true);
  assert.equal(restored.case.version_count, 3);
  assert.equal((await c.get(first.case.id)).pattern.cells[3], null);
});

test('metadata editing does not append a version and invalid statuses are rejected', async () => {
  const c = client();
  const first = await c.save({ pattern: makePattern() });
  const result = await c.update(first.case.id, { title: '  新标题  ', tags: [' 小图 ', '小图'], description: '说明', status: 'made' });
  assert.equal(result.case.title, '新标题');
  assert.deepEqual(result.case.tags, ['小图']);
  assert.equal(result.case.version_count, 1);
  await assert.rejects(c.update(first.case.id, { status: 'unknown' }), /状态/);
  await assert.rejects(c.save({ pattern: makePattern(), case_id: 'missing' }), /未找到/);
});

test('query words all match metadata and numeric filters and paging compose', async () => {
  const c = client();
  await c.save({ pattern: makePattern(), title: '橘猫 简单图', tags: ['宠物'], description: '适合新手' });
  const second = makePattern(); second.cells[2] = 1;
  await c.save({ pattern: second, title: '另一只猫', status: 'final' });
  const filtered = await c.list({ q: '宠物 新手', max_width: 4, max_height: 4, max_colors: 2, max_beads: 2 });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.items[0].title, '橘猫 简单图');
  assert.equal((await c.list({ q: '宠物 不存在' })).total, 0);
  assert.equal((await c.list({ status: 'final' })).total, 1);
  const paged = await c.list({ limit: 1, offset: 1 });
  assert.equal(paged.total, 2);
  assert.equal(paged.items.length, 1);
});

test('backup retains every version and source and can be restored without duplicate imports', async () => {
  const first = client();
  const saved = await first.save({ pattern: makePattern(), source_data: IMAGE, preview_data: OTHER_IMAGE });
  const changed = makePattern(); changed.cells[4] = 1;
  await first.save({ pattern: changed, case_id: saved.case.id });
  const backup = await first.backup();
  assert.equal(backup.cases[0].versions.length, 2);
  assert.equal(backup.cases[0].versions[1].source_data, IMAGE);
  const second = client();
  assert.equal((await second.importBackup(backup)).imported, 1);
  assert.equal((await second.importBackup(backup)).skipped, 1);
  assert.equal((await second.get(saved.case.id, 1)).preview_url, OTHER_IMAGE);
});

test('import ID collisions preserve existing cases by creating a new ID', async () => {
  const c = client();
  await c.save({ pattern: makePattern() });
  const other = client();
  const changed = makePattern(); changed.cells[5] = 1;
  await other.save({ pattern: changed });
  const result = await c.importBackup(await other.backup());
  assert.equal(result.imported, 1);
  assert.equal(result.conflicts.length, 1);
  assert.equal((await c.info()).case_count, 2);
  assert.equal((await c.get('test-1')).pattern.cells[5], null);
});

test('all backup cases are validated before any write, preventing partial imports', async () => {
  const c = client();
  const valid = client();
  await valid.save({ pattern: makePattern() });
  const backup = await valid.backup();
  backup.cases.push({ ...clone(backup.cases[0]), id: 'invalid-case', versions: [{ version: 1, pattern: { invalid: true }, created_at: '2026-11-04T00:00:00Z' }] });
  await assert.rejects(c.importBackup(backup));
  assert.equal((await c.info()).case_count, 0);
});

test('image URLs are restricted to safe embedded image types', async () => {
  const c = client();
  for (const source of ['https://external.example/image.png', 'javascript:alert(1)', 'data:image/svg+xml;base64,AAAA']) {
    await assert.rejects(c.save({ pattern: makePattern(), source_data: source }), /base64/);
  }
  assert.throws(() => Library.normalizeMetadata({ tags: '=formula' }), /标签/);
});

test('HTTP adapter preserves omitted source, encodes filters and surfaces server write errors', async () => {
  const calls = [];
  const fetcher = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/library/info') return { ok: true, status: 200, json: async () => ({ backend: 'sqlite', path: '/private/library.sqlite3', case_count: 0 }) };
    if (options.method === 'POST') return { ok: false, status: 507, json: async () => ({ error: '磁盘已满' }) };
    return { ok: true, status: 200, json: async () => ({ items: [], total: 0 }) };
  };
  const c = await Library.createClient({ fetch: fetcher, location: { protocol: 'http:' } });
  assert.equal(c.backend, 'sqlite');
  await c.list({ q: '猫 & 狗', status: 'draft', limit: 24 });
  assert.equal(new URL(calls[1].url, 'http://localhost').searchParams.get('q'), '猫 & 狗');
  await assert.rejects(c.save({ pattern: makePattern(), case_id: 'case1' }), error => {
    assert.equal(error.message, '磁盘已满');
    assert.equal(error.status, 507);
    assert.equal(error.code, undefined);
    return true;
  });
  const body = JSON.parse(calls[2].options.body);
  assert.equal(Object.hasOwn(body, 'source_data'), false);
  assert.equal(Object.hasOwn(body, 'title'), false);
  assert.equal(c.backend, 'sqlite');
});

test('initialization HTTP errors are not silently replaced by a different library', async () => {
  const fetcher = async () => ({ ok: false, status: 403, json: async () => ({ error: '禁止访问本地库' }) });
  await assert.rejects(Library.createClient({ fetch: fetcher, location: { protocol: 'http:' } }), /禁止访问/);
});

test('an HTTP initialization network refusal reports the disconnected service without opening another library', async () => {
  let opened = 0;
  const fetcher = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(Library.createClient({
    fetch: fetcher,
    location: { protocol: 'http:', hostname: '127.0.0.1', port: '8765' },
    indexedDB: { open() { opened++; throw Error('must not create a replacement library'); } },
  }), error => {
    assert.equal(error.code, 'LIBRARY_CONNECTION');
    assert.equal(error.retryable, true);
    assert.match(error.message, /本地案例库服务未连接/);
    assert.match(error.message, /图纸尚未归档/);
    assert.match(error.message, /恢复服务后请重试保存/);
    assert.equal(error.message.includes('Failed to fetch'), false);
    return true;
  });
  assert.equal(opened, 0);
});

test('a connected SQLite adapter can retry the same save after a network outage without switching storage', async () => {
  let connected = true;
  let opened = 0;
  const writes = [];
  const c = await Library.createClient({
    location: { protocol: 'http:' },
    indexedDB: { open() { opened++; throw Error('must not switch storage'); } },
    fetch: async (url, options) => {
      if (!connected) throw new TypeError('Failed to fetch');
      if (url === '/api/library/info') return { ok: true, status: 200, json: async () => ({ backend: 'sqlite', path: '/test/persistent-library', case_count: 0 }) };
      writes.push(JSON.parse(options.body));
      return { ok: true, status: 201, json: async () => ({ case: { id: 'saved-case', version_count: 1 }, created: true, version_added: true }) };
    },
  });
  const payload = { pattern: makePattern(), source_data: IMAGE, preview_data: OTHER_IMAGE };
  connected = false;
  await assert.rejects(c.save(payload), error => error.code === 'LIBRARY_CONNECTION' && error.retryable === true);
  assert.equal(c.backend, 'sqlite');
  assert.equal(c.path, '/test/persistent-library');
  assert.equal(writes.length, 0);
  connected = true;
  const saved = await c.save(payload);
  assert.equal(saved.case.id, 'saved-case');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].source_data, IMAGE);
  assert.deepEqual(writes[0].pattern.cells, payload.pattern.cells);
  assert.equal(c.backend, 'sqlite');
  assert.equal(opened, 0);
});

test('request timeout aborts a stalled response body with a retryable Chinese status', async () => {
  let writeSignal;
  const c = await Library.createClient({
    location: { protocol: 'http:' }, timeoutMs: 15,
    fetch: async (url, options) => {
      if (url === '/api/library/info') return { ok: true, status: 200, json: async () => ({ backend: 'sqlite', path: '/test/library' }) };
      writeSignal = options.signal;
      return {
        ok: true, status: 201,
        json: () => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })),
      };
    },
  });
  await assert.rejects(c.save({ pattern: makePattern() }), error => {
    assert.equal(error.code, 'LIBRARY_TIMEOUT');
    assert.equal(error.retryable, true);
    assert.match(error.message, /连接超时/);
    assert.match(error.message, /尚未确认归档/);
    return true;
  });
  assert.equal(writeSignal.aborted, true);
  assert.equal(c.backend, 'sqlite');
});

test('an explicit fetch AbortError is presented as a retryable connection error', async () => {
  const c = await Library.createClient({
    location: { protocol: 'http:' },
    fetch: async url => {
      if (url === '/api/library/info') return { ok: true, status: 200, json: async () => ({ backend: 'sqlite', path: '/test/library' }) };
      throw new DOMException('The operation was aborted', 'AbortError');
    },
  });
  await assert.rejects(c.save({ pattern: makePattern() }), error => error.code === 'LIBRARY_CONNECTION' && /恢复服务后请重试保存/.test(error.message));
});

test('only file pages and explicit static API 404 select the browser library', async () => {
  function fakeIndexedDB(onOpen) {
    return { open() {
      onOpen();
      const request = {};
      queueMicrotask(() => { request.result = {}; request.onsuccess(); });
      return request;
    } };
  }
  let opened = 0;
  const indexedDB = fakeIndexedDB(() => opened++);
  const staticClient = await Library.createClient({
    location: { protocol: 'http:' }, indexedDB,
    fetch: async () => ({ ok: false, status: 404, json: async () => { throw new SyntaxError('HTML static page'); } }),
  });
  assert.equal(staticClient.backend, 'indexeddb');
  const fileClient = await Library.createClient({
    location: { protocol: 'file:' }, indexedDB,
    fetch: async () => { throw Error('file pages must not probe the API'); },
  });
  assert.equal(fileClient.backend, 'indexeddb');
  assert.equal(opened, 2);
  await assert.rejects(Library.createClient({
    location: { protocol: 'http:' }, indexedDB,
    fetch: async () => ({ ok: true, status: 200, json: async () => null }),
  }), /服务类型不受支持/);
  assert.equal(opened, 2);
});

test('initialization has a deadline even when a fetch implementation never settles', async () => {
  let opened = 0;
  await assert.rejects(Library.createClient({
    location: { protocol: 'http:' }, timeoutMs: 15,
    indexedDB: { open() { opened++; throw Error('must not create a replacement library'); } },
    fetch: () => new Promise(() => {}),
  }), error => error.code === 'LIBRARY_TIMEOUT' && error.retryable === true);
  assert.equal(opened, 0);
});
