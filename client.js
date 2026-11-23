/**
 * dsh-four-modes — Client half (Web).
 *
 * Renders a compact mode control in the composer tool row
 * (`conversation.input.left`): the current mode name with a caret, opening a
 * four-item menu (标准 / PTC / 极简 / 创造). Switching goes through the Host
 * `/mode` command registered by the bundle's Host half, so a started task can
 * change mode too.
 *
 * The current mode comes from the live Session projection
 * (`projectionValues.agentPreset`), which the shipped preset surfaces also read.
 * The roster (`remote.agentPresets.list()`) supplies display names/descriptions,
 * so the control follows whichever preset ids this DSH version ships
 * (`code` vs `ptc` drift included).
 */
window.__ModuleLoader__.load({
  id: 'dsh-four-modes',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState } = React

    /**
     * Portal the popup to document.body when react-dom is on the platform seed,
     * so a composer ancestor with transform/overflow cannot clip it. Falls back
     * to inline rendering when the portal is unavailable.
     */
    let createPortal = (node) => node
    try {
      const ReactDOM = require('react-dom')
      if (ReactDOM !== null && typeof ReactDOM.createPortal === 'function') createPortal = (node) => ReactDOM.createPortal(node, document.body)
    } catch {
      // Inline fallback: the popup still renders inside the composer.
    }

    /** Popup sizing constants used to clamp and flip the menu inside the viewport. */
    const MENU_WIDTH = 288
    const MENU_EST_HEIGHT = 250

    /** localStorage key for per-mode model memory (versioned so a shape change is safe). */
    const MODELS_KEY = 'dsh-four-modes.models.v1'

    /**
     * Normalize a model selection to the provider/model/reasoning triple the
     * session API accepts. Anything incomplete collapses to null.
     * @param selection - raw selection from the projection or storage.
     * @returns the normalized selection, or null.
     */
    function normalizeModel(selection) {
      if (selection === null || typeof selection !== 'object') return null
      if (typeof selection.provider !== 'string' || selection.provider === '') return null
      if (typeof selection.model !== 'string' || selection.model === '') return null
      const out = { provider: selection.provider, model: selection.model }
      if (typeof selection.reasoningEffort === 'string' && selection.reasoningEffort !== '') {
        out.reasoningEffort = selection.reasoningEffort
      }
      return out
    }

    /**
     * Whether two selections denote the same model + effort.
     * @param a - first selection.
     * @param b - second selection.
     * @returns true when both normalize to the same triple.
     */
    function sameModel(a, b) {
      const left = normalizeModel(a)
      const right = normalizeModel(b)
      if (left === null || right === null) return false
      return left.provider === right.provider && left.model === right.model && (left.reasoningEffort ?? '') === (right.reasoningEffort ?? '')
    }

    /** Render one thrown value as a short message. */
    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    /** Reject after `ms` so a wedged Remote call cannot freeze the control. */
    function withTimeout(promise, ms) {
      return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms)),
      ])
    }

    /**
     * The canonical storage key for a mode (bridges the `code`/`ptc` id drift).
     * @param rowOrId - roster row, fallback row, or raw id.
     * @returns the canonical mode id, or undefined.
     */
    function canonicalModeId(rowOrId) {
      if (rowOrId === undefined || rowOrId === null) return undefined
      const row = typeof rowOrId === 'string' ? { id: rowOrId } : rowOrId
      const fallback = fallbackOf(row)
      if (fallback !== undefined) return fallback.id
      return typeof row.id === 'string' && row.id !== '' ? row.id : undefined
    }

    /** Read the per-mode model memory, tolerating disabled/blocked storage. */
    function readModels() {
      try {
        const raw = localStorage.getItem(MODELS_KEY)
        if (raw === null || raw === '') return {}
        const parsed = JSON.parse(raw)
        return parsed !== null && typeof parsed === 'object' ? parsed : {}
      } catch {
        return {}
      }
    }

    /** Persist the per-mode model memory. */
    function writeModels(models) {
      try {
        localStorage.setItem(MODELS_KEY, JSON.stringify(models))
      } catch {
        // Storage is best-effort: the control keeps working without memory.
      }
    }

    /** Fallback order + copy for the four shipped modes (tolerant of id drift). */
    const FALLBACK_MODES = [
      {
        id: 'standard',
        match: ['standard'],
        glyph: '\u2699',
        zh: '标准模式',
        en: 'Standard',
        zhHint: '完整编码 Agent：文件、Shell、检索、Skills、计划、目标、子代理、工作流',
        enHint: 'Full coding agent: files, shell, search, skills, plan, goals, subagents, workflows',
      },
      {
        id: 'ptc',
        match: ['ptc', 'code'],
        glyph: '\u27e8\u27e9',
        zh: 'PTC 模式',
        en: 'PTC',
        zhHint: '标准能力 + Code Mode：用一段 TypeScript 程序组合多步工具调用',
        enHint: 'Standard abilities + Code Mode: compose many tool calls in one typed program',
      },
      {
        id: 'minimal',
        match: ['minimal'],
        glyph: '\u00b7',
        zh: '极简模式',
        en: 'Minimal',
        zhHint: '仅持久 Bash 与文件编辑器，最小提示词前缀',
        enHint: 'Persistent bash + editor only, the smallest stable prompt prefix',
      },
      {
        id: 'cordis',
        match: ['cordis'],
        glyph: '\u2726',
        zh: '创造模式',
        en: 'Creator',
        zhHint: '标准能力 + Cordis 运行时检查、插件实验与 preset 创作',
        enHint: 'Standard abilities + Cordis inspection, plugin experiments and preset authoring',
      },
    ]

    /** True when the page language is Chinese. */
    function isZh() {
      try {
        const lang = document.documentElement.lang || (typeof navigator !== 'undefined' ? navigator.language : '') || ''
        return lang.toLowerCase().startsWith('zh')
      } catch {
        return false
      }
    }

    /**
     * Translate one locale-sensitive pair.
     * @param zh - Chinese text.
     * @param en - English text.
     * @returns the current-language text.
     */
    function pick(zh, en) {
      return isZh() ? zh : en
    }

    /**
     * Map one roster row onto its fallback descriptor.
     * @param row - roster row ({ id, name?, description? }).
     * @returns the fallback mode, or undefined for a custom preset.
     */
    function fallbackOf(row) {
      const id = String(row?.id ?? '').toLowerCase()
      return FALLBACK_MODES.find((mode) => mode.match.includes(id))
    }

    /**
     * The display name of a roster row.
     * @param row - roster row.
     * @returns the localized display name.
     */
    function nameOf(row) {
      if (typeof row?.name === 'string' && row.name !== '') return row.name
      const fallback = fallbackOf(row)
      if (fallback !== undefined) return pick(fallback.zh, fallback.en)
      return String(row?.id ?? '')
    }

    /**
     * The one-line hint of a roster row.
     * @param row - roster row.
     * @returns the localized hint.
     */
    function hintOf(row) {
      if (typeof row?.description === 'string' && row.description !== '') return row.description
      const fallback = fallbackOf(row)
      if (fallback !== undefined) return pick(fallback.zhHint, fallback.enHint)
      return ''
    }

    /**
     * The glyph of a roster row.
     * @param row - roster row.
     * @returns a single-character glyph.
     */
    function glyphOf(row) {
      const fallback = fallbackOf(row)
      if (fallback !== undefined) return fallback.glyph
      return '\u25c6'
    }

    /**
     * Order the roster: the four shipped modes first (in canonical order), then
     * any custom preset so it stays reachable.
     * @param rows - usable roster rows.
     * @returns ordered rows.
     */
    function orderRows(rows) {
      const out = []
      const taken = new Set()
      for (const mode of FALLBACK_MODES) {
        const row = rows.find((candidate) => mode.match.includes(String(candidate?.id ?? '').toLowerCase()))
        if (row !== undefined && !taken.has(row.id)) {
          out.push(row)
          taken.add(row.id)
        }
      }
      for (const row of rows) {
        if (!taken.has(row.id)) out.push(row)
      }
      return out
    }

    /**
     * Whether one row represents the given live preset id.
     *
     * The live projection reports the real preset id (`code` on this DSH line),
     * while the fallback list names the mode `ptc`; the alias table bridges that
     * drift so the chip never falls back to the wrong label before the roster
     * arrives.
     *
     * @param row - roster row or fallback row.
     * @param id - the live/current preset id.
     * @returns true when the row denotes that mode.
     */
    function matchesMode(row, id) {
      if (typeof id !== 'string' || id === '') return false
      const wanted = id.toLowerCase()
      if (String(row?.id ?? '').toLowerCase() === wanted) return true
      const fallback = fallbackOf(row)
      return fallback !== undefined && fallback.match.includes(wanted)
    }

    /** Stylesheet installed once per page and removed with the plugin. */
    const STYLE_ID = 'dsh-four-modes/styles'
    const CSS = `
      .dshfm-anchor { display: inline-flex; align-items: center; }
      .dshfm-chip {
        display: inline-flex; align-items: center; gap: 5px;
        height: 28px; padding: 0 8px; border: none;
        border-radius: var(--dsw-radius-sm, 6px);
        background: var(--dsw-alias-state-business-tertiary, #eef4ff);
        color: var(--dsw-alias-state-business-primary, #1677ff);
        font-size: 13px; font-weight: 600; line-height: 1;
        cursor: pointer; transition: background 120ms ease, opacity 120ms ease;
        white-space: nowrap; max-width: 180px;
      }
      .dshfm-chip:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-state-business-tertiary, #eef4ff), var(--dsw-alias-state-business-primary, #1677ff) 10%); }
      .dshfm-chip:disabled { cursor: default; opacity: 0.55; }
      .dshfm-chip-glyph { font-size: 13px; opacity: 0.9; }
      .dshfm-chip-name { overflow: hidden; text-overflow: ellipsis; }
      .dshfm-caret { font-size: 9px; opacity: 0.8; }
      .dshfm-menu {
        position: fixed; z-index: 2147483000; width: 280px; max-width: min(280px, calc(100vw - 16px));
        padding: 4px; border-radius: 8px; overflow-y: auto;
        background: var(--dsw-alias-bg-elevated, var(--dsw-alias-bg-base, #fff));
        border: 1px solid var(--dsw-alias-border-secondary, #e5e5e5);
        box-shadow: 0 6px 24px rgba(0, 0, 0, 0.16);
        font-size: 13px; color: var(--dsw-alias-label-primary, #1f1f1f);
      }
      .dshfm-item {
        display: flex; gap: 8px; align-items: flex-start; width: 100%;
        padding: 7px 8px; border: none; border-radius: 6px;
        background: transparent; color: inherit; text-align: left; cursor: pointer;
        font-size: 13px;
      }
      .dshfm-item:hover:not(:disabled) { background: var(--dsw-alias-bg-secondary, #f5f5f5); }
      .dshfm-item:disabled { cursor: default; opacity: 0.55; }
      .dshfm-item[data-active="true"] { background: var(--dsw-alias-state-business-tertiary, #eef4ff); }
      .dshfm-item-glyph { flex: none; width: 16px; text-align: center; opacity: 0.85; }
      .dshfm-item-main { flex: 1 1 auto; min-width: 0; }
      .dshfm-item-name { font-weight: 600; }
      .dshfm-item-hint { font-size: 11px; opacity: 0.66; margin-top: 2px; line-height: 1.35; }
      .dshfm-item-check { flex: none; width: 14px; text-align: center; opacity: 0.9; }
      .dshfm-status {
        margin: 2px 6px 6px; padding: 4px 6px; border-radius: 4px;
        font-size: 11px; line-height: 1.4; word-break: break-word;
      }
      .dshfm-status[data-kind="ok"] {
        color: var(--dsw-alias-state-success-primary, #52c41a);
        background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #52c41a) 8%, transparent);
      }
      .dshfm-status[data-kind="err"] {
        color: var(--dsw-alias-state-error-primary, #ff4d4f);
        background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ff4d4f) 8%, transparent);
      }
      .dshfm-error {
        margin: 4px 6px 2px; padding: 5px 6px; border-radius: 4px; font-size: 11px;
        color: var(--dsw-alias-state-error-primary, #ff4d4f);
        background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ff4d4f) 8%, transparent);
        word-break: break-word;
      }
    `

    /**
     * Install the stylesheet once and hand back its disposer.
     * @returns a cleanup function.
     */
    function installStyle() {
      if (document.getElementById(STYLE_ID) !== null) return () => {}
      const node = document.createElement('style')
      node.id = STYLE_ID
      node.textContent = CSS
      document.head.appendChild(node)
      return () => {
        node.remove()
      }
    }

    /**
     * Build the slot component over one plugin context.
     * @param ctx - the Client plugin context (carries the `remote` facade).
     * @returns the React component registered into `conversation.input.left`.
     */
    function createControl(ctx) {
      /** Read the Remote facade lazily: namespaces mount after apply. */
      function remoteOf() {
        // `inject: ['remote']` exposes the facade as ctx.remote; ctx.get('remote')
        // is the generic service lookup kept as a fallback.
        try {
          if (ctx.remote !== undefined && ctx.remote !== null) return ctx.remote
        } catch {
          // fall through to the service lookup
        }
        try {
          return ctx.get('remote')
        } catch {
          return undefined
        }
      }

      return function FourModesControl(props) {
        const sessionId = typeof props.sessionId === 'string' && props.sessionId !== '' ? props.sessionId : undefined
        const useSessions = props.useSessions

        const liveId = useSessions((state) => {
          const value = state === undefined ? undefined : state.byId?.[sessionId]?.projectionValues?.agentPreset
          return typeof value === 'string' && value !== '' ? value : undefined
        })
        const running = useSessions((state) => (state === undefined ? false : state.byId?.[sessionId]?.running === true))

        const [rows, setRows] = useState(null)
        const [open, setOpen] = useState(false)
        const [busy, setBusy] = useState(false)
        const [error, setError] = useState(null)
        const [note, setNote] = useState(null)
        const [picked, setPicked] = useState(undefined)
        const [anchor, setAnchor] = useState(null)

        const rootRef = useRef(null)
        const aliveRef = useRef(true)
        const busyRef = useRef(false)
        /** The session this render belongs to; async callbacks compare against it. */
        const sessionIdRef = useRef(sessionId)
        sessionIdRef.current = sessionId

        // Live model selection of this session (projection owned by model-selection).
        const useProjection = typeof props.useProjection === 'function' ? props.useProjection : () => undefined
        const modelProjection = useProjection('modelSelection')
        const currentModel = normalizeModel(modelProjection && (modelProjection.next ?? modelProjection.lastUsed))

        /** Per-mode model memory, loaded once from localStorage. */
        const modelsRef = useRef(readModels())
        /** Last model observed for this session, to detect a user-made change. */
        const lastModelRef = useRef(undefined)
        /** True while this plugin is itself applying a remembered model. */
        const pendingModelRef = useRef(false)

        useEffect(() => {
          aliveRef.current = true
          const cleanupStyle = installStyle()
          return () => {
            aliveRef.current = false
            cleanupStyle()
          }
        }, [])

        // The composer is session-scoped and may be reused across sessions; drop
        // optimistic state so the chip never shows a mode from another session.
        // Busy must reset too, or an in-flight request for the old session could
        // leave the new session's chip disabled.
        useEffect(() => {
          setPicked(undefined)
          setOpen(false)
          setError(null)
          setNote(null)
          busyRef.current = false
          setBusy(false)
          lastModelRef.current = undefined
          pendingModelRef.current = false
        }, [sessionId])

        // Load the live roster once per mount; a failure still leaves the four
        // shipped modes usable through the fallback copy.
        useEffect(() => {
          let cancelled = false
          async function load() {
            const remote = remoteOf()
            const roster = remote === undefined ? undefined : remote.agentPresets
            if (roster === undefined || typeof roster.list !== 'function') return
            try {
              const result = await roster.list()
              if (cancelled || !aliveRef.current) return
              if (result !== undefined && result.ok === true) {
                const presets = Array.isArray(result.value?.presets) ? result.value.presets : []
                setRows(orderRows(presets.filter((row) => row !== null && typeof row === 'object' && typeof row.broken !== 'string')))
              } else if (result !== undefined && result.error?.code === 'gateway/invocation-unavailable') {
                setRows([])
              }
            } catch {
              // Keep the fallback list; the composer control must never throw.
            }
          }
          load()
          return () => {
            cancelled = true
          }
        }, [])

        // Close the menu on an outside click or Escape.
        useEffect(() => {
          if (!open) return undefined
          function onPointerDown(event) {
            const target = event.target
            if (rootRef.current === null) return
            if (rootRef.current.contains(target)) return
            if (target instanceof Element && target.closest('.dshfm-menu') !== null) return
            setOpen(false)
          }
          function onKeyDown(event) {
            if (event.key === 'Escape') setOpen(false)
          }
          document.addEventListener('mousedown', onPointerDown, true)
          document.addEventListener('keydown', onKeyDown, true)
          return () => {
            document.removeEventListener('mousedown', onPointerDown, true)
            document.removeEventListener('keydown', onKeyDown, true)
          }
        }, [open])

        const effectiveRows = rows !== null && rows.length > 0 ? rows : FALLBACK_MODES.map((mode) => ({ id: mode.id, name: pick(mode.zh, mode.en) }))
        const effectiveId = picked !== undefined ? picked : liveId
        const currentRow = effectiveRows.find((row) => matchesMode(row, effectiveId)) ?? effectiveRows[0]

        // Learn the user's per-mode model choice: when the live model changes
        // without this plugin initiating it, remember it for the active mode.
        useEffect(() => {
          if (currentModel === null) return
          if (pendingModelRef.current) {
            // Our own selectModel landed; just resync the baseline.
            pendingModelRef.current = false
            lastModelRef.current = currentModel
            return
          }
          if (lastModelRef.current !== undefined && sameModel(lastModelRef.current, currentModel)) return
          lastModelRef.current = currentModel
          const modeId = canonicalModeId(effectiveId ?? liveId)
          if (modeId === undefined) return
          modelsRef.current = { ...modelsRef.current, [modeId]: currentModel }
          writeModels(modelsRef.current)
        }, [currentModel, effectiveId, liveId])

        /** Toggle the popup and record its screen anchor. */
        function toggleOpen() {
          if (open) {
            setOpen(false)
            return
          }
          const rect = rootRef.current === null ? null : rootRef.current.getBoundingClientRect()
          setAnchor(rect === null ? null : { left: rect.left, top: rect.top, bottom: rect.bottom })
          // A fresh open never shows a stale failure from an earlier attempt.
          setError(null)
          setNote(null)
          setOpen(true)
        }

        /**
         * Switch this task's mode through the Host `/mode` command.
         * @param id - target preset id.
         */
        async function switchTo(id) {
          if (busyRef.current) return
          // Bind the async flow to the session that started it: if the composer
          // switches sessions mid-flight, its result must not leak into the new one.
          const requestSession = sessionId
          const stillCurrent = () => sessionIdRef.current === requestSession
          if (sessionId === undefined) {
            setError(pick('当前没有活动会话', 'No active session'))
            setNote({ kind: 'err', text: pick('无会话', 'No session') })
            setOpen(false)
            return
          }
          const remote = remoteOf()
          const commands = remote === undefined ? undefined : remote.commands
          if (commands === undefined || typeof commands.execute !== 'function') {
            setError(pick('/mode 命令不可用（Host 半侧未生效）', 'The /mode command is unavailable'))
            setNote({ kind: 'err', text: pick('命令不可用', 'No command') })
            setOpen(false)
            return
          }
          busyRef.current = true
          setBusy(true)
          setError(null)
          setNote(null)
          try {
            const result = await withTimeout(commands.execute(sessionId, `/mode ${id}`, []), 15000)
            if (!aliveRef.current || !stillCurrent()) return
            if (result === undefined || result.ok !== true) {
              const reason =
                result !== undefined && result.error !== undefined
                  ? `${result.error.code ?? ''}${result.error.message === undefined ? '' : `: ${result.error.message}`}`
                  : 'remote call failed'
              setError(pick(`切换失败：Remote 调用失败（${reason}）`, `Switch failed: ${reason}`))
              setNote({ kind: 'err', text: pick('切换失败', 'Failed') })
              return
            }
            const execution = result.value
            if (execution === undefined) {
              setError(pick('/mode 命令未注册（Host 半侧未生效）', 'The /mode command is not registered'))
              setNote({ kind: 'err', text: pick('命令未注册', 'No command') })
              return
            }
            const outcome = execution.result
            if (outcome === undefined || outcome.kind !== 'success') {
              setError(typeof outcome?.text === 'string' && outcome.text !== '' ? outcome.text : pick('切换失败', 'Switch failed'))
              setNote({ kind: 'err', text: pick('切换失败', 'Failed') })
              return
            }
            setPicked(id)
            // Success is silent: the chip already shows the new mode, and the menu
            // closes. Failures keep the menu open so the reason is visible.
            setOpen(false)
            // Apply this mode's remembered model, if any. The mode switch already
            // committed; a model failure only annotates the chip title.
            const targetId = canonicalModeId(effectiveRows.find((row) => matchesMode(row, id)) ?? { id })
            const saved = targetId === undefined ? undefined : modelsRef.current[targetId]
            const session = remote === undefined ? undefined : remote.session
            if (saved !== undefined && session !== undefined && typeof session.selectModel === 'function') {
              pendingModelRef.current = true
              try {
                const modelResult = await withTimeout(
                  session.selectModel({
                    sessionId,
                    provider: saved.provider,
                    model: saved.model,
                    ...(saved.reasoningEffort === undefined ? {} : { reasoningEffort: saved.reasoningEffort }),
                  }),
                  8000,
                )
                if (modelResult !== undefined && modelResult.ok === false) {
                  throw new Error(modelResult.error?.message ?? 'model-unavailable')
                }
                if (aliveRef.current) lastModelRef.current = saved
              } catch (modelError) {
                pendingModelRef.current = false
                // The mode switch already succeeded; the model memory is
                // best-effort. Log it instead of surfacing another warning.
                console.warn('[dsh-four-modes] remembered model did not apply:', modelError)
              }
            }
          } catch (err) {
            if (aliveRef.current && stillCurrent()) {
              setError(err instanceof Error ? err.message : String(err))
              setNote({ kind: 'err', text: pick('切换失败', 'Failed') })
            }
          } finally {
            busyRef.current = false
            if (aliveRef.current && stillCurrent()) {
              setBusy(false)
            }
          }
        }

        const disabled = sessionId === undefined || running || busy
        const glyph = glyphOf(currentRow)
        const label = nameOf(currentRow)

        /**
         * Place the popup inside the viewport: below the chip when that fits,
         * flipped above when the composer sits near the window bottom (the
         * composer toolbar lives at the very bottom, so this is the normal case).
         */
        function menuStyle() {
          if (anchor === null) return undefined
          const vw = window.innerWidth
          const vh = window.innerHeight
          const left = Math.max(8, Math.min(anchor.left, vw - MENU_WIDTH - 8))
          const below = vh - anchor.bottom - 10
          const above = anchor.top - 10
          if (below >= MENU_EST_HEIGHT || below >= above) {
            return { left: `${left}px`, top: `${anchor.bottom + 6}px`, maxHeight: `${Math.max(160, below)}px` }
          }
          return { left: `${left}px`, bottom: `${vh - anchor.top + 6}px`, maxHeight: `${Math.max(160, above)}px` }
        }

        const chipTitle =
          (running
            ? pick('任务执行中，结束后可切换模式', 'Task running — switch after the turn ends')
            : pick('切换本任务的 Agent 模式（标准 / PTC / 极简 / 创造）', 'Switch this task’s agent mode')) +
          (error === null ? '' : `\n${error}`)

        // The chip is deliberately static: no color flash, no text swap. The
        // result of the last switch is shown inside the menu instead.
        const chip = h(
          'button',
          {
            type: 'button',
            className: 'dshfm-chip',
            disabled,
            onClick: toggleOpen,
            title: chipTitle,
            'aria-haspopup': 'menu',
            'aria-expanded': open ? 'true' : 'false',
            'aria-label': pick(`当前模式：${label}，点击切换`, `Current mode: ${label}, click to switch`),
          },
          h('span', { className: 'dshfm-chip-glyph', 'aria-hidden': 'true' }, glyph),
          h('span', { className: 'dshfm-chip-name' }, label),
          h('span', { className: 'dshfm-caret', 'aria-hidden': 'true' }, '\u25be'),
        )

        // Static status shown inside the menu (the chip never flashes). Success is
        // deliberately silent, so every reachable status is a failure.
        const statusText = error !== null ? `⚠ ${error}` : note === null ? null : `⚠ ${note.text}`
        const statusKind = 'err'

        const menu = open
          ? h(
              'div',
              { className: 'dshfm-menu', role: 'menu', style: menuStyle() },
              statusText === null ? null : h('div', { className: 'dshfm-status', 'data-kind': statusKind }, statusText),
              effectiveRows.map((row) => {
                const id = String(row.id)
                const active = matchesMode(row, effectiveId)
                const remembered = modelsRef.current[canonicalModeId(row)]
                const hint = hintOf(row)
                const hintText = remembered === undefined ? hint : `${hint}${hint === '' ? '' : ' · '}${remembered.model}`
                return h(
                  'button',
                  {
                    type: 'button',
                    className: 'dshfm-item',
                    role: 'menuitemradio',
                    'data-active': active ? 'true' : 'false',
                    'aria-checked': active ? 'true' : 'false',
                    key: id,
                    disabled: busy,
                    onClick: () => switchTo(id),
                  },
                  h('span', { className: 'dshfm-item-glyph', 'aria-hidden': 'true' }, glyphOf(row)),
                  h(
                    'span',
                    { className: 'dshfm-item-main' },
                    h('div', { className: 'dshfm-item-name' }, nameOf(row)),
                    hintText === '' ? null : h('div', { className: 'dshfm-item-hint' }, hintText),
                  ),
                  h('span', { className: 'dshfm-item-check', 'aria-hidden': 'true' }, active ? '\u2713' : ''),
                )
              }),
            )
          : null

        return h('div', { className: 'dshfm-anchor', ref: rootRef }, chip, menu === null ? null : createPortal(menu))
      }
    }

    return {
      // Only the two base services here: the `remote.*` namespaces mount AFTER
      // apply, so waiting on them in `inject` can hold this fiber forever. The
      // control reads the facade lazily through ctx.get('remote') instead.
      // `remote.commands` is required: the shipped plan chip injects it the same
      // way, and the namespace is NOT reachable through lazy ctx.remote access
      // unless it is declared here (that was the "click does nothing" bug).
      // `remote.session` is read lazily because it is only needed for the
      // optional per-mode model memory.
      inject: ['slots', 'remote', 'remote.commands'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            {
              // `name` selects the target slot; `id` is this entry's cell key
              // (the slot system rejects a registration missing either one).
              name: 'conversation.input.left',
              id: 'four-modes',
              order: 10,
              inject: (sessionId) => ({ sessionId }),
            },
            createControl(ctx),
          ),
        )
      },
    }
  },
})
