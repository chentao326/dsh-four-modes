#!/usr/bin/env node
/**
 * dsh-four-modes — 客户端「真实浏览器」DOM 集成测试。
 *
 * 目标：在**本机 Google Chrome（--headless=new）**里，通过 CDP 驱动真实 DOM，
 * 验证 client.js 在浏览器中实际渲染出来的 chip / portal 菜单 / 点击切换 /
 * 按模式记忆模型 / 视口定位 / 失败路径。
 *
 * 约束（任务给定）：
 *   - 只允许写本文件；临时页面放 /tmp/fm-browser/；不改 client.js / index.js；
 *   - 不安装任何依赖：只用 Node 内置模块 + Node 24 自带的 WebSocket / fetch；
 *   - 浏览器侧由本文件内置的一个 mini-React 运行时支撑（createElement /
 *     useState / useEffect / useRef / 重渲染 / ref / createPortal），不依赖 npm；
 *   - 每次运行使用独立空闲端口 + 独立临时 user-data-dir，结束时 kill Chrome。
 *
 * 运行：node test/client.browser.mjs
 * 输出：PASS/FAIL 列表；有失败时退出码 1。
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = join(HERE, '..')
const CLIENT_PATH = join(PACKAGE_DIR, 'client.js')
const CHROME_BIN =
  process.env.CHROME_BIN ??
  (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : process.platform === 'win32'
      ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
      : 'google-chrome')
const TMP_DIR = '/tmp/fm-browser'
const VIEWPORT = { width: 1024, height: 800 }

// ---------------------------------------------------------------------------
// 浏览器页面：一个足够跑真实插件的 mini-React 运行时
// ---------------------------------------------------------------------------

const PAGE_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>dsh-four-modes browser harness</title>
<style>
  html, body { margin: 0; padding: 0; }
  body { font: 13px/1.4 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; }
  #fm-root { padding: 8px; }
</style>
</head>
<body>
<div id="fm-root"></div>
<script>
  // client.js 是 classic script：它调用 window.__ModuleLoader__.load({ id, factory })。
  window.__ModuleLoader__ = {
    load: function (registration) { window.__fmRegistration = registration },
  }
</script>
<script src="/client.js"></script>
<script src="/harness.js"></script>
</body>
</html>
`

const HARNESS_JS = String.raw`(function () {
  'use strict'

  // -------------------------------------------------------------------------
  // 0. 收集未捕获错误（失败路径测试用来断言「不崩」）与 console.warn
  //    （记忆模型失败只 warn、不向用户显示 —— 需要断言 warn 真的被调用）
  // -------------------------------------------------------------------------
  var errors = []
  var warnings = []
  var originalWarn = typeof console.warn === 'function' ? console.warn : function () {}
  console.warn = function () {
    var parts = []
    for (var i = 0; i < arguments.length; i += 1) {
      var arg = arguments[i]
      if (arg instanceof Error) parts.push('Error: ' + arg.message)
      else if (typeof arg === 'string') parts.push(arg)
      else {
        try { parts.push(JSON.stringify(arg)) } catch (error) { parts.push(String(arg)) }
      }
    }
    warnings.push(parts.join(' '))
    try { originalWarn.apply(console, arguments) } catch (error) { /* 回显失败不影响测试 */ }
  }
  window.addEventListener('error', function (event) {
    var message = event && event.message ? event.message : String(event)
    errors.push('window.error: ' + message)
  })
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event && event.reason
    errors.push('unhandledrejection: ' + (reason && reason.message ? reason.message : String(reason)))
  })

  // -------------------------------------------------------------------------
  // 1. mini-React：createElement / hooks / ref / createPortal / 全量重渲染
  //
  //    没有 reconciliation（每次整棵重建）。对本插件足够：它只依赖 hooks 与
  //    ref 绑定；点击后重新查询 DOM 即可。portal 的宿主节点会被单独记录，
  //    下次渲染前移除，避免菜单泄漏到 document.body。
  // -------------------------------------------------------------------------
  var root = null
  var mounted = null
  var instance = null
  var hookCursor = 0
  var scheduled = false
  var portalMounted = []

  function scheduleRender() {
    if (scheduled) return
    scheduled = true
    queueMicrotask(function () {
      scheduled = false
      if (mounted !== null) renderNow()
    })
  }

  function flattenChildren(list, out) {
    for (var i = 0; i < list.length; i += 1) {
      var child = list[i]
      if (child === null || child === undefined || typeof child === 'boolean') continue
      if (Array.isArray(child)) flattenChildren(child, out)
      else out.push(child)
    }
  }

  function createElement(type, props) {
    var children = []
    for (var i = 2; i < arguments.length; i += 1) children.push(arguments[i])
    var normalized = []
    flattenChildren(children, normalized)
    return {
      __v: 1,
      type: type,
      props: props || {},
      children: normalized,
      key: props && props.key !== undefined ? props.key : undefined,
    }
  }

  function sameDeps(a, b) {
    if (a === undefined || b === undefined) return false
    if (a.length !== b.length) return false
    for (var i = 0; i < a.length; i += 1) {
      if (!Object.is(a[i], b[i])) return false
    }
    return true
  }

  function useState(initial) {
    var index = hookCursor
    hookCursor += 1
    var slot = instance.hooks[index]
    if (slot === undefined) {
      slot = { kind: 'state', value: typeof initial === 'function' ? initial() : initial }
      instance.hooks[index] = slot
    }
    function set(next) {
      var value = typeof next === 'function' ? next(slot.value) : next
      if (Object.is(value, slot.value)) return
      slot.value = value
      scheduleRender()
    }
    return [slot.value, set]
  }

  function useRef(initial) {
    var index = hookCursor
    hookCursor += 1
    var slot = instance.hooks[index]
    if (slot === undefined) {
      slot = { kind: 'ref', value: { current: initial === undefined ? null : initial } }
      instance.hooks[index] = slot
    }
    return slot.value
  }

  function useEffect(fn, deps) {
    var index = hookCursor
    hookCursor += 1
    var prev = instance.hooks[index]
    if (prev === undefined) {
      instance.hooks[index] = {
        kind: 'effect',
        fn: fn,
        deps: deps === undefined ? undefined : deps.slice(),
        nextDeps: deps === undefined ? undefined : deps.slice(),
        pending: true,
        cleanup: undefined,
      }
      return
    }
    var changed
    if (deps === undefined || prev.deps === undefined) changed = true
    else changed = !sameDeps(prev.deps, deps)
    prev.fn = fn
    prev.pending = changed
    prev.nextDeps = deps === undefined ? undefined : deps.slice()
  }

  function useMemo(factory, deps) {
    var index = hookCursor
    hookCursor += 1
    var prev = instance.hooks[index]
    if (prev === undefined || prev.kind !== 'memo' || !sameDeps(prev.deps, deps)) {
      instance.hooks[index] = { kind: 'memo', value: factory(), deps: deps === undefined ? undefined : deps.slice() }
    }
    return instance.hooks[index].value
  }

  function useCallback(fn, deps) {
    return useMemo(function () { return fn }, deps)
  }

  var React = {
    createElement: createElement,
    useState: useState,
    useEffect: useEffect,
    useRef: useRef,
    useMemo: useMemo,
    useCallback: useCallback,
    useLayoutEffect: useEffect,
  }

  var ReactDOM = {
    createPortal: function (node, container) {
      return { __portal: 1, node: node, container: container || document.body }
    },
  }

  function applyStyle(element, style) {
    if (style === null || style === undefined) return
    if (typeof style === 'string') {
      element.style.cssText = style
      return
    }
    var keys = Object.keys(style)
    for (var i = 0; i < keys.length; i += 1) {
      var key = keys[i]
      var value = style[key]
      if (value === null || value === undefined) continue
      element.style[key] = String(value)
    }
  }

  function setProps(element, props) {
    var keys = Object.keys(props || {})
    for (var i = 0; i < keys.length; i += 1) {
      var key = keys[i]
      var value = props[key]
      if (key === 'children' || key === 'key' || key === 'ref') continue
      if (key === 'style') { applyStyle(element, value); continue }
      if (key === 'className') { element.className = value === null || value === undefined ? '' : String(value); continue }
      if (key === 'htmlFor') { element.htmlFor = value; continue }
      if (key === 'dangerouslySetInnerHTML') { element.innerHTML = value && value.__html ? value.__html : ''; continue }
      if (key.length > 2 && key.slice(0, 2) === 'on' && typeof value === 'function') {
        element.addEventListener(key.slice(2).toLowerCase(), value)
        continue
      }
      var isAttr = key.slice(0, 5) === 'aria-' || key.slice(0, 5) === 'data-' || key === 'role'
      if (value === undefined || value === null || value === false) {
        if (isAttr) element.setAttribute(key, String(value))
        else element.removeAttribute(key)
        continue
      }
      if (isAttr) { element.setAttribute(key, String(value)); continue }
      if (typeof value === 'boolean') { if (value) element.setAttribute(key, ''); continue }
      if (key === 'type' || key === 'title' || key === 'disabled' || key === 'value' || key === 'name') {
        try { element[key] = value } catch (error) { element.setAttribute(key, String(value)) }
        continue
      }
      try { element.setAttribute(key, String(value)) } catch (error) { element[key] = value }
    }
  }

  function mountNode(vnode, parent) {
    if (vnode === null || vnode === undefined || typeof vnode === 'boolean') return
    if (Array.isArray(vnode)) {
      for (var i = 0; i < vnode.length; i += 1) mountNode(vnode[i], parent)
      return
    }
    if (typeof vnode === 'string' || typeof vnode === 'number') {
      parent.appendChild(document.createTextNode(String(vnode)))
      return
    }
    if (vnode.__portal === 1) {
      var fragment = document.createDocumentFragment()
      mountNode(vnode.node, fragment)
      var nodes = Array.prototype.slice.call(fragment.childNodes)
      vnode.container.appendChild(fragment)
      portalMounted.push({ nodes: nodes, container: vnode.container })
      return
    }
    if (vnode.__v !== 1) throw new Error('mini-React: 无法渲染的节点 ' + String(vnode))
    var element = document.createElement(vnode.type)
    setProps(element, vnode.props)
    var ref = vnode.props && vnode.props.ref
    if (ref !== null && ref !== undefined) {
      if (typeof ref === 'function') ref(element)
      else if (typeof ref === 'object') ref.current = element
    }
    for (var c = 0; c < vnode.children.length; c += 1) mountNode(vnode.children[c], element)
    parent.appendChild(element)
  }

  function renderNow() {
    if (mounted === null) return
    instance = mounted.instance
    hookCursor = 0
    var vdom = mounted.component(mounted.props)
    for (var p = 0; p < portalMounted.length; p += 1) {
      var entry = portalMounted[p]
      for (var n = 0; n < entry.nodes.length; n += 1) entry.nodes[n].remove()
    }
    portalMounted.length = 0
    while (mounted.root.firstChild) mounted.root.removeChild(mounted.root.firstChild)
    mountNode(vdom, mounted.root)
    var hooks = instance.hooks
    for (var i = 0; i < hooks.length; i += 1) {
      var hook = hooks[i]
      if (hook === undefined || hook.kind !== 'effect' || hook.pending !== true) continue
      hook.pending = false
      if (typeof hook.cleanup === 'function') {
        try { hook.cleanup() } catch (error) { errors.push('effect cleanup: ' + String((error && error.stack) || error)) }
        hook.cleanup = undefined
      }
      try {
        var cleanup = hook.fn()
        if (typeof cleanup === 'function') hook.cleanup = cleanup
      } catch (error) {
        errors.push('effect: ' + String((error && error.stack) || error))
      }
      hook.deps = hook.nextDeps
    }
  }

  function mountRoot(component, props) {
    mounted = { component: component, props: props, instance: { hooks: [] }, root: root }
    portalMounted = []
    while (root.firstChild) root.removeChild(root.firstChild)
    renderNow()
  }

  // -------------------------------------------------------------------------
  // 2. 走一遍真实的插件加载路径：__ModuleLoader__.load → factory → apply
  // -------------------------------------------------------------------------
  root = document.getElementById('fm-root')
  if (root === null) throw new Error('harness: #fm-root 不存在')
  var registration = window.__fmRegistration
  if (!registration || typeof registration.factory !== 'function') {
    throw new Error('client.js 没有通过 window.__ModuleLoader__.load 注册 factory')
  }
  function requireModule(name) {
    if (name === 'react') return React
    if (name === 'react-dom') return ReactDOM
    throw new Error('client.js require 了未预期的模块: ' + name)
  }
  var plugin = registration.factory(requireModule)
  var injected = []
  var registrations = []
  var ctx = {
    get: function (name) { return name === 'remote' ? window.__remote : undefined },
    slots: {
      inject: function (name, callback) { injected.push(name); return callback() },
      register: function (options, component) {
        registrations.push({ options: options, component: component })
        return function () {}
      },
    },
  }
  plugin.apply(ctx)

  // -------------------------------------------------------------------------
  // 3. 测试夹具：假 remote（记录调用）、会话/投影 state、localStorage 记忆
  // -------------------------------------------------------------------------
  var MODEL_KEY = 'dsh-four-modes.models.v1'
  var DEFAULT_ROSTER = [
    { id: 'standard', name: '标准模式', description: '完整编码 Agent' },
    { id: 'code', name: 'PTC 模式', description: '标准能力 + Code Mode' },
    { id: 'minimal', name: '极简模式', description: '仅持久 Bash 与文件编辑器' },
    { id: 'cordis', name: '创造模式', description: '标准能力 + Cordis 运行时' },
  ]
  var testState = { executeCalls: [], selectCalls: [], listCalls: 0 }
  var sessionState = { byId: {} }
  var projectionState = {}
  var config = {}

  function makeRemote() {
    return {
      agentPresets: {
        list: function () {
          testState.listCalls += 1
          if (config.rosterMode === 'unavailable') {
            return Promise.resolve({ ok: false, error: { code: 'gateway/invocation-unavailable' } })
          }
          if (config.rosterMode === 'throw') {
            return Promise.reject(new Error('roster boom'))
          }
          var presets = config.roster === undefined ? DEFAULT_ROSTER : config.roster
          return Promise.resolve({ ok: true, value: { presets: presets } })
        },
      },
      commands: {
        execute: function (sessionId, line, args) {
          testState.executeCalls.push({ sessionId: sessionId, line: line, args: args })
          if (config.execute === 'remote-failure') {
            return Promise.resolve({ ok: false, error: { code: 'gateway/test', message: 'boom-remote' } })
          }
          if (config.execute === 'command-error') {
            return Promise.resolve({ ok: true, value: { result: { kind: 'error', text: '当前任务正在执行，无法切换模式' } } })
          }
          if (config.execute === 'no-value') {
            return Promise.resolve({ ok: true, value: undefined })
          }
          return Promise.resolve({ ok: true, value: { result: { kind: 'success', text: '已切换' } } })
        },
      },
      session: {
        selectModel: function (selection) {
          testState.selectCalls.push(selection)
          if (config.selectModel === 'fail') {
            return Promise.resolve({ ok: false, error: { message: 'model-missing' } })
          }
          return Promise.resolve({ ok: true, value: { selected: selection } })
        },
      },
    }
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms) })
  }

  async function flush(times) {
    for (var i = 0; i < (times || 3); i += 1) await sleep(0)
  }

  async function setup(next) {
    config = next || {}
    testState.executeCalls.length = 0
    testState.selectCalls.length = 0
    testState.listCalls = 0
    warnings.length = 0
    try { localStorage.clear() } catch (error) { /* storage 可被禁用 */ }
    if (config.models !== undefined) localStorage.setItem(MODEL_KEY, JSON.stringify(config.models))
    window.__remote = makeRemote()
    var sid = config.sessionId === undefined ? 's1' : config.sessionId
    sessionState = { byId: {} }
    if (config.hasSession !== false && sid !== null) {
      sessionState.byId[sid] = {
        projectionValues: { agentPreset: config.agentPreset === undefined ? 'code' : config.agentPreset },
        running: config.running === true,
      }
    }
    projectionState = config.projection === undefined ? {} : config.projection
    if (mounted !== null) mounted = null
    mountRoot(registrations[0].component, {
      sessionId: config.hasSession === false ? undefined : sid,
      useSessions: function (selector) { return selector(sessionState) },
      useProjection: function (name) { return projectionState[name] },
    })
    await flush(4)
  }

  function setSession(next) {
    sessionState = next
    if (mounted !== null) scheduleRender()
  }

  /** 用例中途改写夹具配置：例如先失败、再重试成功。 */
  function setConfig(patch) {
    var keys = Object.keys(patch || {})
    for (var i = 0; i < keys.length; i += 1) config[keys[i]] = patch[keys[i]]
    return true
  }

  /** 夹具状态快照：断言插件没有偷偷改写 session projection（乐观更新只在 chip 上）。 */
  function stateSnapshot() {
    return { session: JSON.parse(JSON.stringify(sessionState)), projection: JSON.parse(JSON.stringify(projectionState)) }
  }

  // -------------------------------------------------------------------------
  // 4. DOM 查询（返回纯数据，便于通过 CDP returnByValue 取回）
  // -------------------------------------------------------------------------
  function chipInfo() {
    var chip = document.querySelector('.dshfm-chip')
    if (chip === null) return null
    var nameNode = chip.querySelector('.dshfm-chip-name')
    var glyphNode = chip.querySelector('.dshfm-chip-glyph')
    return {
      text: (chip.textContent || '').trim(),
      name: nameNode === null ? null : (nameNode.textContent || '').trim(),
      glyph: glyphNode === null ? null : (glyphNode.textContent || ''),
      disabled: chip.disabled === true,
      expanded: chip.getAttribute('aria-expanded'),
      haspopup: chip.getAttribute('aria-haspopup'),
      title: chip.getAttribute('title') || '',
      note: chip.getAttribute('data-note'),
      hasDataNote: chip.hasAttribute('data-note'),
      className: chip.className,
      ariaLabel: chip.getAttribute('aria-label') || '',
    }
  }

  function menuInfo() {
    var menu = document.querySelector('.dshfm-menu')
    if (menu === null) return null
    var items = Array.prototype.slice.call(menu.querySelectorAll('.dshfm-item')).map(function (item) {
      var nameNode = item.querySelector('.dshfm-item-name')
      var hintNode = item.querySelector('.dshfm-item-hint')
      return {
        name: nameNode === null ? null : (nameNode.textContent || '').trim(),
        hint: hintNode === null ? '' : (hintNode.textContent || '').trim(),
        checked: item.getAttribute('aria-checked'),
        active: item.getAttribute('data-active'),
        role: item.getAttribute('role'),
        disabled: item.disabled === true,
        text: (item.textContent || '').trim(),
      }
    })
    var errorNode = menu.querySelector('.dshfm-error')
    var statusNode = menu.querySelector('.dshfm-status')
    var rect = menu.getBoundingClientRect()
    return {
      parentIsBody: menu.parentElement === document.body,
      insideRoot: root.contains(menu),
      role: menu.getAttribute('role'),
      styleTop: menu.style.top,
      styleBottom: menu.style.bottom,
      styleLeft: menu.style.left,
      styleMaxHeight: menu.style.maxHeight,
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
      items: items,
      error: errorNode === null ? null : (errorNode.textContent || '').trim(),
      status:
        statusNode === null
          ? null
          : { text: (statusNode.textContent || '').trim(), kind: statusNode.getAttribute('data-kind') },
    }
  }

  /**
   * 文档中**所有** .dshfm-status（无论是否在菜单内）。
   * 新契约：只有「菜单打开且 statusText 非空」时才渲染，因此菜单关闭时
   * 这张表必须为空 —— 成功静默、失败重开清空都靠它断言。
   */
  function statusInfo() {
    var nodes = Array.prototype.slice.call(document.querySelectorAll('.dshfm-status'))
    return nodes.map(function (node) {
      var box = node.getBoundingClientRect()
      var style = window.getComputedStyle(node)
      return {
        text: (node.textContent || '').trim(),
        kind: node.getAttribute('data-kind'),
        inMenu: node.closest('.dshfm-menu') !== null,
        visible:
          box.width > 0 &&
          box.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden',
      }
    })
  }

  function itemRect(name) {
    var items = Array.prototype.slice.call(document.querySelectorAll('.dshfm-item'))
    for (var i = 0; i < items.length; i += 1) {
      var nameNode = items[i].querySelector('.dshfm-item-name')
      if (nameNode !== null && (nameNode.textContent || '').trim() === name) {
        var rect = items[i].getBoundingClientRect()
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        }
      }
    }
    return null
  }

  function patchAnchorRect(rect) {
    var anchor = document.querySelector('.dshfm-anchor')
    if (anchor === null) throw new Error('harness: .dshfm-anchor 不存在')
    anchor.getBoundingClientRect = function () {
      return {
        left: rect.left,
        top: rect.top,
        right: rect.left + (rect.width || 0),
        bottom: rect.bottom,
        width: rect.width || 0,
        height: rect.height || 0,
        x: rect.left,
        y: rect.top,
      }
    }
    return true
  }

  window.__fm = {
    ready: true,
    registration: registration,
    plugin: plugin,
    injected: injected,
    registrations: registrations,
    setup: setup,
    setSession: setSession,
    setConfig: setConfig,
    stateSnapshot: stateSnapshot,
    chipInfo: chipInfo,
    menuInfo: menuInfo,
    statusInfo: statusInfo,
    itemRect: itemRect,
    patchAnchorRect: patchAnchorRect,
    errors: function () { return errors.slice() },
    warnings: function () { return warnings.slice() },
    testState: testState,
  }
})()
`

// ---------------------------------------------------------------------------
// Node 侧：HTTP 服务 / Chrome 启动 / CDP 客户端 / 断言驱动
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** FM_BROWSER_DEBUG=1 时打印分段耗时/页面状态，用于排查慢用例。 */
const DEBUG = process.env.FM_BROWSER_DEBUG === '1'
function debug(...args) {
  if (DEBUG) console.log('[debug]', ...args)
}

/** 删除临时目录：Chrome 的子进程可能还在写 profile，重试几次；失败也不影响测试结论。 */
async function removeDirBestEffort(dir) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 })
      return true
    } catch (error) {
      await sleep(150)
    }
  }
  return false
}

function sendText(res, status, type, body) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(body)
}

/** 启动静态服务：页面/harness 来自 /tmp/fm-browser，/client.js 直接读真实源码。 */
async function startServer() {
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      if (url.pathname === '/client.js') {
        sendText(res, 200, 'text/javascript; charset=utf-8', readFileSync(CLIENT_PATH))
        return
      }
      if (url.pathname === '/harness.js') {
        sendText(res, 200, 'text/javascript; charset=utf-8', readFileSync(join(TMP_DIR, 'harness.js')))
        return
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        sendText(res, 200, 'text/html; charset=utf-8', readFileSync(join(TMP_DIR, 'index.html')))
        return
      }
      sendText(res, 404, 'text/plain; charset=utf-8', 'not found')
    } catch (error) {
      sendText(res, 500, 'text/plain; charset=utf-8', `server error: ${error.message}`)
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server
}

/** 解析 CDP 目标列表，返回页面 target。 */
async function fetchPageTarget(port) {
  const deadline = Date.now() + 15000
  let lastError = 'timeout'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      if (response.ok) {
        const targets = await response.json()
        const page = Array.isArray(targets) ? targets.find((target) => target.type === 'page') : undefined
        if (page !== undefined && typeof page.webSocketDebuggerUrl === 'string') return page
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await sleep(100)
  }
  throw new Error(`读取 CDP 目标列表失败: ${lastError}`)
}

/** 启动独立的 headless Chrome，从 stderr 里拿到 DevTools 地址，结束时 kill + 清理 profile。 */
async function launchChrome() {
  if (!existsSync(CHROME_BIN)) throw new Error(`找不到 Google Chrome: ${CHROME_BIN}`)
  const profileDir = mkdtempSync(join(TMP_DIR, 'profile-'))
  const child = spawn(
    CHROME_BIN,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-default-apps',
      '--disable-features=Translate,MediaRouter,OptimizationHints',
      '--mute-audio',
      '--hide-scrollbars',
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      // Linux CI (GitHub Actions) runs Chrome as a container user; without these
      // the sandbox aborts before DevTools ever reports a URL.
      ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let stderr = ''
  let stdout = ''
  let devtoolsURL
  try {
    devtoolsURL = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Chrome 20s 内没有报告 DevTools 地址\nstderr:\n${stderr}\nstdout:\n${stdout}`))
      }, 20000)
      const scan = () => {
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(`${stderr}\n${stdout}`)
        if (match !== null) {
          clearTimeout(timer)
          resolve(match[1])
        }
      }
      child.stderr.on('data', (chunk) => {
        if (stderr.length < 200000) stderr += chunk.toString()
        scan()
      })
      child.stdout.on('data', (chunk) => {
        if (stdout.length < 200000) stdout += chunk.toString()
        scan()
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('exit', (code, signal) => {
        clearTimeout(timer)
        reject(new Error(`Chrome 提前退出（code=${code}, signal=${signal}）\nstderr:\n${stderr}`))
      })
    })
  } catch (error) {
    try {
      child.kill('SIGKILL')
    } catch (killError) {
      // 进程可能已退出
    }
    if (profileDir.startsWith(join(TMP_DIR, 'profile-'))) await removeDirBestEffort(profileDir)
    throw error
  }
  const wsMatch = /ws:\/\/127\.0\.0\.1:(\d+)\//.exec(devtoolsURL)
  if (wsMatch === null) throw new Error(`无法从 DevTools 地址解析端口: ${devtoolsURL}`)
  const port = Number(wsMatch[1])
  let version = 'unknown'
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`)
    if (response.ok) {
      const info = await response.json()
      version = String(info.Browser ?? 'unknown').replace('Chrome/', '')
    }
  } catch (error) {
    // 版本号只用于日志，取不到不影响测试
  }

  async function stop() {
    try {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            try {
              child.kill('SIGKILL')
            } catch (error) {
              // 进程可能已退出
            }
            resolve()
          }, 3000)
          child.once('exit', () => {
            clearTimeout(timer)
            resolve()
          })
        })
      }
    } catch (error) {
      // kill 失败不阻断清理
    }
    // 给 Chrome 的各 helper 进程一点退出时间，再尽力删掉临时 user-data-dir。
    await sleep(300)
    if (profileDir.startsWith(join(TMP_DIR, 'profile-'))) {
      const removed = await removeDirBestEffort(profileDir)
      if (!removed) console.warn(`提示：临时目录未能删除（不影响测试结论）: ${profileDir}`)
    }
  }

  return { port, profileDir, version, stop, output: () => ({ stderr, stdout }) }
}

/** 极简 CDP 客户端（Node 24 自带 WebSocket）。 */
class CDP {
  static async connect(wsUrl) {
    if (typeof WebSocket === 'undefined') {
      throw new Error('当前 Node 没有全局 WebSocket（需要 Node 22+）')
    }
    const socket = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', () => reject(new Error(`CDP WebSocket 连接失败: ${wsUrl}`)), { once: true })
    })
    return new CDP(socket)
  }

  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    this.closed = false
    socket.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
      } catch (error) {
        return
      }
      if (message.id === undefined) return
      const pending = this.pending.get(message.id)
      if (pending === undefined) return
      this.pending.delete(message.id)
      if (message.error !== undefined) {
        pending.reject(new Error(`CDP ${pending.method} 失败: ${message.error.message}（code=${message.error.code}）`))
      } else {
        pending.resolve(message.result)
      }
    })
    socket.addEventListener('close', () => {
      this.closed = true
      for (const [, pending] of this.pending) pending.reject(new Error('CDP 连接已关闭'))
      this.pending.clear()
    })
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error(`CDP 连接已关闭，无法发送 ${method}`))
    const id = this.nextId
    this.nextId += 1
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP 调用超时（30s）: ${method}`))
      }, 30000)
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  close() {
    try {
      this.socket.close()
    } catch (error) {
      // 忽略关闭错误
    }
  }
}

// ---------------------------------------------------------------------------
// 页面驱动 helpers
// ---------------------------------------------------------------------------

let cdp = null
let baseURL = ''
let caseIndex = 0

async function evaluate(expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  })
  if (result.exceptionDetails !== undefined) {
    const description =
      result.exceptionDetails.exception?.description ??
      result.exceptionDetails.exception?.value ??
      result.exceptionDetails.text ??
      '未知异常'
    throw new Error(`页面执行抛错: ${description}\n表达式: ${expression.slice(0, 400)}`)
  }
  return result.result?.value
}

async function waitFor(expression, options = {}) {
  const { timeout = 8000, interval = 40, label = expression } = options
  const deadline = Date.now() + timeout
  let lastError
  while (Date.now() < deadline) {
    try {
      const value = await evaluate(expression)
      if (value) return value
      lastError = undefined
    } catch (error) {
      lastError = error
    }
    await sleep(interval)
  }
  throw new Error(
    `等待超时（${timeout}ms）: ${label}` + (lastError === undefined ? '' : `\n最后一次错误: ${lastError.message}`),
  )
}

/** 打开一个全新的页面（独立 URL），建立夹具并挂载控件。 */
async function loadCase(config = {}) {
  caseIndex += 1
  const url = `${baseURL}/index.html?case=${caseIndex}&t=${Date.now()}`
  const t0 = Date.now()
  await cdp.send('Page.navigate', { url })
  const t1 = Date.now()
  await waitFor(`document.readyState === 'complete' && !!(window.__fm && window.__fm.ready)`, {
    label: '页面与 harness 就绪',
  })
  const t2 = Date.now()
  await evaluate(`window.__fm.setup(${JSON.stringify(config)})`)
  const t3 = Date.now()
  if (DEBUG) {
    const probe = await evaluate(`(async () => {
      const startedAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 0));
      return {
        timerDelay: Date.now() - startedAt,
        visibility: document.visibilityState,
        focus: document.hasFocus(),
        readyState: document.readyState,
      };
    })()`)
    debug(`loadCase#${caseIndex} navigate=${t1 - t0}ms ready=${t2 - t1}ms setup=${t3 - t2}ms`, probe)
  }
  await sleep(10)
}

async function chipInfo() {
  return evaluate('window.__fm.chipInfo()')
}

async function menuInfo() {
  return evaluate('window.__fm.menuInfo()')
}

async function pageErrors() {
  return evaluate('window.__fm.errors()')
}

async function expectChipName(name) {
  return waitFor(
    `(() => { const chip = window.__fm.chipInfo(); return chip !== null && chip.name === ${JSON.stringify(name)} ? chip : null })()`,
    { label: `chip 显示「${name}」` },
  )
}

/** 通过真实鼠标事件点击一个选择器命中的元素中心。 */
async function clickSelector(selector) {
  const rect = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (element === null) return null;
    const box = element.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2, width: box.width, height: box.height };
  })()`)
  if (rect === null || rect.width <= 0 || rect.height <= 0) {
    throw new Error(`无法点击 ${selector}（元素不存在或尺寸为 0）`)
  }
  await clickAt(rect.x, rect.y)
  return rect
}

async function clickAt(x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(40)
}

async function mouseDownAt(x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await sleep(40)
}

async function mouseUpAt(x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(40)
}

async function clickItemByName(name) {
  const rect = await evaluate(`window.__fm.itemRect(${JSON.stringify(name)})`)
  if (rect === null || rect.width <= 0 || rect.height <= 0) {
    throw new Error(`菜单项不存在或不可见: ${name}`)
  }
  await clickAt(rect.x, rect.y)
}

/** 真实键盘 Escape（走 CDP Input 键盘管线，而非页面内伪造事件）。 */
async function pressEscape() {
  const key = {
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  }
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
  await sleep(40)
}

async function openMenu() {
  if ((await menuInfo()) === null) {
    await clickSelector('.dshfm-chip')
    await waitFor('window.__fm.menuInfo() !== null', { label: '菜单打开' })
  }
  return menuInfo()
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

const CASES = []
function test(name, fn) {
  CASES.push({ name, fn })
}

test('01. __ModuleLoader__ 注册 factory，apply 注册 conversation.input.left/four-modes', async () => {
  await loadCase({})
  const info = await evaluate(`(() => ({
    moduleId: window.__fm.registration.id,
    hasFactory: typeof window.__fm.registration.factory === 'function',
    hasApply: typeof window.__fm.plugin.apply === 'function',
    exportsInject: window.__fm.plugin.inject,
    injected: window.__fm.injected,
    registrations: window.__fm.registrations.map((entry) => ({ name: entry.options.name, id: entry.options.id })),
  }))()`)
  assert.equal(info.moduleId, 'dsh-four-modes')
  assert.equal(info.hasFactory, true)
  assert.equal(info.hasApply, true)
  assert.deepEqual(info.injected, ['conversation.input.left'])
  assert.equal(info.registrations.length, 1, 'slot 只应注册一个控件')
  assert.equal(info.registrations[0].name, 'conversation.input.left')
  assert.equal(info.registrations[0].id, 'four-modes')
  assert.ok(info.exportsInject.includes('remote.commands'), 'inject 应包含 remote.commands')
})

test('02. chip 显示当前模式：agentPreset=code 且 roster 返回 code → PTC 模式', async () => {
  await loadCase({ agentPreset: 'code' })
  const chip = await expectChipName('PTC 模式')
  assert.equal(chip.disabled, false)
  assert.equal(chip.expanded, 'false')
  assert.equal(chip.haspopup, 'menu')
  assert.ok(chip.text.includes('PTC 模式'), `chip 文本应含 PTC 模式，实际: ${chip.text}`)
  assert.ok(chip.ariaLabel.includes('PTC 模式'), `aria-label 应含 PTC 模式，实际: ${chip.ariaLabel}`)
  const listCalls = await evaluate('window.__fm.testState.listCalls')
  assert.ok(listCalls >= 1, '组件应调用 remote.agentPresets.list()')
})

test('03. 点击 chip 打开菜单：portal 挂到 document.body，四项齐全，当前项 aria-checked=true', async () => {
  await loadCase({ agentPreset: 'code' })
  await expectChipName('PTC 模式')
  await clickSelector('.dshfm-chip')
  await waitFor('window.__fm.menuInfo() !== null', { label: '点击后菜单出现' })
  const menu = await menuInfo()
  assert.equal(menu.parentIsBody, true, '菜单应 portal 到 document.body')
  assert.equal(menu.insideRoot, false, '菜单不应留在 composer 容器内')
  assert.equal(menu.role, 'menu')
  assert.equal(menu.items.length, 4, '应有四项模式')
  assert.deepEqual(menu.items.map((item) => item.name), ['标准模式', 'PTC 模式', '极简模式', '创造模式'])
  for (const item of menu.items) assert.equal(item.role, 'menuitemradio')
  const ptc = menu.items.find((item) => item.name === 'PTC 模式')
  const standard = menu.items.find((item) => item.name === '标准模式')
  assert.equal(ptc.checked, 'true', '当前项 aria-checked 应为 true')
  assert.equal(ptc.active, 'true', '当前项 data-active 应为 true')
  assert.equal(standard.checked, 'false')
  assert.ok(
    menu.rect.top >= 0 && menu.rect.bottom <= VIEWPORT.height + 1,
    `菜单应在视口内，实际 rect=${JSON.stringify(menu.rect)}`,
  )
  const chip = await chipInfo()
  assert.equal(chip.expanded, 'true')
})

test('04. 点击菜单项：execute(sessionId, "/mode standard", []) → selectModel → 菜单关闭、chip 乐观更新', async () => {
  await loadCase({ agentPreset: 'code', models: { standard: { provider: 'p', model: 'm1' } } })
  const menu = await openMenu()
  assert.equal(menu.items.length, 4)
  assert.equal(menu.status, null, '刚打开的菜单不应带状态条')
  await clickItemByName('标准模式')
  const calls = await waitFor(
    'window.__fm.testState.executeCalls.length === 1 ? window.__fm.testState.executeCalls : null',
    { label: 'remote.commands.execute 被调用一次' },
  )
  assert.deepEqual(calls[0], { sessionId: 's1', line: '/mode standard', args: [] })
  const selectCalls = await waitFor(
    'window.__fm.testState.selectCalls.length === 1 ? window.__fm.testState.selectCalls : null',
    { label: 'remote.session.selectModel 被调用一次' },
  )
  assert.deepEqual(selectCalls[0], { sessionId: 's1', provider: 'p', model: 'm1' })
  await waitFor('window.__fm.menuInfo() === null', { label: '切换后菜单关闭' })
  const chip = await expectChipName('标准模式')
  assert.equal(chip.expanded, 'false')
  assert.equal(chip.note, null, '新契约下 chip 不再带 data-note')
  assert.equal(chip.hasDataNote, false, '新契约下 chip 不应再有 data-note 属性')
  assert.deepEqual(await evaluate('window.__fm.statusInfo()'), [], '成功后页面不应残留状态条')
  assert.deepEqual(await pageErrors(), [], '交互过程不应有未捕获异常')
})

test('05. localStorage 有 standard:{provider:p,model:m1} 时，standard 菜单项说明显示 m1', async () => {
  await loadCase({ agentPreset: 'minimal', models: { standard: { provider: 'p', model: 'm1' } } })
  await expectChipName('极简模式')
  const menu = await openMenu()
  const standard = menu.items.find((item) => item.name === '标准模式')
  const ptc = menu.items.find((item) => item.name === 'PTC 模式')
  assert.ok(standard.hint.includes('m1'), `standard 菜单项说明应含 m1，实际: ${standard.hint}`)
  assert.ok(!ptc.hint.includes('m1'), `未记忆的模式不应显示 m1，实际: ${ptc.hint}`)
  const stored = await evaluate(`localStorage.getItem('dsh-four-modes.models.v1')`)
  assert.equal(JSON.parse(stored).standard.model, 'm1')
})

test('06. Escape 关闭菜单', async () => {
  await loadCase({})
  await openMenu()
  await pressEscape()
  await waitFor('window.__fm.menuInfo() === null', { label: 'Escape 后菜单关闭' })
  const chip = await chipInfo()
  assert.equal(chip.expanded, 'false')
})

test('07. 菜单外 mousedown 关闭菜单', async () => {
  await loadCase({})
  await openMenu()
  const point = await evaluate(`(() => {
    const menu = document.querySelector('.dshfm-menu');
    const box = menu.getBoundingClientRect();
    return {
      x: Math.min(window.innerWidth - 8, box.right + 100),
      y: Math.min(window.innerHeight - 8, box.bottom + 100),
    };
  })()`)
  await mouseDownAt(point.x, point.y)
  await mouseUpAt(point.x, point.y)
  await waitFor('window.__fm.menuInfo() === null', { label: '菜单外 mousedown 后菜单关闭' })
})

test('08. running=true 时 chip disabled，点击不打开菜单', async () => {
  await loadCase({ running: true })
  const chip = await waitFor('window.__fm.chipInfo()', { label: 'chip 出现' })
  assert.equal(chip.disabled, true, '任务执行中 chip 应 disabled')
  assert.ok(chip.title.includes('任务执行中'), `标题应说明执行中，实际: ${chip.title}`)
  await clickSelector('.dshfm-chip')
  await sleep(120)
  assert.equal(await menuInfo(), null, 'disabled 时点击不应打开菜单')
})

test('09. sessionId 缺省时 chip disabled', async () => {
  await loadCase({ hasSession: false })
  const chip = await waitFor('window.__fm.chipInfo()', { label: 'chip 出现' })
  assert.equal(chip.disabled, true, '无会话时 chip 应 disabled')
  await clickSelector('.dshfm-chip')
  await sleep(120)
  assert.equal(await menuInfo(), null, '无会话时点击不应打开菜单')
})

test('10. 菜单定位：anchor 贴近视口底部时用 bottom 向上展开（而非 top）', async () => {
  await loadCase({})
  const viewportHeight = await evaluate('window.innerHeight')
  assert.equal(viewportHeight, VIEWPORT.height, '测试视口高度应受 Emulation 控制')
  await evaluate('window.__fm.patchAnchorRect({ left: 100, top: 730, bottom: 760, width: 120, height: 30 })')
  await clickSelector('.dshfm-chip')
  const menu = await waitFor('window.__fm.menuInfo()', { label: '菜单出现' })
  const expectedBottom = `${viewportHeight - 730 + 6}px`
  assert.equal(menu.styleBottom, expectedBottom, `应使用 bottom 定位向上展开，实际 bottom=${menu.styleBottom}`)
  assert.equal(menu.styleTop, '', `向上展开时不应设置 top，实际 top=${menu.styleTop}`)
  assert.equal(menu.styleLeft, '100px')
  assert.equal(menu.styleMaxHeight, '720px')
  assert.ok(menu.rect.bottom <= 730, `菜单底边应在 anchor 上方，实际 ${menu.rect.bottom} > 730`)
})

test('11. 菜单定位：anchor 靠近视口顶部时用 top 向下展开', async () => {
  await loadCase({})
  const viewportHeight = await evaluate('window.innerHeight')
  await evaluate('window.__fm.patchAnchorRect({ left: 40, top: 100, bottom: 130, width: 120, height: 30 })')
  await clickSelector('.dshfm-chip')
  const menu = await waitFor('window.__fm.menuInfo()', { label: '菜单出现' })
  assert.equal(menu.styleTop, '136px')
  assert.equal(menu.styleBottom, '', '向下展开时不应设置 bottom')
  assert.equal(menu.styleLeft, '40px')
  assert.equal(menu.styleMaxHeight, `${viewportHeight - 130 - 10}px`)
})

test('12. 失败路径：execute 返回 {ok:false} → 菜单保持打开、状态条 data-kind=err 含错误', async () => {
  await loadCase({ execute: 'remote-failure' })
  await openMenu()
  await clickItemByName('标准模式')
  await waitFor('window.__fm.testState.executeCalls.length === 1', { label: 'execute 被调用' })
  const menu = await waitFor(
    `(() => { const info = window.__fm.menuInfo(); return info !== null && info.status !== null ? info : null })()`,
    { label: '失败后菜单保持打开并出现状态条' },
  )
  assert.equal(menu.role, 'menu')
  assert.equal(menu.status.kind, 'err', '失败状态条 data-kind 应为 err')
  assert.ok(menu.status.text.includes('boom-remote'), `状态条应含 Remote 错误，实际: ${menu.status.text}`)
  assert.ok(menu.status.text.includes('切换失败'), `状态条应说明切换失败，实际: ${menu.status.text}`)
  const statuses = await evaluate('window.__fm.statusInfo()')
  assert.equal(statuses.length, 1, `文档中应恰好一个状态条，实际: ${JSON.stringify(statuses)}`)
  assert.equal(statuses[0].inMenu, true, '状态条必须渲染在菜单内部')
  assert.equal(statuses[0].visible, true, '状态条应可见')
  assert.equal(statuses[0].kind, 'err')
  const chip = await chipInfo()
  assert.equal(chip.expanded, 'true', '失败后菜单保持打开，aria-expanded 应为 true')
  assert.ok(chip.title.includes('boom-remote'), `chip 标题应含 Remote 错误，实际: ${chip.title}`)
  assert.ok(chip.title.includes('切换失败'), `chip 标题应含「切换失败」，实际: ${chip.title}`)
  assert.equal(chip.hasDataNote, false, '失败时 chip 也不应有 data-note')
  assert.equal(chip.name, 'PTC 模式', '失败时 chip 标签保持当前模式（不做乐观更新）')
  assert.equal(chip.disabled, false, '失败后控件应恢复可点')
  assert.deepEqual(await pageErrors(), [], '失败路径不应产生未捕获异常')
})

test('13. 失败路径：execute 返回 kind:"error" → 状态条显示 Host 文本，菜单保持打开', async () => {
  await loadCase({ execute: 'command-error' })
  await openMenu()
  await clickItemByName('极简模式')
  await waitFor('window.__fm.testState.executeCalls.length === 1', { label: 'execute 被调用' })
  const menu = await waitFor(
    `(() => { const info = window.__fm.menuInfo(); return info !== null && info.status !== null ? info : null })()`,
    { label: '失败后菜单保持打开并出现状态条' },
  )
  assert.equal(menu.status.kind, 'err')
  assert.ok(
    menu.status.text.includes('当前任务正在执行，无法切换模式'),
    `状态条应含 Host 返回的错误文本，实际: ${menu.status.text}`,
  )
  const chip = await chipInfo()
  assert.ok(
    chip.title.includes('当前任务正在执行，无法切换模式'),
    `chip 标题应含 Host 文本，实际: ${chip.title}`,
  )
  assert.equal(chip.name, 'PTC 模式', '失败时不做乐观更新，chip 仍显示当前模式')
  assert.equal(chip.expanded, 'true')
  assert.deepEqual(await pageErrors(), [], '失败路径不应产生未捕获异常')
})

test('14. 成功切换且无记忆模型时不调用 selectModel；chip 静默显示目标模式', async () => {
  await loadCase({ agentPreset: 'code' })
  const before = await chipInfo()
  await openMenu()
  await clickItemByName('极简模式')
  const calls = await waitFor(
    'window.__fm.testState.executeCalls.length === 1 ? window.__fm.testState.executeCalls : null',
    { label: 'execute 被调用一次' },
  )
  assert.deepEqual(calls[0], { sessionId: 's1', line: '/mode minimal', args: [] })
  await waitFor('window.__fm.menuInfo() === null', { label: '切换后菜单关闭' })
  await sleep(80)
  assert.equal(await evaluate('window.__fm.testState.selectCalls.length'), 0, '无记忆模型时不应调用 selectModel')
  const chip = await expectChipName('极简模式')
  assert.equal(chip.note, null, '新契约下 chip 不再带 data-note')
  assert.equal(chip.hasDataNote, false, '成功静默：chip 不应有 data-note')
  assert.ok(!chip.text.includes('已切换'), `成功静默：chip 不应闪「已切换」，实际: ${chip.text}`)
  assert.equal(chip.title, before.title, '成功静默：chip 标题不应变化')
  assert.equal(chip.expanded, 'false')
  assert.deepEqual(await evaluate('window.__fm.statusInfo()'), [], '成功后页面不应残留状态条')
  assert.deepEqual(await pageErrors(), [], '交互过程不应有未捕获异常')
})

test('15. roster 不可用（gateway/invocation-unavailable）时回退四项仍可用', async () => {
  await loadCase({ rosterMode: 'unavailable' })
  await expectChipName('PTC 模式')
  const menu = await openMenu()
  assert.equal(menu.items.length, 4)
  assert.deepEqual(menu.items.map((item) => item.name), ['标准模式', 'PTC 模式', '极简模式', '创造模式'])
  assert.equal(menu.items.find((item) => item.name === 'PTC 模式').checked, 'true')
})

test('16. roster 抛错时回退四项且不崩溃', async () => {
  await loadCase({ rosterMode: 'throw' })
  await expectChipName('PTC 模式')
  const menu = await openMenu()
  assert.equal(menu.items.length, 4)
  assert.deepEqual(await pageErrors(), [], 'roster 抛错应被插件吞掉，不产生未捕获异常')
})

test('17. 记忆模型切换失败：模式切换仍成功、菜单关闭、无可见错误，只 console.warn', async () => {
  await loadCase({
    agentPreset: 'code',
    models: { standard: { provider: 'p', model: 'm1' } },
    selectModel: 'fail',
  })
  await openMenu()
  await clickItemByName('标准模式')
  await waitFor('window.__fm.testState.executeCalls.length === 1', { label: 'execute 被调用' })
  await waitFor('window.__fm.testState.selectCalls.length === 1', { label: 'selectModel 被调用' })
  await waitFor('window.__fm.menuInfo() === null', { label: '模式切换成功后菜单关闭' })
  const chip = await expectChipName('标准模式')
  assert.equal(chip.hasDataNote, false)
  assert.ok(!chip.title.includes('model-missing'), `记忆模型失败不应出现在 chip 标题，实际: ${chip.title}`)
  assert.ok(
    !chip.title.includes('记忆的模型切换失败'),
    `旧契约的「记忆的模型切换失败」提示不应再出现，实际: ${chip.title}`,
  )
  assert.deepEqual(await evaluate('window.__fm.statusInfo()'), [], '记忆模型失败不应渲染任何状态条')
  const warnings = await waitFor(
    'window.__fm.warnings().length > 0 ? window.__fm.warnings() : null',
    { label: 'console.warn 被调用' },
  )
  assert.ok(
    warnings.some((line) => line.includes('[dsh-four-modes]')),
    `console.warn 应带 [dsh-four-modes] 前缀，实际: ${JSON.stringify(warnings)}`,
  )
  assert.ok(
    warnings.some((line) => line.includes('remembered model did not apply')),
    `console.warn 应说明记忆模型未生效，实际: ${JSON.stringify(warnings)}`,
  )
  assert.deepEqual(await pageErrors(), [], '模型切换失败不应产生未捕获异常')
})

test('18. 失败后重新打开菜单：状态条清空，chip 标题不再带错误', async () => {
  await loadCase({ execute: 'remote-failure' })
  await openMenu()
  await clickItemByName('标准模式')
  const failedMenu = await waitFor(
    `(() => { const info = window.__fm.menuInfo(); return info !== null && info.status !== null ? info : null })()`,
    { label: '失败状态条出现' },
  )
  assert.equal(failedMenu.status.kind, 'err')
  await pressEscape()
  await waitFor('window.__fm.menuInfo() === null', { label: 'Escape 关闭失败菜单' })
  assert.deepEqual(await evaluate('window.__fm.statusInfo()'), [], '菜单关闭后不应残留状态条')
  const reopened = await openMenu()
  assert.equal(reopened.status, null, '重新打开的新菜单不应显示上一次失败的状态条')
  const chip = await chipInfo()
  assert.equal(chip.expanded, 'true')
  assert.ok(!chip.title.includes('boom-remote'), `重新打开后 chip 标题不应再带错误，实际: ${chip.title}`)
  assert.deepEqual(await evaluate('window.__fm.statusInfo()'), [], '无状态的新菜单不应渲染 .dshfm-status')
  assert.deepEqual(await pageErrors(), [], '重开过程不应产生未捕获异常')
})

test('19. 菜单未打开时不渲染 .dshfm-status（初始态 / 关闭态）', async () => {
  await loadCase({})
  assert.equal(await menuInfo(), null, '初始菜单应为关闭')
  assert.deepEqual(await evaluate('window.__fm.statusInfo()'), [], '菜单未打开时文档中不应有状态条')
  const menu = await openMenu()
  assert.equal(menu.status, null, '没有失败时菜单不应有状态条')
  await pressEscape()
  await waitFor('window.__fm.menuInfo() === null', { label: 'Escape 关闭菜单' })
  assert.deepEqual(await evaluate('window.__fm.statusInfo()'), [], '菜单关闭后文档中不应有状态条')
})

test('20. 成功静默：chip 无 aria/data-note 变化噪音，状态条只可能出现在菜单内', async () => {
  await loadCase({ agentPreset: 'code' })
  const before = await chipInfo()
  assert.equal(before.note, null)
  assert.equal(before.className, 'dshfm-chip', 'chip 样式类应保持静态')
  await openMenu()
  await clickItemByName('极简模式')
  await waitFor('window.__fm.menuInfo() === null', { label: '切换后菜单关闭' })
  const after = await expectChipName('极简模式')
  assert.equal(after.className, 'dshfm-chip', '成功不应给 chip 叠加状态类')
  assert.equal(after.hasDataNote, false, '成功静默：chip 不应再携带 data-note')
  assert.equal(after.haspopup, before.haspopup, 'aria-haspopup 不应变化')
  assert.equal(after.disabled, false)
  assert.equal(after.expanded, 'false', '菜单关闭后 aria-expanded 应复位为 false')
  assert.ok(!after.text.includes('已切换'), '成功静默：chip 文本不应出现「已切换」')
  assert.deepEqual(await evaluate('window.__fm.statusInfo()'), [], '菜单关闭时页面任何位置都不应有状态条')
})

test('21. 乐观更新：projection 仍是旧模式时，成功后 chip 立即显示目标模式', async () => {
  await loadCase({ agentPreset: 'code' })
  const before = await evaluate('window.__fm.stateSnapshot()')
  assert.equal(before.session.byId.s1.projectionValues.agentPreset, 'code', '夹具初始 projection 应为 code')
  await openMenu()
  await clickItemByName('极简模式')
  await waitFor('window.__fm.menuInfo() === null', { label: '切换后菜单关闭' })
  const chip = await expectChipName('极简模式')
  const after = await evaluate('window.__fm.stateSnapshot()')
  assert.equal(
    after.session.byId.s1.projectionValues.agentPreset,
    'code',
    '测试夹具不更新 projection：chip 必须靠本地 picked 乐观更新',
  )
  assert.ok(!chip.title.includes('切换失败'), `成功切换后 chip 标题不应带错误，实际: ${chip.title}`)
  assert.deepEqual(await pageErrors(), [], '交互过程不应有未捕获异常')
})

test('22. 失败可重试：失败后菜单保持打开，再点另一项成功后菜单关闭且状态条消失', async () => {
  await loadCase({ execute: 'remote-failure' })
  await openMenu()
  await clickItemByName('标准模式')
  const failed = await waitFor(
    `(() => { const info = window.__fm.menuInfo(); return info !== null && info.status !== null ? info : null })()`,
    { label: '第一次失败状态条出现' },
  )
  assert.equal(failed.status.kind, 'err')
  await evaluate(`window.__fm.setConfig({ execute: 'ok' })`)
  await clickItemByName('极简模式')
  await waitFor('window.__fm.testState.executeCalls.length === 2', { label: '重试时 execute 再次被调用' })
  await waitFor('window.__fm.menuInfo() === null', { label: '重试成功后菜单关闭' })
  const chip = await expectChipName('极简模式')
  assert.ok(!chip.title.includes('boom-remote'), `成功后 chip 标题不应残留旧错误，实际: ${chip.title}`)
  assert.deepEqual(await evaluate('window.__fm.statusInfo()'), [], '成功后状态条应随菜单一起消失')
  assert.deepEqual(await pageErrors(), [], '重试过程不应产生未捕获异常')
})

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function formatError(error) {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`
  return String(error)
}

async function main() {
  mkdirSync(TMP_DIR, { recursive: true })
  writeFileSync(join(TMP_DIR, 'index.html'), PAGE_HTML, 'utf8')
  writeFileSync(join(TMP_DIR, 'harness.js'), HARNESS_JS, 'utf8')

  const server = await startServer()
  baseURL = `http://127.0.0.1:${server.address().port}`
  let chrome = null
  let passed = 0
  const failed = []

  try {
    const browserStartedAt = Date.now()
    chrome = await launchChrome()
    const pageTarget = await fetchPageTarget(chrome.port)
    cdp = await CDP.connect(pageTarget.webSocketDebuggerUrl)
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    await cdp.send('Page.bringToFront')
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
    })
    // headless 下真实键盘 Escape 可能让页面变成 hidden/focus=false，随后 Input
    // 事件要等帧才被接受（每个点击卡 ~5s）。模拟「页面始终聚焦」可避免这个坑。
    try {
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    } catch (error) {
      debug('Emulation.setFocusEmulationEnabled 不可用（继续执行）:', error.message)
    }

    console.log(`浏览器：${CHROME_BIN} --headless=new（Chrome ${chrome.version}）`)
    console.log(`启动耗时：${Date.now() - browserStartedAt}ms`)
    console.log(`页面服务：${baseURL}；DevTools 端口：${chrome.port}；user-data-dir：${chrome.profileDir}`)
    console.log('')

    for (const testCase of CASES) {
      const startedAt = Date.now()
      try {
        await testCase.fn()
        passed += 1
        console.log(`PASS ${testCase.name}（${Date.now() - startedAt}ms）`)
      } catch (error) {
        failed.push({ name: testCase.name, error })
        console.log(`FAIL ${testCase.name}（${Date.now() - startedAt}ms）`)
        for (const line of formatError(error).split('\n')) console.log(`     ${line}`)
      }
    }
  } finally {
    try {
      if (cdp !== null) cdp.close()
    } catch (error) {
      // 忽略关闭错误
    }
    try {
      if (chrome !== null) await chrome.stop()
    } catch (error) {
      console.warn(`提示：关闭 Chrome 时出错（不影响测试结论）: ${formatError(error)}`)
    }
    // 浏览器/keep-alive 连接可能让 server.close() 迟迟不回调：先断开再关。
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000)
      server.close(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  console.log('')
  console.log('———————— 测试结果 ————————')
  console.log(`共 ${CASES.length} 个用例，通过 ${passed}，失败 ${failed.length}`)
  if (failed.length > 0) {
    console.log('失败明细：')
    for (const item of failed) {
      console.log(`  - ${item.name}`)
      for (const line of formatError(item.error).split('\n')) console.log(`      ${line}`)
    }
  }
  // 显式退出：确保 Chrome helper / 定时器不会拖住事件循环。
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('测试基础设施失败：')
  console.error(formatError(error))
  process.exit(1)
})
