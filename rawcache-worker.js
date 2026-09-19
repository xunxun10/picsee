// RAW 缓存解码工作线程：在后台线程直连 LibRaw（native/ 下的自研 N-API 插件）解码 RAW，
// 再用 sharp 缩放/编码写出缓存 JPG，避免在主进程占用事件循环造成界面卡顿。
// 只负责 demosaic 出图，不含内嵌预览兜底（兜底用 electron nativeImage，主进程才能访问，留在 main.js 中）。
//
// 朝向说明（完整旋转方案见 util/raw-rotate.js 顶部说明）：
// 插件除 half_size 外沿用 LibRaw 默认参数，user_flip = -1，会按相机 EXIF 朝向直接输出
// 已摆正的像素（90°/270° 时宽高互换），因此这里写出的缓存已是正的，不要再做旋转，
// 否则会双重旋转。
'use strict'
const { parentPort, threadId } = require('worker_threads')
const fs = require('fs')
const path = require('path')

const Exif = require('./util/exif')
const { loadRawAddon } = require('./util/raw-addon')

// RAW 缓存 JPG 的编码质量（显示缓存与全尺寸转换缓存共用）；
// 与渲染端格式转换输出质量 JPG_REENCODE_Q（renderer.js）取值一致
const RAW_CACHE_JPEG_Q = 95

// 显示缓存的长边上限（半尺寸解码后再按 inside 缩放，不放大）
const DISPLAY_CACHE_MAX_EDGE = 3200

// sharp 只加载一次：undefined 表示尚未尝试，null 表示加载失败，其余为模块对象
let sharpCache = undefined

// 插件加载结果是否已播报（每线程各一次）
let addonReported = false

// worker 日志：既打到主进程控制台，也作为 type:'log' 消息回传，由池转发到调用方（状态栏可见）
function workerLog(msg) {
    try { console.log(`[raw-worker:${threadId}] ${msg}`) } catch (e) {}
    try { parentPort.postMessage({ type: 'log', msg: `[raw-worker:${threadId}] ${msg}` }) } catch (e) {}
}

// 加载原生插件；失败返回 null，任务按失败结束，主进程改走内嵌预览兜底。
// 加载结果只播报一次（每线程各一次），避免每个任务都刷同样的日志。
function loadNativeAddon() {
    const r = loadRawAddon()
    if (!addonReported) {
        addonReported = true
        if (r.addon) workerLog(`原生插件已加载: ${r.path}（LibRaw ${r.addon.version()}）`)
        else workerLog(`原生插件加载失败（将改走内嵌预览兜底）: ${r.path} -> ${r.error}`)
    }
    return r.addon
}

// sharp 只用于缩放与 JPEG 编码；单独加载并单独记日志，便于区分“sharp 装不上”和“RAW 解不了”
function loadSharp() {
    if (sharpCache !== undefined) return sharpCache
    try {
        sharpCache = require('sharp')
    } catch (e) {
        sharpCache = null
        workerLog(`sharp 加载失败，无法生成缓存 JPG（将改走内嵌预览兜底）: ${e && e.message}`)
    }
    return sharpCache
}

// 把插件返回的 RGB 像素缩放（仅显示缓存）并编码成 JPEG
function encodeCacheJpeg(decoded, sharp, full) {
    let pipeline = sharp(decoded.data, {
        raw: { width: decoded.width, height: decoded.height, channels: decoded.colors },
    })
    if (!full) {
        pipeline = pipeline.resize(DISPLAY_CACHE_MAX_EDGE, DISPLAY_CACHE_MAX_EDGE, {
            fit: 'inside',
            withoutEnlargement: true,
        })
    }
    return pipeline.jpeg({ quality: RAW_CACHE_JPEG_Q }).toBuffer()
}

async function decodeViaNative(fp, cache, full) {
    const t0 = Date.now()
    const addon = loadNativeAddon()
    if (!addon) return false
    try {
        workerLog(`插件开始解码: ${fp}${full ? '（全尺寸）' : ''}`)
        let decoded = null
        // 显示缓存：优先 half_size 半尺寸解码（实测约为全尺寸 1/4），失败回退全尺寸；
        // 全尺寸任务（格式转换用）：直接全尺寸且不缩放，跳过半尺寸尝试
        if (full) {
            try {
                workerLog(`插件全尺寸解码（不缩放）: ${fp}`)
                decoded = addon.decode(fp, { halfSize: false })
                workerLog(`插件全尺寸解码完成 ${Date.now() - t0}ms, ${decoded.width}x${decoded.height}, flip=${decoded.flip}`)
            } catch (e) { workerLog(`插件全尺寸解码异常: ${e && e.message}`); decoded = null }
        } else {
            try {
                workerLog(`插件尝试半尺寸解码: ${fp}`)
                decoded = addon.decode(fp, { halfSize: true })
                workerLog(`插件半尺寸解码完成 ${Date.now() - t0}ms, ${decoded.width}x${decoded.height}, flip=${decoded.flip}`)
            } catch (e) { workerLog(`插件半尺寸解码异常: ${e && e.message}`); decoded = null }
            if (!decoded || !decoded.data || !decoded.data.length) {
                workerLog(`半尺寸未产出数据，回退全尺寸解码: ${fp}（已用 ${Date.now() - t0}ms）`)
                try {
                    decoded = addon.decode(fp, { halfSize: false })
                    workerLog(`插件全尺寸解码完成 ${Date.now() - t0}ms, ${decoded.width}x${decoded.height}, flip=${decoded.flip}`)
                } catch (e) { workerLog(`插件全尺寸解码异常: ${e && e.message}`); decoded = null }
            }
        }
        if (!decoded || !decoded.data || !decoded.data.length) {
            workerLog(`插件解码未产出数据: ${fp}`)
            return false
        }

        const sharp = loadSharp()
        if (!sharp) return false

        let out = null
        try {
            out = await encodeCacheJpeg(decoded, sharp, full)
        } catch (e) {
            workerLog(`缓存 JPG 编码异常: ${e && e.message}`)
            return false
        }
        if (!out || !out.length) {
            workerLog(`缓存 JPG 未产出数据: ${fp}`)
            return false
        }

        fs.mkdirSync(path.dirname(cache), { recursive: true })
        // 全尺寸缓存：嵌入从源 RAW 读出的 EXIF，让缓存文件被外部看图器打开时也保留拍摄参数。
        // 执行幂等（每次生成都会重写）；失败不影响像素写入，仅丢弃 EXIF。
        if (full) {
            try {
                const app1 = await Exif.buildRawExifApp1(fp)
                if (app1 && app1.length) out = Exif.embedExifApp1(out, app1)
            } catch (e) { workerLog(`EXIF 嵌入失败，忽略（${e && e.message}）`) }
        }
        fs.writeFileSync(cache, out)
        workerLog(`缓存已写入: ${cache}（总耗时 ${Date.now() - t0}ms, ${out.length} 字节）`)
        return true
    } catch (e) {
        workerLog(`插件解码异常: ${e && e.message}`)
        return false
    }
}

parentPort.on('message', async (task) => {
    const t0 = Date.now()
    const id = task && task.id
    const fp = task && task.fp
    const cache = task && task.cache
    const full = task && task.full === true
    workerLog(`线程开始执行任务 id=${id}, 会话线程=${threadId}, 源=${fp || ''}, 目标缓存=${cache || ''}${full ? ', 全尺寸' : ''}`)
    let ok = false
    try {
        // 参数异常（task 为空、路径缺失）也按失败处理，不让异常逃逸出处理器
        if (fp && cache) ok = await decodeViaNative(fp, cache, full)
        else workerLog(`任务参数缺失: id=${id}`)
    } catch (e) {
        workerLog(`任务执行异常: ${e && e.message}`)
        ok = false
    }
    workerLog(`线程结束任务 id=${id}, 源=${fp || ''} 结果=${ok === true}（总耗时 ${Date.now() - t0}ms）`)
    try {
        parentPort.postMessage({
            id: id,
            ok: ok === true,
            cache: cache,
            ms: Date.now() - t0,
        })
    } catch (e) {
        // 回传失败无法补救；主进程侧有超时与回收机制兜底，不会永久等待
    }
})