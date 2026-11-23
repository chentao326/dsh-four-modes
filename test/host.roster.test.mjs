/**
 * Offline roster-drift / custom-preset / argument-resolution tests for the Host
 * half of dsh-four-modes.
 *
 * host.test.mjs pins the switch mechanics (open-turn guards, per-session
 * serialization, series marks, failure paths). This file pins what the roster
 * itself may look like in a real deployment: custom presets appended after the
 * four shipped ones, rows the registry reports as `broken`, a roster missing
 * shipped presets, an empty (or not-an-array) roster wrapper, and the
 * resolveMode precedence ladder — exact id -> ptc/code alias -> display name ->
 * case-insensitive id prefix.
 *
 * Run with:
 *
 *   node test/host.roster.test.mjs
 */
import assert from 'node:assert/strict'
import { apply } from '../index.js'

/** The shipped preset roster a healthy deployment exposes. */
const SHIPPED = [
  { id: 'standard', name: '标准模式', isDefault: true },
  { id: 'code', name: 'PTC 模式' },
  { id: 'minimal', name: '极简模式' },
  { id: 'cordis', name: '创造模式' },
]

/** A user-authored preset that is not one of the four shipped modes. */
const CUSTOM = { id: 'my-mode', name: '我的模式' }

/** A roster whose PTC row fails to load: the registry marks it `broken`. */
const BROKEN_CODE = [
  { id: 'standard', name: '标准模式' },
  { id: 'code', name: 'PTC 模式', broken: 'preset failed to load: @dsh/ptc' },
  { id: 'minimal', name: '极简模式' },
  { id: 'cordis', name: '创造模式' },
]

/** A deployment that only carries two of the four shipped presets. */
const TWO_MODES = [
  { id: 'standard', name: '标准模式' },
  { id: 'code', name: 'PTC 模式' },
]

/** How many times the current-mode marker appears in a `/mode list` report. */
const currentMarks = (text) => (text.match(/（当前 \/ current）/g) ?? []).length

/**
 * The preset ids rendered after `可切换：`, in menu order.
 *
 * Both the success report (`可切换：a, b（当前 / current）。`) and the unknown-mode
 * error (`未知模式：x。可切换：a, b`) carry this prefix, so the same reader serves
 * both and asserts the two forms agree.
 *
 * @param text - a `/mode` result text.
 * @returns the listed preset ids with the current-mode marker stripped.
 */
function listedIds(text) {
  const match = /可切换：([^。]+)/.exec(text)
  assert.ok(match, `a switchable-mode list appears in: ${text}`)
  return match[1]
    .split(',')
    .map((entry) => entry.trim().replace(/（当前 \/ current）$/, ''))
}

/**
 * A tiny test harness that stands in for one Cordis plugin context.
 *
 * Mirrors the harness in host.test.mjs, narrowed to what roster tests need and
 * widened in two places: `roster` may be any array (including empty) and
 * `rosterRaw` lets a test return a malformed wrapper from
 * `remoteExportList()` verbatim.
 *
 * @param options - harness knobs.
 * @returns the mounted harness plus a `/mode` caller.
 */
function makeHarness(options = {}) {
  const handlers = new Map()
  const registered = []
  const appended = []
  const composed = []
  const sessionId = options.sessionId ?? 'session-1'
  const sessionModes = new Map([[sessionId, options.current ?? 'standard']])

  const state = {
    roster: options.roster ?? SHIPPED,
    // Present-but-undefined must still mean "return this verbatim", so use hasOwn.
    hasRosterRaw: Object.hasOwn(options, 'rosterRaw'),
    rosterRaw: options.rosterRaw,
    turnOpen: options.turnOpen ?? false,
    running: options.running ?? false,
    // Optional id override, to simulate a registry that binds a different id.
    recomposeResultId: options.recomposeResultId ?? null,
  }

  const sessionOf = (agentCtx) => agentCtx?.sessionId ?? sessionId

  const ctx = {
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    commands: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
    get(name) {
      // DSH 0.1.1-rc.2 services the plugin actually reads.
      if (name === 'sessionProjections') {
        return {
          stateOf(session, key) {
            if (key === 'turnBoundary') return { openTurnStartSeq: state.turnOpen ? 7 : null }
            if (key === 'agentPreset') return sessionModes.get(session?.id ?? sessionId)
            return undefined
          },
        }
      }
      return undefined
    },
    agentPresets: {
      async remoteExportList() {
        if (state.hasRosterRaw) return state.rosterRaw
        return { presets: state.roster }
      },
      async recompose(agentCtx, id) {
        composed.push(id)
        const bound =
          typeof state.recomposeResultId === 'function' ? state.recomposeResultId(id) : state.recomposeResultId ?? id
        sessionModes.set(sessionOf(agentCtx), bound)
        return { id: bound }
      },
      composedPreset(agentCtx) {
        return sessionModes.get(sessionOf(agentCtx))
      },
    },
    agents: {},
  }

  apply(ctx)

  const agent = {
    id: sessionId,
    status: state.running ? 'running' : 'inactive',
    ctx: { sessionId },
    session: {
      id: sessionId,
      append(event, payload) {
        appended.push({ event, payload })
      },
    },
  }

  const commandDefinition = () => {
    const definition = registered.find((entry) => entry.name === 'mode')
    assert.ok(definition, 'the /mode command is registered')
    return definition
  }

  return {
    state,
    handlers,
    registered,
    appended,
    composed,
    agent,
    modeOf: (id = sessionId) => sessionModes.get(id),
    /** Run the registered `/mode` command with one argument. */
    async call(rawInput) {
      return commandDefinition().handler({ agent, rawInput, signal: new AbortController().signal })
    },
  }
}

const tests = []
const test = (name, fn) => tests.push({ name, fn })

// ---------------------------------------------------------------------------
// Custom presets (roster drift in the "extra rows" direction)
// ---------------------------------------------------------------------------

test('a custom preset is ordered after the four shipped modes', async () => {
  // The raw roster deliberately puts the custom row first: menu order must come
  // from orderedModes (built-ins first), never from the registry's own order.
  const harness = makeHarness({ roster: [CUSTOM, ...SHIPPED] })
  const result = await harness.call('list')
  assert.equal(result.kind, 'success')
  assert.deepEqual(listedIds(result.text), ['standard', 'code', 'minimal', 'cordis', 'my-mode'])
  assert.deepEqual(harness.composed, [], 'listing never switches')
  assert.deepEqual(harness.appended, [])
})

test('/mode <custom-id> switches to the custom preset and logs it', async () => {
  const harness = makeHarness({ roster: [CUSTOM, ...SHIPPED] })
  const result = await harness.call('my-mode')
  assert.equal(result.kind, 'success')
  assert.deepEqual(harness.composed, ['my-mode'])
  assert.deepEqual(harness.appended, [{ event: 'agent-preset/selected', payload: { agentPreset: 'my-mode' } }])
  assert.match(result.text, /已切换到 我的模式/)
  assert.equal(harness.modeOf(), 'my-mode')
})

test('/mode next includes the custom preset in the rotation', async () => {
  const harness = makeHarness({ roster: [CUSTOM, ...SHIPPED], current: 'cordis' })
  assert.equal((await harness.call('next')).kind, 'success')
  assert.deepEqual(harness.composed, ['my-mode'], 'cordis -> custom')
  assert.equal(harness.modeOf(), 'my-mode')

  assert.equal((await harness.call('next')).kind, 'success')
  assert.deepEqual(harness.composed, ['my-mode', 'standard'], 'custom -> wraps back to standard')
  assert.equal(harness.modeOf(), 'standard')
  assert.deepEqual(
    harness.appended.map((entry) => entry.payload.agentPreset),
    ['my-mode', 'standard'],
  )
})

test('a custom preset resolves by display name and by case-insensitive id', async () => {
  const byName = makeHarness({ roster: [CUSTOM, ...SHIPPED] })
  assert.equal((await byName.call('我的模式')).kind, 'success')
  assert.deepEqual(byName.composed, ['my-mode'])

  // The registry may report a mixed-case id; resolution is case-insensitive and
  // the raw roster id is what gets recomposed/logged.
  const byCase = makeHarness({ roster: [...SHIPPED, { id: 'My-Mode', name: '我的模式' }] })
  assert.equal((await byCase.call('MY-MODE')).kind, 'success')
  assert.deepEqual(byCase.composed, ['My-Mode'])
})

test('a custom preset resolves by an unambiguous prefix', async () => {
  const harness = makeHarness({ roster: [CUSTOM, ...SHIPPED] })
  const result = await harness.call('my')
  assert.equal(result.kind, 'success')
  assert.deepEqual(harness.composed, ['my-mode'])
  assert.match(result.text, /已切换到 我的模式/)
})

// ---------------------------------------------------------------------------
// Broken roster rows
// ---------------------------------------------------------------------------

test('a roster row the registry reports as broken is filtered out', async () => {
  const harness = makeHarness({ roster: BROKEN_CODE })
  const result = await harness.call('list')
  assert.equal(result.kind, 'success')
  assert.deepEqual(listedIds(result.text), ['standard', 'minimal', 'cordis'])
  assert.ok(!result.text.includes('code'), 'the broken id is not offered')
  assert.equal(currentMarks(result.text), 1)
})

test('a broken preset cannot be switched to by id or by alias', async () => {
  for (const asked of ['code', 'ptc']) {
    const harness = makeHarness({ roster: BROKEN_CODE, current: 'cordis' })
    const result = await harness.call(asked)
    assert.equal(result.kind, 'error', `${asked} must not resolve`)
    assert.match(result.text, new RegExp(`未知模式：${asked}`))
    assert.deepEqual(listedIds(result.text), ['standard', 'minimal', 'cordis'])
    assert.deepEqual(harness.composed, [])
    assert.deepEqual(harness.appended, [])
  }
})

test('/mode next rotates over the usable roster only', async () => {
  const harness = makeHarness({
    roster: [SHIPPED[0], { id: 'code', name: 'PTC 模式', broken: 'x' }, SHIPPED[2], SHIPPED[3], CUSTOM],
    current: 'standard',
  })
  assert.equal((await harness.call('next')).kind, 'success')
  assert.deepEqual(harness.composed, ['minimal'], 'the broken code row is skipped')
})

// ---------------------------------------------------------------------------
// Roster missing shipped presets
// ---------------------------------------------------------------------------

test('a roster missing shipped presets lists only what it has', async () => {
  const harness = makeHarness({ roster: TWO_MODES })
  const result = await harness.call('list')
  assert.equal(result.kind, 'success')
  assert.deepEqual(listedIds(result.text), ['standard', 'code'])
  assert.ok(!result.text.includes('minimal'))
  assert.ok(!result.text.includes('cordis'))
})

test('a missing shipped preset reports unknown with the available ids', async () => {
  const harness = makeHarness({ roster: TWO_MODES })
  const result = await harness.call('minimal')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /未知模式：minimal/)
  assert.deepEqual(listedIds(result.text), ['standard', 'code'])
  assert.deepEqual(harness.composed, [])
})

test('/mode next rotates within a two-preset roster', async () => {
  const harness = makeHarness({ roster: TWO_MODES })
  assert.equal((await harness.call('next')).kind, 'success')
  assert.deepEqual(harness.composed, ['code'])
  assert.equal(harness.modeOf(), 'code')

  assert.equal((await harness.call('next')).kind, 'success')
  assert.deepEqual(harness.composed, ['code', 'standard'])
  assert.equal(harness.modeOf(), 'standard')
})

// ---------------------------------------------------------------------------
// Empty roster
// ---------------------------------------------------------------------------

test('an empty roster reports that nothing is switchable', async () => {
  const harness = makeHarness({ roster: [] })
  for (const rawInput of ['list', '', undefined, '   ']) {
    const result = await harness.call(rawInput)
    assert.equal(result.kind, 'success')
    assert.match(result.text, /当前模式：standard/)
    assert.match(result.text, /名册中没有可切换的模式/)
    assert.equal(currentMarks(result.text), 0)
  }
  assert.deepEqual(harness.composed, [])
  assert.deepEqual(harness.appended, [])
})

test('/mode next on an empty roster reports an error', async () => {
  const harness = makeHarness({ roster: [] })
  const result = await harness.call('next')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /名册中没有可切换的模式/)
  assert.deepEqual(harness.composed, [])
})

test('no preset id resolves against an empty roster', async () => {
  const harness = makeHarness({ roster: [] })
  for (const asked of ['standard', 'ptc', 's']) {
    const result = await harness.call(asked)
    assert.equal(result.kind, 'error')
    assert.match(result.text, /未知模式/)
    assert.deepEqual(harness.composed, [])
  }
})

// ---------------------------------------------------------------------------
// Argument resolution: alias / display name / casing
// ---------------------------------------------------------------------------

test('mode arguments accept display names, aliases, and any casing', async () => {
  const cases = [
    ['标准模式', 'standard'],
    ['极简模式', 'minimal'],
    ['创造模式', 'cordis'],
    ['PTC', 'code'],
    ['Ptc', 'code'],
    ['CODE', 'code'],
    ['  sTaNdArd ', 'standard'],
    ['StAnDaRd', 'standard'],
  ]
  for (const [asked, expected] of cases) {
    const harness = makeHarness({ current: expected === 'standard' ? 'cordis' : 'standard' })
    const result = await harness.call(asked)
    assert.equal(result.kind, 'success', `${JSON.stringify(asked)} resolves`)
    assert.deepEqual(harness.composed, [expected], `${JSON.stringify(asked)} -> ${expected}`)
    assert.equal(harness.appended.at(-1).payload.agentPreset, expected)
  }
})

test('an exact roster id wins over the alias mapping when both are present', async () => {
  // A transitional deployment may list both the old `ptc` id and the new `code`
  // id. Exact id matching must win; the alias only fills a missing id.
  const bothRows = [...SHIPPED, { id: 'ptc', name: 'PTC 模式' }]
  const exactPtc = makeHarness({ roster: bothRows, current: 'standard' })
  assert.equal((await exactPtc.call('ptc')).kind, 'success')
  assert.deepEqual(exactPtc.composed, ['ptc'], 'the exact ptc row, not the code alias')
  assert.deepEqual(exactPtc.appended, [{ event: 'agent-preset/selected', payload: { agentPreset: 'ptc' } }])

  // Same assertion with the raw order reversed: exact matching cannot be order luck.
  const reversed = [{ id: 'ptc', name: 'PTC 模式' }, ...SHIPPED]
  const exactCode = makeHarness({ roster: reversed, current: 'standard' })
  assert.equal((await exactCode.call('code')).kind, 'success')
  assert.deepEqual(exactCode.composed, ['code'], 'the exact code row, not the earlier ptc row')
})

test('/mode code resolves to a roster row that still uses the ptc id', async () => {
  const drifted = [
    { id: 'standard', name: '标准模式' },
    { id: 'ptc', name: 'PTC 模式' },
    { id: 'minimal', name: '极简模式' },
    { id: 'cordis', name: '创造模式' },
  ]
  const harness = makeHarness({ roster: drifted })
  const result = await harness.call('code')
  assert.equal(result.kind, 'success')
  assert.deepEqual(harness.composed, ['ptc'])
  assert.deepEqual(harness.appended, [{ event: 'agent-preset/selected', payload: { agentPreset: 'ptc' } }])
  assert.match(result.text, /已切换到 PTC 模式/)
})

test('an ambiguous one-letter prefix picks one match without throwing', async () => {
  const harness = makeHarness()
  const result = await harness.call('c') // `code` and `cordis` both prefix-match
  assert.equal(result.kind, 'success')
  assert.equal(harness.composed.length, 1)
  assert.ok(['code', 'cordis'].includes(harness.composed[0]))
  assert.equal(harness.appended.at(-1).payload.agentPreset, harness.composed[0])
  assert.equal(harness.modeOf(), harness.composed[0])
})

test('unambiguous prefixes resolve to exactly one preset', async () => {
  const cases = [
    ['sta', 'standard'],
    ['mi', 'minimal'],
    ['cor', 'cordis'],
  ]
  for (const [asked, expected] of cases) {
    const harness = makeHarness({ current: expected === 'standard' ? 'cordis' : 'standard' })
    const result = await harness.call(asked)
    assert.equal(result.kind, 'success', `${asked} resolves`)
    assert.deepEqual(harness.composed, [expected])
  }
})

test('letters that match no preset report unknown with the available ids', async () => {
  for (const asked of ['p', 'z']) {
    const harness = makeHarness({ current: 'standard' })
    const result = await harness.call(asked)
    assert.equal(result.kind, 'error', `${asked} must not resolve`)
    assert.match(result.text, new RegExp(`未知模式：${asked}。`))
    assert.deepEqual(listedIds(result.text), ['standard', 'code', 'minimal', 'cordis'])
    assert.deepEqual(harness.composed, [])
    assert.deepEqual(harness.appended, [])
  }
})

// ---------------------------------------------------------------------------
// Current-mode marker in /mode list
// ---------------------------------------------------------------------------

test('/mode list marks the current mode exactly once', async () => {
  for (const current of ['standard', 'code', 'minimal', 'cordis']) {
    const harness = makeHarness({ current })
    const result = await harness.call('list')
    assert.equal(result.kind, 'success')
    assert.equal(currentMarks(result.text), 1, `${current} is marked once`)
    assert.ok(result.text.includes(`${current}（当前 / current）`))
    // Removing the marked id leaves no marker at all: no other row was marked.
    const withoutMark = result.text.split(`${current}（当前 / current）`).join('')
    assert.equal(currentMarks(withoutMark), 0)
    assert.deepEqual(listedIds(result.text), ['standard', 'code', 'minimal', 'cordis'])
    assert.deepEqual(harness.composed, [])
    assert.deepEqual(harness.appended, [])
  }
})

test('/mode list marks a custom current mode exactly once', async () => {
  const harness = makeHarness({ roster: [CUSTOM, ...SHIPPED], current: 'my-mode' })
  const result = await harness.call('list')
  assert.equal(result.kind, 'success')
  assert.equal(currentMarks(result.text), 1)
  assert.ok(result.text.includes('my-mode（当前 / current）'))
  assert.deepEqual(listedIds(result.text), ['standard', 'code', 'minimal', 'cordis', 'my-mode'])
})

test('a current mode absent from the roster is reported but never marked', async () => {
  const harness = makeHarness({ roster: TWO_MODES, current: 'cordis' })
  const result = await harness.call('list')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /当前模式：cordis/)
  assert.equal(currentMarks(result.text), 0)
  assert.deepEqual(listedIds(result.text), ['standard', 'code'])
})

// ---------------------------------------------------------------------------
// Malformed roster wrapper
// ---------------------------------------------------------------------------

test('a roster wrapper that is not an array of presets reads as empty', async () => {
  // `remoteExportList()` can come back from a version whose shape differs (or a
  // service that detached mid-call): a missing/odd `presets` field must read as
  // an empty roster, not throw.
  const wrappers = [null, {}, { presets: null }, { presets: 'nope' }, { presets: {} }, SHIPPED]
  for (const rosterRaw of wrappers) {
    const harness = makeHarness({ rosterRaw })
    const listed = await harness.call('list')
    assert.equal(listed.kind, 'success')
    assert.match(listed.text, /当前模式：standard/)
    assert.match(listed.text, /名册中没有可切换的模式/)

    const next = await harness.call('next')
    assert.equal(next.kind, 'error')
    assert.match(next.text, /名册中没有可切换的模式/)

    const byId = await harness.call('standard')
    assert.equal(byId.kind, 'error')
    assert.match(byId.text, /未知模式：standard/)

    assert.deepEqual(harness.composed, [])
    assert.deepEqual(harness.appended, [])
  }
})

test('rows that are not objects are filtered; usable rows still switch', async () => {
  const harness = makeHarness({
    rosterRaw: {
      presets: [null, undefined, 'junk', 42, true, { id: 'standard', name: '标准模式' }, { id: 'minimal', name: '极简模式' }],
    },
  })
  const listed = await harness.call('list')
  assert.equal(listed.kind, 'success')
  assert.deepEqual(listedIds(listed.text), ['standard', 'minimal'])

  const switched = await harness.call('minimal')
  assert.equal(switched.kind, 'success')
  assert.deepEqual(harness.composed, ['minimal'])
})

test('presets whose ids collide with the list/next keywords stay reportable', async () => {
  // `list` and `next` are reserved words in switchMode(): a preset with either
  // id cannot be selected by its bare id, but must still be listed and must not
  // break the keyword behaviour.
  const reserved = [...SHIPPED, { id: 'list', name: '清单模式' }, { id: 'next', name: '下一个模式' }]
  const harness = makeHarness({ roster: reserved })

  const listed = await harness.call('list')
  assert.equal(listed.kind, 'success', 'the list keyword still reports instead of switching')
  assert.deepEqual(listedIds(listed.text), ['standard', 'code', 'minimal', 'cordis', 'list', 'next'])
  assert.deepEqual(harness.composed, [])

  const rotated = await harness.call('next')
  assert.equal(rotated.kind, 'success')
  assert.deepEqual(harness.composed, ['code'], 'next rotates; it does not select the preset named next')

  // Such a preset is still reachable through any non-keyword spelling.
  assert.equal((await harness.call('Li')).kind, 'success')
  assert.deepEqual(harness.composed, ['code', 'list'])
  assert.equal(harness.modeOf(), 'list')
})

test('roster rows without a usable id are filtered out', async () => {
  // A row with no id would otherwise render as `undefined` and reach recompose.
  const dirty = [
    ...SHIPPED,
    {},
    { name: '无名模式' },
    { id: '', name: '空 id' },
    { id: '   ', name: '空白 id' },
    { id: 7, name: '数字 id' },
  ]
  const harness = makeHarness({ roster: dirty, current: 'standard' })
  const listed = await harness.call('list')
  assert.equal(listed.kind, 'success')
  assert.deepEqual(listedIds(listed.text), ['standard', 'code', 'minimal', 'cordis'])

  const next = await harness.call('next')
  assert.equal(next.kind, 'success')
  assert.deepEqual(harness.composed, ['code'], 'next never targets an id-less row')
})

test('a truthy non-string broken marker also filters the row', async () => {
  // The registry's `broken` reason is normally a string, but a boolean/object
  // marker must not sneak a preset into the roster.
  const dirty = [
    { id: 'standard', name: '标准模式' },
    { id: 'code', name: 'PTC 模式', broken: true },
    { id: 'minimal', name: '极简模式', broken: { reason: 'load failed' } },
    { id: 'cordis', name: '创造模式' },
  ]
  const harness = makeHarness({ roster: dirty, current: 'standard' })
  const listed = await harness.call('list')
  assert.deepEqual(listedIds(listed.text), ['standard', 'cordis'])
  const byId = await harness.call('minimal')
  assert.equal(byId.kind, 'error', 'a broken row cannot be selected')
  assert.match(byId.text, /未知模式：minimal/)
})

test('duplicate custom preset ids are listed once', async () => {
  const duplicated = [...SHIPPED, CUSTOM, { id: 'my-mode', name: '我的模式（另一个）' }]
  const harness = makeHarness({ roster: duplicated, current: 'standard' })
  const listed = await harness.call('list')
  const ids = listedIds(listed.text)
  assert.deepEqual(ids, ['standard', 'code', 'minimal', 'cordis', 'my-mode'])
  assert.equal(ids.filter((id) => id === 'my-mode').length, 1)
})

test('the list and next keywords are case-insensitive', async () => {
  for (const asked of ['LIST', 'List', 'list']) {
    const harness = makeHarness({ current: 'standard' })
    const result = await harness.call(asked)
    assert.equal(result.kind, 'success', `${asked} reports instead of erroring`)
    assert.match(result.text, /当前模式：standard/)
    assert.deepEqual(harness.composed, [], `${asked} must not switch`)
  }
  for (const asked of ['NEXT', 'Next', 'next']) {
    const harness = makeHarness({ current: 'standard' })
    const result = await harness.call(asked)
    assert.equal(result.kind, 'success', `${asked} rotates instead of erroring`)
    assert.deepEqual(harness.composed, ['code'])
  }
})

test('a roster display name is matched after trimming', async () => {
  const spaced = [...SHIPPED, { id: 'my-mode', name: '  我的模式  ' }]
  const harness = makeHarness({ roster: spaced, current: 'standard' })
  const result = await harness.call('我的模式')
  assert.equal(result.kind, 'success', 'the padded display name resolves')
  assert.deepEqual(harness.composed, ['my-mode'])
})

test('the shipped English names resolve like their ids', async () => {
  const cases = [
    ['Standard', 'standard', 'cordis'],
    ['PTC', 'code', 'standard'],
    ['Minimal', 'minimal', 'standard'],
    ['Creator', 'cordis', 'standard'],
  ]
  for (const [asked, expected, current] of cases) {
    const harness = makeHarness({ current })
    const result = await harness.call(asked)
    assert.equal(result.kind, 'success', `${asked} resolves`)
    assert.deepEqual(harness.composed, [expected])
  }
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
