import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUiDomain, compileHandler, UI_EVENTS, UI_MODES } from '../lib/ui.js';

test('hook: a function handler is stored as source and reports its compile kind', () => {
  const ui = createUiDomain();
  const rule = ui.add({ selector: '.toolbar button', handler: function (ctx) { ctx.stop(); } });
  assert.equal(rule.event, 'click');
  assert.equal(rule.mode, 'before');
  assert.equal(rule.handlerKind, 'expression');
  assert.match(ui.serialize().rules[0].handler, /function/);
});

test('hook: a string handler is compiled as a body', () => {
  const ui = createUiDomain();
  const rule = ui.add({ selector: 'text=继续', mode: 'block', handler: 'event.preventDefault();' });
  assert.equal(rule.handlerKind, 'body');
  assert.equal(ui.serialize().rules[0].mode, 'block');
});

test('serialize: only enabled rules travel and the version moves on every change', () => {
  const ui = createUiDomain();
  const first = ui.add({ selector: '.a', handler: 'noop();' });
  ui.add({ selector: '.b', handler: 'noop();', enabled: false });
  assert.equal(ui.serialize().rules.length, 1);
  const before = ui.version;
  ui.remove(first.id);
  assert.equal(ui.version, before + 1);
  assert.equal(ui.serialize().rules.length, 0);
});

test('hit: counts hits and drops a once rule', () => {
  const ui = createUiDomain();
  const rule = ui.add({ selector: '.once', once: true, handler: 'noop();' });
  ui.hit(rule.id);
  assert.equal(ui.has(rule.id), false);
  assert.equal(ui.hit(rule.id), false);
});

test('hook: invalid selectors, events, modes and handlers are BAD_ARGUMENT', () => {
  const ui = createUiDomain();
  assert.throws(() => ui.add({ selector: '', handler: 'x();' }), (error) => error.code === 'BAD_ARGUMENT');
  assert.throws(() => ui.add({ selector: '.a', event: 'hover', handler: 'x();' }), /unsupported event/);
  assert.throws(() => ui.add({ selector: '.a', mode: 'maybe', handler: 'x();' }), /unsupported mode/);
  assert.throws(() => ui.add({ selector: '.a', handler: 'function (' }), /does not compile/);
  assert.throws(() => ui.add({ selector: '.a' }), /handler must be/);
});

test('hook: the rule limit is CONFLICT and removeBySource drops one script worth of rules', () => {
  const ui = createUiDomain({ limit: 2 });
  ui.add({ selector: '.a', handler: 'x();', source: 'script:one' });
  ui.add({ selector: '.b', handler: 'x();', source: 'script:one' });
  assert.throws(() => ui.add({ selector: '.c', handler: 'x();' }), (error) => error.code === 'CONFLICT');
  assert.equal(ui.removeBySource('script:one'), 2);
  assert.equal(ui.size, 0);
});

test('compileHandler: both forms run with ctx and event in scope', () => {
  const expression = compileHandler('function (ctx, event) { return event.type + ":" + typeof ctx.stop; }');
  assert.equal(expression.kind, 'expression');
  assert.equal(expression.fn({ stop() {} }, { type: 'click' }), 'click:function');
  const body = compileHandler('return ctx.marker;');
  assert.equal(body.kind, 'body');
  assert.equal(body.fn({ marker: 'ok' }, {}), 'ok');
});

test('constants: the documented event and mode lists are the accepted ones', () => {
  assert.equal(UI_EVENTS.includes('click'), true);
  assert.equal(UI_MODES.join(','), 'before,after,replace,block');
});
