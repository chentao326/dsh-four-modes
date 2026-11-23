/**
 * Offline contract tests for the Host half of dsh-four-modes.
 *
 * Mocks the Cordis services the plugin injects (`commands`, `agentPresets`,
 * `agents`) and exercises the `/mode` command handler plus the
 * `agent/pre-step` / `agent/disposed` listeners. Run with:
 *
 *   node test/host.test.mjs
 */
import assert from 'node:assert/strict'
import { apply } from '../index.js'

/** The shipped preset roster the mocked registry exposes. */
const DEFAULT_ROSTER = [
  { id: 'standard', name: '标准模式', isDefault: true },
  { id: 'code', name: 'PTC 模式' },
  { id: 'minimal', name: '极简模式' },
  { id: 'cordis', name: '创造模式' },
]

/** Let already-queued microtasks and timers settle before asserting. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** A tiny test harness that stands in for one Cordis plugin context. */
function makeHarness(options = {}) {
  const handlers = new Map()
  const registered = []
  const appended = []
  const composed = []

  // Per-Session current preset, so multi-session isolation is observable.
  const initialModes = options.sessionModes ?? { 'session-1': options.current ?? 'standard' }
  const sessionModes = new Map(Object.entries(initialModes))
  const primarySessionId = options.primarySessionId ?? sessionModes.keys().next().value ?? 'session-1'

  const state = {
    roster: options.roster ?? DEFAULT_ROSTER,
    turnOpen: options.turnOpen ?? false,
    rosterThrows: options.rosterThrows ?? null,
    recomposeThrows: options.recomposeThrows ?? null,
    recomposeThrowsAfterBind: options.recomposeThrowsAfterBind ?? false,
    // Optional id override: lets a test simulate id drift where the registry
    // binds a different preset than the one requested.
    recomposeResultId: options.recomposeResultId ?? null,
    // Optional hook awaited inside `recompose`, used to widen the concurrency window.
    onRecompose: options.onRecompose ?? null,
    // Durable-log fixtures: a per-Session seed, and a one-shot append failure.
    seedLogs: options.seedLogs ?? {},
    appendThrowsOnce: options.appendThrowsOnce ?? false,
    appendFailures: 0,
    events: [],
    inFlight: 0,
    maxInFlight: 0,
    modes: sessionModes,
    get current() {
      return sessionModes.get(primarySessionId)
    },
    set current(value) {
      sessionModes.set(primarySessionId, value)
    },
  }

  const sessionOf = (agentCtx) => agentCtx?.sessionId ?? primarySessionId

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
      // DSH 0.1.1-rc.2: turn state lives on the session-projections service and
      // the authoritative preset read on the session controller.
      if (name === 'sessionProjections') {
        return {
          stateOf(session, key) {
            if (key === 'turnBoundary') return { openTurnStartSeq: state.turnOpen ? 7 : null }
            if (key === 'agentPreset') return sessionModes.get(session?.id ?? primarySessionId)
            return undefined
          },
        }
      }
      return undefined
    },
    agentPresets: {
      async remoteExportList() {
        if (state.rosterThrows !== null) throw state.rosterThrows
        return { presets: state.roster }
      },
      async recompose(agentCtx, id) {
        const sessionId = sessionOf(agentCtx)
        state.inFlight += 1
        state.maxInFlight = Math.max(state.maxInFlight, state.inFlight)
        state.events.push(`start:${id}`)
        try {
          if (state.recomposeThrowsAfterBind === true) {
            // Simulate `bind()` landing before the await throws.
            sessionModes.set(sessionId, id)
            throw state.recomposeThrows ?? new Error('bind failed')
          }
          if (state.recomposeThrows !== null) throw state.recomposeThrows
          if (typeof state.onRecompose === 'function') await state.onRecompose(id, sessionId)
          composed.push(id)
          const resultId =
            typeof state.recomposeResultId === 'function' ? state.recomposeResultId(id) : state.recomposeResultId ?? id
          sessionModes.set(sessionId, resultId)
          return { id: resultId }
        } finally {
          state.events.push(`end:${id}`)
          state.inFlight -= 1
        }
      },
      composedPreset(agentCtx) {
        return sessionModes.get(sessionOf(agentCtx))
      },
    },
    agents: {},
  }

  apply(ctx)

  const makeAgent = (sessionId) => ({
    id: sessionId,
    status: options.running === true ? 'running' : 'inactive',
    ctx: { sessionId },
    session: {
      id: sessionId,
      // Durable-log stand-in: `append` writes one {type,data} row, matching the
      // shape the Host half reads back for the repair decision.
      log: [...(state.seedLogs[sessionId] ?? [])],
      append(event, payload) {
        if (state.appendThrowsOnce && state.appendFailures === 0) {
          state.appendFailures += 1
          throw new Error('append failed (injected)')
        }
        appended.push({ event, payload })
        this.log.push({ type: event, data: payload })
      },
    },
  })

  const agents = [
    makeAgent(primarySessionId),
    ...[...sessionModes.keys()].filter((id) => id !== primarySessionId).map((id) => makeAgent(id)),
  ]
  const agent = agents[0]
  const agentsById = new Map(agents.map((entry) => [entry.id, entry]))
  const modeOf = (sessionId) => sessionModes.get(sessionId)

  const commandDefinition = () => {
    const definition = registered.find((entry) => entry.name === 'mode')
    assert.ok(definition, 'the /mode command is registered')
    return definition
  }

  return {
    state,
    registered,
    appended,
    composed,
    handlers,
    agent,
    agents,
    agentsById,
    modeOf,
    /** Run the registered `/mode` command with one argument. */
    async call(rawInput) {
      return commandDefinition().handler({ agent, rawInput, signal: new AbortController().signal })
    },
    /** Same, but addressed to a specific Agent (multi-session tests). */
    async callAs(target, rawInput) {
      return commandDefinition().handler({ agent: target, rawInput, signal: new AbortController().signal })
    },
  }
}

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('registers /mode with an input hint', () => {
  const harness = makeHarness()
  assert.equal(harness.registered.length, 1)
  assert.equal(harness.registered[0].name, 'mode')
  assert.match(harness.registered[0].input.hint, /standard/)
})

test('/mode list reports current and all four modes', async () => {
  const harness = makeHarness()
  const result = await harness.call('list')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /standard/)
  assert.match(result.text, /code/)
  assert.match(result.text, /minimal/)
  assert.match(result.text, /cordis/)
})

test('/mode ptc maps to the shipped code preset id', async () => {
  const harness = makeHarness()
  const result = await harness.call('ptc')
  assert.equal(result.kind, 'success')
  assert.deepEqual(harness.composed, ['code'])
  assert.deepEqual(harness.appended, [{ event: 'agent-preset/selected', payload: { agentPreset: 'code' } }])
})

test('/mode standard switches and logs the bound identity', async () => {
  const harness = makeHarness({ current: 'code' })
  const result = await harness.call('standard')
  assert.equal(result.kind, 'success')
  assert.deepEqual(harness.composed, ['standard'])
  assert.equal(harness.appended.at(-1).payload.agentPreset, 'standard')
})

test('/mode next rotates from the current mode', async () => {
  const harness = makeHarness({ current: 'standard' })
  await harness.call('next')
  assert.deepEqual(harness.composed, ['code'])
})

test('an open turn refuses the switch', async () => {
  const harness = makeHarness({ turnOpen: true })
  const result = await harness.call('minimal')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /正在执行|running/)
  assert.deepEqual(harness.composed, [])
})

test('a running agent status also refuses', async () => {
  const harness = makeHarness({ running: true })
  const result = await harness.call('cordis')
  assert.equal(result.kind, 'error')
  assert.deepEqual(harness.composed, [])
})

test('unknown mode reports the switchable ids', async () => {
  const harness = makeHarness()
  const result = await harness.call('nope')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /standard, code, minimal, cordis/)
})

test('a failed recompose is reported and does not log success', async () => {
  const harness = makeHarness({ recomposeThrows: new Error('boom') })
  const result = await harness.call('minimal')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /失败/)
  assert.deepEqual(harness.appended, [])
})

test('interrupted recompose that still landed logs the switch', async () => {
  const harness = makeHarness({
    recomposeThrowsAfterBind: true,
    recomposeThrows: new Error('collection failed'),
  })
  const result = await harness.call('cordis')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /已切换到 创造模式/)
  assert.deepEqual(harness.appended, [{ event: 'agent-preset/selected', payload: { agentPreset: 'cordis' } }])
  assert.equal(harness.state.current, 'cordis')
})

test('agent/pre-step marks the next admitted request as a new series', async () => {
  const harness = makeHarness()
  // Trigger a switch so the series mark is armed.
  await harness.call('minimal')
  const preStep = harness.handlers.get('agent/pre-step')
  assert.ok(preStep, 'the pre-step listener is registered')
  const payload = { agent: harness.agent, signal: { aborted: false } }
  const decision = { kind: 'enter', messages: [{ role: 'user' }] }
  const result = await preStep(payload, async () => decision)
  assert.equal(result.startsRequestSeries, true)
  // Second step: the mark is consumed.
  const again = await preStep(payload, async () => decision)
  assert.equal(again.startsRequestSeries, undefined)
})

// ---------------------------------------------------------------------------
// Concurrency and isolation
// ---------------------------------------------------------------------------

test('concurrent /mode calls on one session serialize their recompose', async () => {
  const harness = makeHarness({
    current: 'code',
    onRecompose: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
    },
  })

  // Started in the same tick: without the per-session chain all three would be
  // in flight at once and the bind order could differ from the log order.
  const [first, second, third] = await Promise.all([
    harness.call('minimal'),
    harness.call('cordis'),
    harness.call('standard'),
  ])

  for (const result of [first, second, third]) assert.equal(result.kind, 'success')
  assert.deepEqual(harness.composed, ['minimal', 'cordis', 'standard'])
  // Exactly one recompose at a time.
  assert.equal(harness.state.maxInFlight, 1)
  // Each call ran to completion with a balanced start/end pair.
  assert.deepEqual(harness.state.events, [
    'start:minimal',
    'end:minimal',
    'start:cordis',
    'end:cordis',
    'start:standard',
    'end:standard',
  ])
  // The live composition and the last logged fact agree.
  assert.equal(harness.state.current, 'standard')
  assert.equal(harness.modeOf('session-1'), harness.appended.at(-1).payload.agentPreset)
  assert.equal(harness.appended.length, 3)
})

test('two sessions keep their modes and series marks apart', async () => {
  const harness = makeHarness({
    primarySessionId: 'session-a',
    sessionModes: { 'session-a': 'standard', 'session-b': 'code' },
  })
  const a = harness.agentsById.get('session-a')
  const b = harness.agentsById.get('session-b')

  // Switching A must not touch B.
  assert.equal((await harness.callAs(a, 'minimal')).kind, 'success')
  assert.equal(harness.modeOf('session-a'), 'minimal')
  assert.equal(harness.modeOf('session-b'), 'code')

  // B still believes it is `code`: the repeat-selection path runs, no recompose.
  const againB = await harness.callAs(b, 'code')
  assert.equal(againB.kind, 'success')
  assert.match(againB.text, /当前已经是/)
  assert.deepEqual(harness.composed, ['minimal'])

  // Switching B must not touch A.
  assert.equal((await harness.callAs(b, 'cordis')).kind, 'success')
  assert.deepEqual(harness.composed, ['minimal', 'cordis'])
  assert.equal(harness.modeOf('session-a'), 'minimal')
  assert.equal(harness.modeOf('session-b'), 'cordis')

  // Series marks are per session: B's admission must not consume A's mark.
  const preStep = harness.handlers.get('agent/pre-step')
  assert.ok(preStep, 'the pre-step listener is registered')
  const decision = { kind: 'enter', messages: [{ role: 'user' }] }
  const step = (agent) => preStep({ agent, signal: { aborted: false } }, async () => decision)
  assert.equal((await step(b)).startsRequestSeries, true)
  assert.equal((await step(a)).startsRequestSeries, true, "B's pre-step must not consume A's mark")
  assert.equal((await step(a)).startsRequestSeries, undefined)
  assert.equal((await step(b)).startsRequestSeries, undefined)
})

test('a slow switch on one session does not block another session', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const harness = makeHarness({
    primarySessionId: 'session-a',
    sessionModes: { 'session-a': 'standard', 'session-b': 'standard' },
    onRecompose: (id) => (id === 'minimal' ? gate : undefined),
  })
  const a = harness.agentsById.get('session-a')
  const b = harness.agentsById.get('session-b')

  const slow = harness.callAs(a, 'minimal')
  await flush()
  assert.deepEqual(harness.composed, [], 'A is stuck inside its recompose')

  // B's switch must not queue behind A's chain: it starts (and here even
  // finishes, since only `minimal` is gated) while A is still stuck.
  const fast = harness.callAs(b, 'cordis')
  await flush()
  assert.deepEqual(harness.state.events, ['start:minimal', 'start:cordis', 'end:cordis'])
  assert.ok(!harness.state.events.includes('end:minimal'), 'A is still in flight')
  assert.deepEqual(harness.composed, ['cordis'])

  release()
  assert.equal((await slow).kind, 'success')
  assert.equal((await fast).kind, 'success')
  assert.equal(harness.modeOf('session-a'), 'minimal')
  assert.equal(harness.modeOf('session-b'), 'cordis')
})

// ---------------------------------------------------------------------------
// Mode argument handling
// ---------------------------------------------------------------------------

test('re-selecting the current mode only schedules a series restart', async () => {
  const harness = makeHarness({ current: 'standard' })
  const result = await harness.call('standard')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /当前已经是/)
  // No recompose, no new log line.
  assert.deepEqual(harness.composed, [])
  assert.deepEqual(harness.appended, [])

  // The only effect is one armed series restart.
  const preStep = harness.handlers.get('agent/pre-step')
  const payload = { agent: harness.agent, signal: { aborted: false } }
  const decision = { kind: 'enter', messages: [{ role: 'user' }] }
  assert.equal((await preStep(payload, async () => decision)).startsRequestSeries, true)
  assert.equal((await preStep(payload, async () => decision)).startsRequestSeries, undefined)
})

test('/mode without an argument and /mode list report current plus all four ids', async () => {
  const harness = makeHarness({ current: 'cordis' })
  for (const rawInput of ['', '   ', undefined, 'list']) {
    const result = await harness.call(rawInput)
    assert.equal(result.kind, 'success')
    assert.match(result.text, /当前模式：cordis/)
    for (const id of ['standard', 'code', 'minimal', 'cordis']) {
      assert.ok(result.text.includes(id), `the report lists ${id}`)
    }
  }
  // The current mode carries the explicit marker in the list form.
  const listed = await harness.call('list')
  assert.match(listed.text, /cordis（当前 \/ current）/)
  // Reporting never switches.
  assert.deepEqual(harness.composed, [])
  assert.deepEqual(harness.appended, [])
})

test('mode arguments accept case, display name, and the ptc/code alias', async () => {
  const upper = makeHarness({ current: 'code' })
  assert.equal((await upper.call('STANDARD')).kind, 'success')
  assert.deepEqual(upper.composed, ['standard'])

  const mixed = makeHarness({ current: 'standard' })
  assert.equal((await mixed.call('Ptc')).kind, 'success')
  assert.deepEqual(mixed.composed, ['code'])

  const byName = makeHarness({ current: 'code' })
  assert.equal((await byName.call('标准模式')).kind, 'success')
  assert.deepEqual(byName.composed, ['standard'])

  // Leading/trailing and inner whitespace around the argument is tolerated.
  const padded = makeHarness({ current: 'minimal' })
  assert.equal((await padded.call('  cordis  ')).kind, 'success')
  assert.deepEqual(padded.composed, ['cordis'])
})

test('an ambiguous prefix picks one match without throwing', async () => {
  // 'c' matches both `code` and `cordis`; the shipped behaviour is the first
  // roster match, which is recorded here rather than pinned as a contract.
  const harness = makeHarness({ current: 'standard' })
  const result = await harness.call('c')
  assert.equal(result.kind, 'success')
  assert.equal(harness.composed.length, 1)
  assert.ok(['code', 'cordis'].includes(harness.composed[0]))
  assert.equal(harness.appended.at(-1).payload.agentPreset, harness.composed[0])
  assert.match(result.text, /已切换到 (PTC 模式|创造模式)/)

  // An unambiguous prefix still resolves deterministically.
  const single = makeHarness({ current: 'standard' })
  assert.equal((await single.call('mi')).kind, 'success')
  assert.deepEqual(single.composed, ['minimal'])
})

// ---------------------------------------------------------------------------
// agent/disposed cleanup
// ---------------------------------------------------------------------------

test('agent/disposed clears the series mark and later switches still work', async () => {
  const harness = makeHarness({ current: 'standard' })
  await harness.call('minimal')
  const preStep = harness.handlers.get('agent/pre-step')
  const disposed = harness.handlers.get('agent/disposed')
  assert.ok(disposed, 'the disposed listener is registered')

  disposed({ agent: harness.agent })
  const payload = { agent: harness.agent, signal: { aborted: false } }
  const decision = { kind: 'enter', messages: [{ role: 'user' }] }
  assert.equal(
    (await preStep(payload, async () => decision)).startsRequestSeries,
    undefined,
    'the disposed session must no longer restart a series',
  )

  // Cleanup must not break the plugin for a session that is still driven.
  assert.equal((await harness.call('cordis')).kind, 'success')
  assert.equal((await preStep(payload, async () => decision)).startsRequestSeries, true)

  // Defensive: a payload without an agent/session id is ignored, not thrown.
  assert.doesNotThrow(() => disposed({}))
  assert.doesNotThrow(() => disposed({ agent: { session: {} } }))
})

test('a disposed session does not leave an in-flight switch blocking the next one', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const harness = makeHarness({ current: 'standard', onRecompose: () => gate })
  const disposed = harness.handlers.get('agent/disposed')

  const slow = harness.call('minimal')
  await flush()
  assert.deepEqual(harness.state.events, ['start:minimal'])

  disposed({ agent: harness.agent })

  // With the per-session chain dropped, the next switch enters recompose at once.
  const next = harness.call('cordis')
  await flush()
  assert.deepEqual(harness.state.events, ['start:minimal', 'start:cordis'])

  release()
  assert.equal((await slow).kind, 'success')
  assert.equal((await next).kind, 'success')
})

// ---------------------------------------------------------------------------
// pre-step consumption rules
// ---------------------------------------------------------------------------

test('agent/pre-step consumes the mark only on an admitted non-empty non-aborted step', async () => {
  const harness = makeHarness()
  await harness.call('minimal') // arm the series mark
  const preStep = harness.handlers.get('agent/pre-step')
  const agent = harness.agent
  const admitted = { kind: 'enter', messages: [{ role: 'user' }] }
  const run = async (payload, decision) => preStep(payload, async () => decision)

  // Not admitted: the framework is not entering a request.
  const skipped = await run({ agent, signal: { aborted: false } }, { kind: 'skip', messages: [{ role: 'user' }] })
  assert.equal(skipped.startsRequestSeries, undefined)

  // Cancelled before the step runs.
  const aborted = await run({ agent, signal: { aborted: true } }, admitted)
  assert.equal(aborted.startsRequestSeries, undefined)

  // Admitted but with no messages: nothing to rebuild for.
  const empty = await run({ agent, signal: { aborted: false } }, { kind: 'enter', messages: [] })
  assert.equal(empty.startsRequestSeries, undefined)

  // Steps that do not identify a session are left alone.
  assert.equal((await run({ signal: { aborted: false } }, admitted)).startsRequestSeries, undefined)
  assert.equal(
    (await run({ agent: { ctx: {} }, signal: { aborted: false } }, admitted)).startsRequestSeries,
    undefined,
  )

  // None of the above consumed the mark: the first real admitted step now does.
  const accepted = await run({ agent, signal: { aborted: false } }, admitted)
  assert.equal(accepted.startsRequestSeries, true)
  assert.deepEqual(accepted.messages, admitted.messages)
  assert.equal(accepted.kind, 'enter')
  assert.equal((await run({ agent, signal: { aborted: false } }, admitted)).startsRequestSeries, undefined)
})

test('the switch log records the identity the registry bound', async () => {
  // Requested `ptc`, which resolves to the roster row `code`; the registry binds
  // `ptc` instead (id drift between DSH versions).
  const harness = makeHarness({
    current: 'standard',
    recomposeResultId: (id) => (id === 'code' ? 'ptc' : id),
  })
  const result = await harness.call('ptc')
  assert.equal(result.kind, 'success')
  assert.deepEqual(harness.composed, ['code'])
  assert.deepEqual(harness.appended, [{ event: 'agent-preset/selected', payload: { agentPreset: 'ptc' } }])
  assert.match(result.text, /Switched to ptc/)
  assert.equal(harness.modeOf('session-1'), 'ptc')
})

// ---------------------------------------------------------------------------
// Roster failures
// ---------------------------------------------------------------------------

test('an unreadable roster reports an error instead of crashing', async () => {
  const harness = makeHarness({ rosterThrows: new Error('roster offline') })
  for (const rawInput of ['list', 'minimal', 'next', '']) {
    const result = await harness.call(rawInput)
    assert.equal(result.kind, 'error')
    assert.match(result.text, /无法读取模式名册/)
    assert.match(result.text, /roster offline/)
  }
  // Nothing was composed or logged.
  assert.deepEqual(harness.composed, [])
  assert.deepEqual(harness.appended, [])
})

test('re-selecting the current mode repairs a divergent switch log', async () => {
  // The durable log is the only record a restart folds back in: when it names a
  // different preset than the live composition (an earlier append failure, or a
  // build that never wrote it), the no-op path must re-record the live mode.
  const harness = makeHarness({
    current: 'standard',
    seedLogs: { 'session-1': [{ type: 'agent-preset/selected', data: { agentPreset: 'minimal' } }] },
  })
  const result = await harness.call('standard')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /已补记切换日志/)
  assert.deepEqual(harness.appended, [{ event: 'agent-preset/selected', payload: { agentPreset: 'standard' } }])
  assert.equal(harness.agent.session.log.at(-1).data.agentPreset, 'standard')
})

test('a failed log append is repaired by re-issuing the same switch', async () => {
  const harness = makeHarness({ current: 'standard', appendThrowsOnce: true })
  const first = await harness.call('minimal')
  assert.equal(first.kind, 'error', 'the append failure is surfaced')
  assert.match(first.text, /记录切换事件失败/)
  assert.match(first.text, /可补记/)
  assert.equal(harness.state.current, 'minimal', 'the recompose itself landed')
  assert.deepEqual(harness.appended, [], 'nothing reached the log')

  // The live mode is already minimal; the retry must repair instead of re-composing.
  const second = await harness.call('minimal')
  assert.equal(second.kind, 'success')
  assert.match(second.text, /已补记切换日志/)
  assert.deepEqual(harness.appended, [{ event: 'agent-preset/selected', payload: { agentPreset: 'minimal' } }])
  assert.deepEqual(harness.composed, ['minimal'], 'the repair did not recompose again')
})

test('a queued switch judges the mode the earlier switch landed on', async () => {
  // The burst that used to lose its last request: a slow switch to minimal is
  // queued, then `standard` is queued behind it. `standard` must be judged AFTER
  // minimal lands, not against the stale pre-queue snapshot (where the session
  // still said standard, so the request was dropped as a no-op).
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const harness = makeHarness({
    current: 'standard',
    onRecompose: async () => {
      await gate
    },
  })
  const first = harness.call('minimal')
  await new Promise((resolve) => setTimeout(resolve, 0))
  const second = harness.call('standard')
  release()
  const [minimalResult, standardResult] = await Promise.all([first, second])
  assert.equal(minimalResult.kind, 'success')
  assert.equal(standardResult.kind, 'success', 'the last request of the burst is not dropped')
  assert.deepEqual(harness.composed, ['minimal', 'standard'])
  assert.equal(harness.state.current, 'standard', 'the session ends on the last requested mode')
  assert.deepEqual(
    harness.appended.map((entry) => entry.payload.agentPreset),
    ['minimal', 'standard'],
    'both switches are recorded in order',
  )
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
