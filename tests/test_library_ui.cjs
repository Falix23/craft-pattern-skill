'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../assets/library-ui.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));

function snapshot(name = 'A', documentID = 1) {
  return {
    pattern: {
      version: 2, title: 'Synthetic ' + name, mode: 'bead', width: 4, height: 4,
      palette: [{ id: 'LIGHT', hex: '#FFFFFF' }, { id: 'DARK', hex: '#000000' }],
      cells: [1, ...Array(15).fill(null)], source: { name: name + '.png', fit: 'contain' },
    },
    source_data: 'data:image/png;base64,' + Buffer.from('source-' + name).toString('base64'),
    preview_data: 'data:image/png;base64,' + Buffer.from('preview-' + name).toString('base64'),
    document_id: documentID,
    editor_revision: 1,
  };
}

function fakeDOM() {
  const elements = new Map();
  function get(selector) {
    if (!elements.has(selector)) {
      const classes = new Set();
      let text = '';
      const element = {
        hidden: selector === '#archive-retry', disabled: false, value: '', style: {},
        textHistory: [],
        classList: {
          toggle(name, force) {
            const enabled = force === undefined ? !classes.has(name) : force;
            if (enabled) classes.add(name); else classes.delete(name);
            return enabled;
          },
          contains: name => classes.has(name),
        },
        addEventListener() {}, setAttribute() {}, replaceChildren() {}, append() {},
      };
      Object.defineProperty(element, 'textContent', {
        get: () => text,
        set: value => { text = String(value); element.textHistory.push(text); },
      });
      elements.set(selector, element);
    }
    return elements.get(selector);
  }
  return { get, document: { querySelector: get } };
}

function harness(createClient, initial = snapshot(), customSnapshot) {
  const dom = fakeDOM();
  const archived = [];
  let current = initial;
  let dirty = true;
  const editor = {
    snapshot: () => customSnapshot ? customSnapshot(current) : Promise.resolve(current),
    documentId: () => current.document_id,
    isDirty: () => dirty,
    archived(value) {
      archived.push(value);
      if (value.document_id === current.document_id && value.editor_revision === current.editor_revision) dirty = false;
    },
  };
  const context = vm.createContext({
    document: dom.document,
    window: { scrollTo() {} },
    CaseLibrary: { createClient },
    setTimeout, clearTimeout,
  });
  vm.runInContext(source, context, { filename: 'library-ui.js' });
  const ui = context.CaseLibraryUI.mount(editor);
  return {
    ui, get: dom.get, archived, isDirty: () => dirty,
    setCurrent(value) { current = value; dirty = true; },
  };
}

function savedCase(number = 1) {
  return { case: { id: 'synthetic-case-' + number, version_count: 1 }, created: true, version_added: true };
}

test('an initialization refusal can reconnect on archive without discarding the current drawing', async () => {
  let attempts = 0;
  const writes = [];
  const client = {
    backend: 'sqlite',
    info: async () => ({ case_count: writes.length }),
    save: async payload => { writes.push(clone(payload)); return savedCase(); },
  };
  const drawing = snapshot();
  const h = harness(async () => {
    if (++attempts === 1) throw Error('Synthetic connection refusal');
    return client;
  }, drawing);

  await assert.rejects(h.ui.ready, /connection refusal/);
  assert.equal(h.get('#archive-retry').hidden, false);
  assert.equal(h.isDirty(), true);
  assert.equal(h.archived.length, 0);

  const result = await h.ui.archive();
  assert.equal(result.case.id, 'synthetic-case-1');
  assert.equal(attempts, 2);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].pattern, drawing.pattern);
  assert.equal(writes[0].source_data, drawing.source_data);
  assert.equal(h.archived[0], drawing);
  assert.equal(h.isDirty(), false);
  assert.equal(h.get('#archive-retry').hidden, true);
});

test('the retry button saves the same drawing and source after a failed write, then clears dirty state', async () => {
  const writes = [];
  let attempts = 0;
  const h = harness(async () => ({
    backend: 'sqlite', info: async () => ({ case_count: 1 }),
    save: async payload => {
      writes.push(clone(payload));
      if (++attempts === 1) throw Error('Synthetic write outage');
      return savedCase();
    },
  }));
  await h.ui.ready;

  await assert.rejects(h.ui.archive(), /write outage/);
  assert.equal(h.isDirty(), true);
  assert.equal(h.archived.length, 0);
  const retry = h.get('#archive-retry');
  assert.equal(retry.hidden, false);

  await retry.onclick();
  assert.equal(attempts, 2);
  assert.deepEqual(writes[1], writes[0]);
  assert.equal(h.archived.length, 1);
  assert.equal(h.isDirty(), false);
  assert.equal(retry.hidden, true);
  assert.equal(retry.disabled, false);
});

test('a failed count refresh does not reject an already committed save or mark it unsaved', async () => {
  let infoCalls = 0;
  let commits = 0;
  const h = harness(async () => ({
    backend: 'sqlite',
    info: async () => {
      if (++infoCalls > 1) throw Error('Synthetic count refresh outage');
      return { case_count: 0 };
    },
    save: async () => { commits++; return savedCase(); },
  }));
  await h.ui.ready;

  const result = await h.ui.archive();
  assert.equal(result.version_added, true);
  assert.equal(commits, 1);
  assert.equal(infoCalls, 2);
  assert.equal(h.archived.length, 1);
  assert.equal(h.isDirty(), false);
  assert.equal(h.get('#archive-retry').hidden, true);
  assert.equal(h.get('#archive-state').style.color, '');
  assert.equal(h.get('#archive-state').textHistory.some(text => /未能保存|尚未归档/.test(text)), false);
  assert.match(h.get('#library-message').textContent, /已保存.*刷新/);
});

test('queued archives keep each captured pattern paired with its own source and preview', async () => {
  let finishFirst;
  const firstSnapshot = new Promise(resolve => { finishFirst = resolve; });
  const writes = [];
  const first = snapshot('A', 1);
  const second = snapshot('B', 2);
  const h = harness(async () => ({
    backend: 'sqlite', info: async () => ({ case_count: writes.length }),
    save: async payload => { writes.push(clone(payload)); return savedCase(writes.length); },
  }), first, current => current.document_id === 1 ? firstSnapshot : Promise.resolve(current));
  await h.ui.ready;

  const savingFirst = h.ui.archive();
  h.setCurrent(second);
  const savingSecond = h.ui.archive();
  finishFirst(first);
  const results = await Promise.all([savingFirst, savingSecond]);

  assert.equal(results.length, 2);
  assert.equal(writes.length, 2);
  for (const [index, drawing] of [first, second].entries()) {
    assert.deepEqual(writes[index].pattern, drawing.pattern);
    assert.equal(writes[index].source_data, drawing.source_data);
    assert.equal(writes[index].preview_data, drawing.preview_data);
  }
  assert.deepEqual(h.archived, [second]);
  assert.equal(h.isDirty(), false);
});
