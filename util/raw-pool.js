// RAW 缓存后台解码线程池
// libraw 解码是 CPU 密集的原生调用，若在主进程执行会长期占用事件循环导致界面卡顿，
// 故投递给 worker 线程执行，主进程只负责调度与结果汇总。
//
// 健壮性要求（本文件的核心约束）：
//   1) 任何一个文件解码失败/超时/worker 崩溃，都不得中断后续文件的缓存生成；
//   2) 每个请求都必须有确定结果（成功或失败），不允许永久挂起；
//   3) 不允许出现 spawn→立刻退出→再 spawn 的无限重启循环；
//   4) 超时卡死的 worker 必须被强制回收，否则会永久占用池内名额，导致后续缓存不再生成。
'use strict'
const { Worker } = require('worker_threads')

const DEFAULT_POOL = 2
const DEFAULT_TIMEOUT = 60000
const DEFAULT_MAX_SPAWN_FAILURES = 5
// worker 连续“刚启动就异常退出”达到阈值后的降级冷却时长：
// 期间不再尝试 spawn（避免死循环），但仍会以失败结果返回，调用方改走内嵌预览兜底继续出缓存。
const DEGRADE_COOLDOWN = 30000

// opts: { workerPath, poolSize=2, timeoutMs=60000, maxSpawnFailures=5, onReady(cache), onLog(msg) }
function createRawPool(opts) {
    const workerPath = opts.workerPath
    const poolSize = opts.poolSize || DEFAULT_POOL
    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT
    const maxSpawnFailures = opts.maxSpawnFailures || DEFAULT_MAX_SPAWN_FAILURES
    const onReady = typeof opts.onReady === 'function' ? opts.onReady : function () {}
    const onLog = typeof opts.onLog === 'function' ? opts.onLog : function () {}

    // 统一日志出口：logger 失败绝不影响池运行
    function dbg(msg, extra) {
        try { onLog(`[raw-pool] ${msg}`, extra) } catch (e) { /* 忽略日志异常 */ }
    }

    const workers = []          // 在册 worker（附带 _busy/_curId 等状态）
    const queue = []            // 待派发任务 { id, fp, cache, full, waiters[] }
    const byId = new Map()      // id -> 在途任务 { id, fp, cache, full, settled, waiters[] }
    let seq = 0
    let spawnFailures = 0       // 连续“刚启动就退出”次数
    let degradedUntil = 0       // 降级冷却截止时间戳
    let closed = false          // 池已关闭后不再派发/重启

    function isDegraded() { return degradedUntil > Date.now() }

    function safeOnReady(cache) {
        try { onReady(cache) } catch (e) { /* 通知失败不影响池运行 */ }
    }

    // 结算任务：保证每个等待者只被回调一次
    function settle(entry, ok) {
        if (!entry || entry.settled) return
        entry.settled = true
        const waiters = entry.waiters || []
        entry.waiters = []
        for (const r of waiters) { try { r(ok === true) } catch (e) { /* 忽略调用方异常 */ } }
    }

    // 降级：清空队列（全部以失败结算，调用方会走兜底），并在冷却期内停止 spawn
    function degrade() {
        dbg(`连续异常启动达 ${maxSpawnFailures} 次，进入降级冷却 ${DEGRADE_COOLDOWN}ms，清空 ${queue.length} 个排队任务`)
        degradedUntil = Date.now() + DEGRADE_COOLDOWN
        spawnFailures = 0
        while (queue.length) {
            const t = queue.shift()
            for (const r of t.waiters) { try { r(false) } catch (e) {} }
        }
    }

    function removeWorker(w) {
        const i = workers.indexOf(w)
        if (i >= 0) workers.splice(i, 1)
    }

    function clearTimer(w) {
        if (w._timer) { clearTimeout(w._timer); w._timer = null }
    }

    // 回收一个 worker：结算其当前任务、清定时器、移出列表并终止线程
    function retire(w, ok) {
        if (w._dead) return
        w._dead = true
        const id = w._curId
        w._curId = null
        w._busy = false
        clearTimer(w)
        if (id != null) {
            const entry = byId.get(id)
            byId.delete(id)
            settle(entry, ok)
        }
        // “刚起来就死”（未完成任何任务且存活不足 1s）视为异常启动，累计用于触发降级
        if (w._done === 0 && Date.now() - w._spawnAt < 1000) {
            spawnFailures++
            dbg(`线程 threadId=${w.threadId} 刚启动即退出（累计 ${spawnFailures}/${maxSpawnFailures}）`)
        } else {
            spawnFailures = 0
            if (w._done > 0) dbg(`线程 threadId=${w.threadId} 退役，已完成 ${w._done} 个任务`)
            else dbg(`线程 threadId=${w.threadId} 退役`)
        }
        removeWorker(w)
        try { w.terminate() } catch (e) { /* 已退出则忽略 */ }
        if (spawnFailures >= maxSpawnFailures) { degrade(); return }
        pump()
    }

    function spawn() {
        let w
        try {
            w = new Worker(workerPath)
        } catch (e) {
            // 构造即失败（路径不存在等）：累计后可能降级，绝不无限重试
            spawnFailures++
            if (spawnFailures >= maxSpawnFailures) degrade()
            return false
        }
        w._busy = false
        w._curId = null
        w._dead = false
        w._done = 0
        w._timer = null
        w._spawnAt = Date.now()
        dbg(`后台解码线程已启动, threadId=${w.threadId}, 当前在册=${workers.length + 1}/${poolSize}`)
        w.on('message', (msg) => {
            if (w._dead) return
            // worker 自带日志，直接转发给调用方（状态栏/控制台可见）
            if (msg && msg.type === 'log') { dbg(msg.msg); return }
            const id = msg ? msg.id : null
            const entry = (id != null) ? byId.get(id) : null
            if (id != null) byId.delete(id)
            clearTimer(w)
            w._busy = false
            w._curId = null
            w._done++
            spawnFailures = 0
            const ok = !!(msg && msg.ok === true)
            settle(entry, ok)
            dbg(`任务 id=${id} 处理完成, 源=${entry ? entry.fp : ''} 是否成功=${ok}${msg && msg.ms ? ` 用时=${msg.ms}ms` : ''}`)
            // 即便该任务已因超时结算，这里仍要通知渲染端：缓存文件此时才真正落盘
            if (ok) safeOnReady(msg.cache)
            pump()
        })
        w.on('error', () => { retire(w, false) })
        w.on('exit', () => { retire(w, false) })
        workers.push(w)
        return true
    }

    function pump() {
        if (closed || isDegraded()) return
        if (degradedUntil) { degradedUntil = 0; spawnFailures = 0 }  // 冷却结束，恢复尝试
        // guard 兜底：即便 spawn 逻辑异常也不会在此处空转
        let guard = poolSize + 1
        while (workers.length < poolSize && guard-- > 0) {
            if (!spawn()) return
        }
        for (const w of workers) {
            if (w._dead || w._busy || queue.length === 0) continue
            const task = queue.shift()
            w._busy = true
            w._curId = task.id
            const entry = { id: task.id, fp: task.fp, cache: task.cache, full: task.full, settled: false, waiters: task.waiters }
            byId.set(task.id, entry)
            dbg(`任务 id=${task.id} 派发给线程 threadId=${w.threadId}, 源=${task.fp}, 排队剩余=${queue.length}`)
            if (timeoutMs > 0) {
                w._timer = setTimeout(() => {
                    w._timer = null
                    // 卡死的 worker：结算该任务并强制回收线程，
                    // 否则它会永久占用名额，使后续缓存再也无法生成
                    dbg(`任务 id=${entry.id} 在 ${timeoutMs}ms 内未完成，回收线程 threadId=${w.threadId}（源=${entry.fp} 超时）`)
                    retire(w, false)
                }, timeoutMs)
            }
            try {
                w.postMessage({ id: task.id, fp: task.fp, cache: task.cache, full: task.full === true })
            } catch (e) {
                // 派发失败：结算该任务（调用方走兜底）并回收 worker，不重排以免形成循环
                retire(w, false)
            }
        }
    }

    // 请求后台解码，返回 Promise<boolean>（永不 reject、永不挂起）。
    // opts.full = true 时按全尺寸（不缩放）解码，用于格式转换等需要原始分辨率的场景。
    // 同一 cache 的并发请求合并为一次解码。
    function decode(fp, cache, opts) {
        const full = !!(opts && opts.full)
        return new Promise((resolve) => {
            // 已关闭或降级中直接返回失败，调用方改走内嵌预览兜底，保证缓存仍能生成
            if (closed || isDegraded()) { resolve(false); return }
            for (const q of queue) {
                if (q.cache === cache) { q.waiters.push(resolve); return }
            }
            for (const t of byId.values()) {
                if (t.cache === cache) {
                    // 已结算（如刚超时）的条目不再挂等待者，避免新请求永久等待
                    if (t.settled) { resolve(false); return }
                    t.waiters.push(resolve)
                    return
                }
            }
            queue.push({ id: ++seq, fp, cache, full, waiters: [resolve] })
            dbg(`收到解码请求 id=${seq}, 源=${fp}, 合并后排队=${queue.length}, 在册线程=${workers.length}/${poolSize}`)
            pump()
        })
    }

    // 关闭池：结算所有在途/排队任务，终止全部 worker
    function close() {
        closed = true
        for (const w of workers.slice()) retire(w, false)
        workers.length = 0
        while (queue.length) {
            const t = queue.shift()
            for (const r of t.waiters) { try { r(false) } catch (e) {} }
        }
        byId.clear()
    }

    return {
        decode,
        close,
        size: () => workers.length,
        pending: () => queue.length,
        degraded: isDegraded,
    }
}

module.exports = { createRawPool }
