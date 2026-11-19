const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'common.js'), 'utf8');
const start = source.indexOf('const reducedMotionQuery=');
const end = source.indexOf('function toast(', start);
assert.ok(start >= 0 && end > start, 'portal view transition helpers should exist');
const transitionSource = source.slice(start, end);

function createView(id, initiallyHidden = false) {
  const classes = new Set(initiallyHidden ? ['hidden'] : []);
  return {
    id,
    classList: {
      add(...names) { names.forEach(name => classes.add(name)); },
      remove(...names) { names.forEach(name => classes.delete(name)); },
      contains(name) { return classes.has(name); },
      toggle(name, force) {
        if (force === undefined) {
          if (classes.has(name)) classes.delete(name);
          else classes.add(name);
        } else if (force) classes.add(name);
        else classes.delete(name);
        return classes.has(name);
      }
    }
  };
}

function createMotionContext(animationsEnabled) {
  const views = [createView('login'), createView('dash', true)];
  const timers = [];
  let nextTimerId = 1;
  const context = {
    document: {
      documentElement: { dataset: { animations: animationsEnabled ? 'on' : 'off' } },
      querySelector(selector) {
        if (selector === '.view:not(.hidden)') return views.find(view => !view.classList.contains('hidden')) || null;
        throw new Error('Unexpected querySelector: ' + selector);
      },
      querySelectorAll(selector) {
        assert.equal(selector, '.view');
        return views;
      },
      getElementById(id) { return views.find(view => view.id === id) || null; }
    },
    window: { matchMedia: () => ({ matches: false }) },
    scrollTo() {},
    setTimeout(callback) {
      const id = nextTimerId++;
      timers.push({ id, callback });
      return id;
    },
    clearTimeout(id) {
      const timer = timers.find(item => item.id === id);
      if (timer) timer.cancelled = true;
    },
    $: selector => context.document.querySelector(selector),
    $$: selector => context.document.querySelectorAll(selector)
  };
  vm.runInNewContext(transitionSource, context, { filename: 'public/common.js:portal-transitions' });
  return {
    context,
    views,
    flushTimers() {
      for (const timer of timers) if (!timer.cancelled) timer.callback();
    }
  };
}

test('portal navigation works when Effects are switched off', () => {
  const { context, views } = createMotionContext(false);
  assert.doesNotThrow(() => context.show('dash'));
  assert.equal(views[0].classList.contains('hidden'), true);
  assert.equal(views[1].classList.contains('hidden'), false);
});

test('portal navigation completes the fade transition when Effects are on', () => {
  const { context, views, flushTimers } = createMotionContext(true);
  assert.doesNotThrow(() => context.show('dash'));
  assert.equal(views[1].classList.contains('view-entering'), true);
  flushTimers();
  assert.equal(views[0].classList.contains('hidden'), true);
  assert.equal(views[1].classList.contains('hidden'), false);
  assert.equal(views[1].classList.contains('view-entering'), false);
});

test('turning Effects off during a transition restores one visible view', () => {
  const { context, views } = createMotionContext(true);
  context.show('dash');
  assert.doesNotThrow(() => context.syncPortalMotion(false));
  assert.equal(views[0].classList.contains('hidden'), true);
  assert.equal(views[1].classList.contains('hidden'), false);
  assert.equal(views[1].classList.contains('view-entering'), false);
  assert.equal(views[1].classList.contains('view-leaving'), false);
});
