/**
 * Offline contract tests for the Client half of dsh-four-modes.
 *
 * Loads client.js in a sandbox that stands in for the browser globals: a fake
 * `window.__ModuleLoader__`, a minimal React mock, and fake slot/remote
 * services. It proves that:
 *   - the bundle registers a factory under the expected module id,
 *   - the factory materializes without throwing,
 *   - `apply(ctx)` registers one conversation.input.left occupant,
 *   - the registered component renders for each live mode without throwing.
 *
 * Run with: node test/client.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

/** Counts useState calls inside one component render (reset before each render). */
let stateCall = 0

/**
 * Minimal React stand-in: enough for createElement + hooks used by the control.
 * The second useState call is the menu `open` flag; forcing it true lets the
 * interaction tests reach the menu without a real hook runtime.
 */
const React = {
  createElement: (type, props, ...children) => ({ type, props, children: children.flat() }),
  useState: (initial) => {
    stateCall += 1
    const seed = typeof initial === 'function' ? initial() : initial
    return [stateCall === 2 ? true : seed, () => {}]
  },
  useEffect: () => {},
  useRef: (value) => ({ current: value ?? null }),
}

/** Fake slot/remote services the client half injects. */
function makeCtx() {
  const registered = []
  const injected = []
  const executeCalls = []
  const selectCalls = []
  const remote = {
    agentPresets: {
      async list() {
        return {
          ok: true,
          value: {
            presets: [
              { id: 'standard', name: '标准模式', isDefault: true },
              { id: 'code', name: 'PTC 模式' },
              { id: 'minimal', name: '极简模式' },
              { id: 'cordis', name: '创造模式' },
            ],
          },
        }
      },
    },
    commands: {
      async execute(sessionId, line) {
        executeCalls.push({ sessionId, line })
        return { ok: true, value: { result: { kind: 'success', text: 'ok' } } }
      },
    },
    session: {
      async selectModel(selection) {
        selectCalls.push(selection)
        return { ok: true, value: { selected: selection } }
      },
    },
  }
  const ctx = {
    get(name) {
      if (name === 'remote') return remote
      return undefined
    },
    slots: {
      inject(slotName, callback) {
        injected.push(slotName)
        return callback()
      },
      register(options, component) {
        registered.push({ options, component })
        return () => {}
      },
    },
  }
  return { ctx, registered, injected, executeCalls, selectCalls }
}

// Sandbox: client.js calls window.__ModuleLoader__.load({ id, factory }).
const loads = []
const fakeWindow = {
  __ModuleLoader__: {
    load(registration) {
      loads.push(registration)
    },
  },
}
// The component reads window.innerWidth only while a menu is open; a plain value is enough.
globalThis.window = Object.assign(fakeWindow, { innerWidth: 1440 })
// Minimal document so installStyle() can no-op safely if a hook ever runs.
globalThis.document = {
  documentElement: { lang: 'zh-CN' },
  getElementById: () => null,
  createElement: () => ({ set id(v) {}, set textContent(v) {}, remove() {} }),
  head: { appendChild() {} },
  addEventListener() {},
  removeEventListener() {},
}
// Per-mode model memory lives in localStorage; a Map-backed stand-in is enough.
const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
}

// Execute the bundle as a classic script.
new Function('window', source)(globalThis.window)

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('registers exactly one factory under the bundle id', () => {
  assert.equal(loads.length, 1)
  assert.equal(loads[0].id, 'dsh-four-modes')
  assert.equal(typeof loads[0].factory, 'function')
})

const exports = loads[0].factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require(${name})`)
})

test('exports inject + apply', () => {
  assert.ok(Array.isArray(exports.inject))
  assert.equal(typeof exports.apply, 'function')
  assert.ok(exports.inject.includes('slots'))
  assert.ok(exports.inject.includes('remote'))
  // `remote.commands` MUST be injected: the namespace is not reachable through
  // lazy ctx.remote access otherwise (this was the "menu click does nothing" bug).
  assert.ok(exports.inject.includes('remote.commands'))
})

const { ctx, registered, injected, selectCalls } = makeCtx()
exports.apply(ctx)

test('apply injects into conversation.input.left and registers one occupant', () => {
  assert.deepEqual(injected, ['conversation.input.left'])
  assert.equal(registered.length, 1)
  // Both fields are required by the live slot system: `name` selects the slot,
  // `id` is this entry's cell key (verified against DSH 0.1.1-rc.2 runtime).
  assert.equal(registered[0].options.name, 'conversation.input.left')
  assert.equal(registered[0].options.id, 'four-modes')
  assert.equal(typeof registered[0].component, 'function')
})

const Control = registered[0].component

test('renders the current mode for a live session', () => {
  const useSessions = (selector) =>
    selector({ byId: { s1: { projectionValues: { agentPreset: 'code' }, running: false } } })
  const tree = Control({ sessionId: 's1', useSessions })
  assert.equal(tree.type, 'div')
  const chip = tree.children[0]
  assert.equal(chip.type, 'button')
  assert.equal(chip.props.disabled, false)
  // The visible label follows the roster row (PTC 模式) rather than a hard-coded id.
  const nameNode = chip.children.find((child) => child && child.props && child.props.className === 'dshfm-chip-name')
  assert.equal(nameNode.children[0], 'PTC 模式')
})

test('disables the control while the session is running', () => {
  const useSessions = (selector) =>
    selector({ byId: { s1: { projectionValues: { agentPreset: 'standard' }, running: true } } })
  const tree = Control({ sessionId: 's1', useSessions })
  const chip = tree.children[0]
  assert.equal(chip.props.disabled, true)
})

test('renders without a session (inert state)', () => {
  const useSessions = (selector) => selector(undefined)
  const tree = Control({ sessionId: undefined, useSessions })
  const chip = tree.children[0]
  assert.equal(chip.props.disabled, true)
  assert.ok(tree)
})

test('shows the remembered model and applies it on switch', async () => {
  // Force the menu open for this render (second useState call).
  stateCall = 0
  storage.set('dsh-four-modes.models.v1', JSON.stringify({ standard: { provider: 'p', model: 'm1' } }))
  const useSessions = (selector) =>
    selector({ byId: { s1: { projectionValues: { agentPreset: 'minimal' }, running: false } } })
  const tree = Control({ sessionId: 's1', useSessions })
  const menu = tree.children.find((child) => child && child.props && child.props.className === 'dshfm-menu')
  assert.ok(menu, 'menu is rendered (open forced for the test)')
  const standardItem = menu.children.find((child) => child && child.props && child.props.key === 'standard')
  assert.ok(standardItem, 'standard item exists')
  const main = standardItem.children.find((child) => child && child.props && child.props.className === 'dshfm-item-main')
  const hint = main.children.find((child) => child && child.props && child.props.className === 'dshfm-item-hint')
  assert.match(hint.children[0], /m1/)
  await standardItem.props.onClick()
  assert.equal(selectCalls.length, 1)
  assert.deepEqual(selectCalls[0], { sessionId: 's1', provider: 'p', model: 'm1' })
})

let failed = 0
for (const { name, fn } of tests) {
  try {
    await fn()
    console.log(`PASS ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${name}`)
    console.log(error instanceof Error ? error.stack : String(error))
  }
}
console.log(failed === 0 ? `\n${tests.length} tests passed` : `\n${failed} of ${tests.length} tests failed`)
process.exitCode = failed === 0 ? 0 : 1
