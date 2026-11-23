/**
 * dsh-four-modes — Host half.
 *
 * Registers the `/mode` command, which re-composes a LIVE Agent onto another
 * shipped agent preset (standard / code(PTC) / minimal / cordis(创造)) — i.e.
 * switching modes mid-conversation instead of only at New Session time.
 *
 * The mechanism mirrors what the shipped preset picker does for a blank session:
 *   agentPresets.recompose(agent.ctx, id)     — rebind the scope parent
 *   session.append('agent-preset/selected')   — log the committed fact
 *   agent/pre-step -> startsRequestSeries      — rebuild tool declarations next request
 *
 * Guards this plugin owns itself:
 *   - never switch while a turn is open (the tool catalog would change under it)
 *   - serialize switches per Session (recompose mutates the scope then awaits)
 *   - tolerate `ptc`/`code` id drift between DSH versions (display name decides)
 */
export const inject = ['commands', 'agentPresets', 'agents']

/** The slash command; `mode` is free among the shipped commands. */
const COMMAND = 'mode'

/** Display mapping for the four shipped modes, tolerant of id drift across versions. */
const FOUR_MODES = [
  { id: 'standard', aliases: ['standard'], name: '标准模式', nameEn: 'Standard' },
  { id: 'ptc', aliases: ['ptc', 'code'], name: 'PTC 模式', nameEn: 'PTC' },
  { id: 'minimal', aliases: ['minimal'], name: '极简模式', nameEn: 'Minimal' },
  { id: 'cordis', aliases: ['cordis'], name: '创造模式', nameEn: 'Creator' },
]

/** Render a thrown value as a short message. */
const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/** Read a value, treating a throw as absent (a service may detach mid-call). */
const safely = (read) => {
  try {
    return read()
  } catch {
    return undefined
  }
}

/**
 * Whether a roster row can compose a session.
 *
 * A row is usable only when it carries a non-empty id and no truthy `broken`
 * marker: non-object rows, rows without an id (which would otherwise appear as
 * `undefined` and reach `recompose`), and rows whose `broken` reason is a
 * boolean/object are all filtered out.
 *
 * @param row - one roster row from `remoteExportList()`.
 * @returns true when the row identifies a preset the registry did not mark broken.
 */
const usable = (row) =>
  row !== null &&
  typeof row === 'object' &&
  typeof row.id === 'string' &&
  row.id.trim() !== '' &&
  (row.broken === undefined || row.broken === null || row.broken === false || row.broken === '')

/**
 * The shipped-mode descriptor an id belongs to, tolerant of the `ptc`/`code` drift.
 * @param id - a roster row id or a live preset id.
 * @returns the matching shipped mode descriptor, or undefined for a custom preset.
 */
function shippedModeOf(id) {
  const key = String(id ?? '').toLowerCase()
  return FOUR_MODES.find((mode) => mode.id === key || mode.aliases.includes(key))
}

/**
 * A comparison key that treats `ptc` and `code` as the same mode.
 * @param id - a roster row id or a live preset id.
 * @returns the shipped mode id, or the lowercased id for a custom preset.
 */
function canonicalModeKey(id) {
  return shippedModeOf(id)?.id ?? String(id ?? '').toLowerCase()
}

/**
 * Read the preset roster defensively: a deployment without the registry has none.
 * @param ctx - the plugin context carrying `agentPresets`.
 * @returns the switchable roster rows.
 */
async function readRoster(ctx) {
  const roster = await ctx.agentPresets.remoteExportList()
  const rows = Array.isArray(roster?.presets) ? roster.presets : []
  return rows.filter(usable)
}

/**
 * Resolve the user's argument against the live roster.
 *
 * Accepts, in order: the exact roster id; a known alias (ptc <-> code); the
 * display name from `preset.yml`; finally a case-insensitive id prefix.
 *
 * @param asked - trimmed user argument.
 * @param rows - usable roster rows.
 * @returns the matching roster row, or undefined.
 */
function resolveMode(asked, rows) {
  const wanted = asked.trim().toLowerCase()
  if (wanted === '') return undefined

  // 1) Exact roster id wins over every alias: a transitional deployment may list
  //    both `ptc` and `code` and asking for one must select that exact row.
  const direct = rows.find((row) => String(row.id).toLowerCase() === wanted)
  if (direct !== undefined) return direct

  // 2) The ptc <-> code alias bridges the id drift between DSH versions.
  const alias = FOUR_MODES.find((mode) => mode.aliases.includes(wanted))
  if (alias !== undefined) {
    const byAlias = rows.find((row) => alias.aliases.includes(String(row.id).toLowerCase()))
    if (byAlias !== undefined) return byAlias
  }

  // 3) The display name from `preset.yml`, trimmed, plus the shipped English
  //    names so the menu labels and `/mode` accept the same spelling.
  const byName = rows.find((row) => {
    const rowName = typeof row.name === 'string' ? row.name.trim().toLowerCase() : ''
    if (rowName !== '' && rowName === wanted) return true
    const mode = shippedModeOf(row.id)
    return mode !== undefined && (mode.name.toLowerCase() === wanted || mode.nameEn.toLowerCase() === wanted)
  })
  if (byName !== undefined) return byName

  // 4) Finally a case-insensitive id prefix.
  return rows.find((row) => String(row.id).toLowerCase().startsWith(wanted))
}

/**
 * The display name of one roster row, falling back to the shipped mapping.
 * @param row - roster row.
 * @param zh - true to prefer Chinese names.
 * @returns a human-readable name.
 */
function displayName(row, zh = true) {
  if (row !== null && typeof row === 'object' && typeof row.name === 'string' && row.name.trim() !== '') {
    return row.name.trim()
  }
  const id = String(row?.id ?? '')
  const mode = shippedModeOf(id)
  if (mode === undefined) return id
  return zh ? mode.name : mode.nameEn
}

/**
 * The four shipped preset ids present in this roster, in menu order, plus any
 * extra custom presets appended so a user-authored mode is still reachable.
 * @param rows - usable roster rows.
 * @returns ordered roster rows.
 */
function orderedModes(rows) {
  const out = []
  const taken = new Set()
  for (const mode of FOUR_MODES) {
    const row = rows.find((candidate) => mode.aliases.includes(String(candidate.id).toLowerCase()))
    if (row !== undefined && !taken.has(row.id)) {
      out.push(row)
      taken.add(row.id)
    }
  }
  for (const row of rows) {
    if (taken.has(row.id)) continue
    out.push(row)
    taken.add(row.id)
  }
  return out
}

/**
 * Mount the `/mode` command and the request-series listener.
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  /** Sessions whose next admitted step must start a new request series. */
  const pendingSeries = new Set()

  /** Per-Session switch chains, so two `/mode` calls cannot interleave their binds. */
  const switches = new Map()

  /** Sessions whose last successful recompose could not be written to the log. */
  const pendingLogRepair = new Set()

  // Rebuild the tool declarations on the next request after a switch. A step the
  // loop abandons (cancelled / empty admission) never becomes a request, so the
  // mark is consumed only on an admitted step.
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    const agent = payload?.agent
    if (agent === undefined || agent.session === undefined) return decision
    if (decision?.kind !== 'enter') return decision
    if (!pendingSeries.has(agent.session.id)) return decision
    if (payload.signal?.aborted === true) return decision
    if (Array.isArray(decision.messages) && decision.messages.length === 0) return decision
    pendingSeries.delete(agent.session.id)
    return { ...decision, startsRequestSeries: true }
  })

  // Drop bookkeeping for sessions that never run again.
  ctx.on('agent/disposed', ({ agent }) => {
    const id = agent?.session?.id
    if (id === undefined) return
    pendingSeries.delete(id)
    switches.delete(id)
    pendingLogRepair.delete(id)
  })

  /** True when this Agent has an open turn right now. */
  function turnIsOpen(agent) {
    if (agent?.status === 'running') return true
    const session = agent?.session
    if (session === undefined) return false
    // DSH 0.1.1-rc.2 exposes the turn boundary through the session-projections
    // service; the old `agents.turnBoundaryOf` helper does not exist. Read it
    // lazily so a deployment without the projection still keeps the status guard.
    const boundary = safely(() => ctx.get('sessionProjections')?.stateOf(session, 'turnBoundary'))
    return boundary !== undefined && boundary !== null && boundary.openTurnStartSeq !== null
  }

  /** The preset this live Agent currently runs, best effort. */
  function currentMode(agent) {
    // The live composition is authoritative for a mounted Agent. The durable
    // projection is the fallback: it is what `agentPresets.presetForSession`
    // would have read, but that method does not exist in 0.1.1-rc.2 and the
    // session controller does not expose it either (verified against the live
    // Host: only `sessionProjections.stateOf(session,'agentPreset')` answers).
    return (
      safely(() => ctx.agentPresets.composedPreset(agent.ctx)) ??
      safely(() => ctx.get('sessionProjections')?.stateOf(agent.session, 'agentPreset')) ??
      'unknown'
    )
  }

  /**
   * The durable session log, read defensively: the live Session may expose it as
   * `log`, `events`, or `entries` depending on the deployment.
   * @param session - the live Session.
   * @returns the event array, or an empty array when unreadable.
   */
  function readLog(session) {
    for (const key of ['log', 'events', 'entries']) {
      const value = safely(() => session?.[key])
      if (Array.isArray(value)) return value
      if (value !== undefined && value !== null && typeof value === 'object') {
        if (Array.isArray(value.events)) return value.events
        if (Array.isArray(value.entries)) return value.entries
        if (Array.isArray(value.items)) return value.items
      }
    }
    return []
  }

  /**
   * The last preset recorded in the durable log, or undefined when unknown.
   * Used only to decide whether a no-op switch should repair a missing record.
   * @param session - the live Session.
   * @returns the last logged preset id, or undefined.
   */
  function lastLoggedPreset(session) {
    const entries = readLog(session)
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]
      const type = String(entry?.type ?? entry?.kind ?? '')
      if (type !== 'agent-preset/selected') continue
      const payload = entry?.payload ?? entry?.data ?? {}
      return typeof payload.agentPreset === 'string' && payload.agentPreset !== '' ? payload.agentPreset : undefined
    }
    return undefined
  }

  /**
   * Re-compose one Agent, log the change, and arm the series restart.
   * @param agent - the receiving Agent.
   * @param target - the roster row to switch to.
   * @returns the command result the UI renders.
   */
  async function applySwitch(agent, target) {
    const sessionId = agent.session.id
    // Arm BEFORE awaiting: a prompt admitted during the await must not send a
    // request built from the new catalog and the old series.
    pendingSeries.add(sessionId)
    let preset
    try {
      preset = await ctx.agentPresets.recompose(agent.ctx, target.id)
    } catch (error) {
      // `bind` may have landed before the throw; ask the registry what the Agent
      // now runs instead of assuming nothing happened.
      const composed = safely(() => ctx.agentPresets.composedPreset(agent.ctx))
      if (composed !== target.id) {
        pendingSeries.delete(sessionId)
        return {
          kind: 'error',
          text: `切换到 ${displayName(target)} 失败：${messageOf(error)} / Failed to switch to ${target.id}: ${messageOf(error)}`,
        }
      }
      pendingSeries.add(sessionId)
      try {
        agent.session.append('agent-preset/selected', { agentPreset: target.id })
        pendingLogRepair.delete(sessionId)
      } catch (appendError) {
        pendingLogRepair.add(sessionId)
        return {
          kind: 'error',
          text: `已重新组合为 ${displayName(target)}，但记录切换事件失败：${messageOf(appendError)}（日志未记录，重启后可能回退；重新执行 /mode ${target.id} 可补记） / Re-composed to ${target.id} but logging failed: ${messageOf(appendError)}`,
        }
      }
      return {
        kind: 'success',
        text: `已切换到 ${displayName(target)}（切换过程中报告过一次错误：${messageOf(error)}） / Switched to ${target.id}`,
      }
    }

    // Log the identity the registry actually bound, not the one that was requested.
    const bound = typeof preset?.id === 'string' && preset.id !== '' ? preset.id : target.id
    try {
      agent.session.append('agent-preset/selected', { agentPreset: bound })
      pendingLogRepair.delete(sessionId)
    } catch (error) {
      pendingLogRepair.add(sessionId)
      return {
        kind: 'error',
        text: `已重新组合为 ${displayName(target)}，但记录切换事件失败：${messageOf(error)}（日志未记录，重启后可能回退；重新执行 /mode ${bound} 可补记） / Re-composed to ${bound} but logging failed: ${messageOf(error)}`,
      }
    }

    return {
      kind: 'success',
      text: `已切换到 ${displayName(target)}：工具与提示词已重新组合，下一次请求会重建工具声明。 / Switched to ${bound}: tools and prompt sections re-composed; the next request rebuilds the tool declarations.`,
    }
  }

  /**
   * Handle a request whose target is already the live mode: the catalog must not
   * be re-composed, but two repairs still apply:
   *   - the next request should rebuild its tool declarations (series restart);
   *   - a durable log that missed the last switch (an earlier append failure, or
   *     an older build that never wrote it) would make the next DSH start fold a
   *     stale preset back over the live composition.
   *
   * @param agent - the receiving Agent.
   * @param target - the roster row that is already live.
   * @returns the command result the UI renders.
   */
  function settleSameMode(agent, target) {
    pendingSeries.add(agent.session.id)
    const logged = lastLoggedPreset(agent.session)
    // Repair when an earlier append already failed on this Session, or when the
    // durable record is positively known to disagree. An unreadable log alone is
    // not evidence of a missing event.
    const needsRepair =
      pendingLogRepair.has(agent.session.id) ||
      (logged !== undefined && logged.toLowerCase() !== String(target.id).toLowerCase())
    if (!needsRepair) {
      return {
        kind: 'success',
        text: `当前已经是 ${displayName(target)}；已安排在下一次请求时重建工具声明。`,
      }
    }
    try {
      agent.session.append('agent-preset/selected', { agentPreset: target.id })
      pendingLogRepair.delete(agent.session.id)
    } catch (error) {
      return {
        kind: 'error',
        text: `当前已经是 ${displayName(target)}，但补记切换日志失败：${messageOf(error)} / Already on ${target.id}, but repairing the switch log failed: ${messageOf(error)}`,
      }
    }
    return {
      kind: 'success',
      text: `当前已经是 ${displayName(target)}；已补记切换日志（上次记录为 ${logged}）。 / Already on ${target.id}; the switch log was repaired (previous record: ${logged}).`,
    }
  }

  /**
   * Queue one switch on the per-Session serial chain.
   *
   * Both guards are re-checked at execution time, not only before queuing: a
   * queued switch may be admitted after a new turn opened, and it must decide
   * "already on this mode" from the mode an earlier queued switch actually
   * landed on — never from the snapshot captured when it was enqueued (that
   * race silently dropped the last request of a burst).
   *
   * @param agent - the receiving Agent.
   * @param target - roster row to switch to.
   * @returns the command result the UI renders.
   */
  function enqueueSwitch(agent, target) {
    const sessionId = agent.session.id
    const run = () => {
      if (turnIsOpen(agent)) {
        return {
          kind: 'error',
          text: '当前任务正在执行，等这一轮结束后再切换模式。 / This task is running; switch after the turn ends.',
        }
      }
      const live = currentMode(agent)
      const composed = safely(() => ctx.agentPresets.composedPreset(agent.ctx))
      if (canonicalModeKey(live) === canonicalModeKey(target.id) && composed === target.id) {
        return settleSameMode(agent, target)
      }
      return applySwitch(agent, target)
    }
    const previous = switches.get(sessionId) ?? Promise.resolve()
    const task = previous.then(run, run)
    switches.set(
      sessionId,
      task.then(
        () => undefined,
        () => undefined,
      ),
    )
    return task
  }

  /**
   * `/mode [id|list|next]` — report or switch the current task's mode.
   * @param agent - the receiving Agent.
   * @param rawInput - the command's argument text.
   * @returns the command result the UI renders.
   */
  async function switchMode(agent, rawInput) {
    const requested = typeof rawInput === 'string' ? (rawInput.trim().split(/\s+/)[0] ?? '') : ''
    // The reserved words are matched case-insensitively, exactly like preset ids.
    const keyword = requested.toLowerCase()

    let rows
    try {
      rows = await readRoster(ctx)
    } catch (error) {
      return { kind: 'error', text: `无法读取模式名册：${messageOf(error)} / Cannot read the preset roster: ${messageOf(error)}` }
    }
    const modes = orderedModes(rows)
    const current = currentMode(agent)
    const currentKey = canonicalModeKey(current)

    if (keyword === '' || keyword === 'list') {
      const list = modes.map((row) => `${row.id}${canonicalModeKey(row.id) === currentKey ? '（当前 / current）' : ''}`).join(', ')
      return {
        kind: 'success',
        text: modes.length === 0 ? `当前模式：${current}；名册中没有可切换的模式。` : `当前模式：${current}。可切换：${list}。用法：/mode <id>，或 /mode next 轮换。`,
      }
    }

    if (keyword === 'next') {
      const index = modes.findIndex((row) => canonicalModeKey(row.id) === currentKey)
      const target = modes[(index + 1) % Math.max(modes.length, 1)]
      if (target === undefined) return { kind: 'error', text: '名册中没有可切换的模式 / No switchable presets' }
      if (turnIsOpen(agent)) return { kind: 'error', text: '当前任务正在执行，等这一轮结束后再切换模式。 / This task is running; switch after the turn ends.' }
      return enqueueSwitch(agent, target)
    }

    const target = resolveMode(requested, modes)
    if (target === undefined) {
      return {
        kind: 'error',
        text: `未知模式：${requested}。可切换：${modes.map((row) => row.id).join(', ')}`,
      }
    }
    if (turnIsOpen(agent)) {
      return { kind: 'error', text: '当前任务正在执行，等这一轮结束后再切换模式。 / This task is running; switch after the turn ends.' }
    }

    // Everything below runs inside the per-Session serial chain: recompose mutates
    // the scope parent then awaits collection, so overlapping switches could bind
    // in one order and log in another. The no-op case is settled there too, so it
    // judges the mode an earlier queued switch actually landed on.
    return enqueueSwitch(agent, target)
  }

  ctx.commands.register({
    name: COMMAND,
    description:
      '切换本任务的 Agent 模式（标准 / PTC / 极简 / 创造），已开始的会话也可切换。 Switch this task to another agent preset, even after it started.',
    input: { hint: '<standard|ptc|minimal|cordis|list|next>' },
    // The invocation signal is intentionally not threaded into `recompose`: a UI
    // cancellation must not leave a half-applied composition.
    handler: ({ agent, rawInput }) => switchMode(agent, rawInput),
  })
}

