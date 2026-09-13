// RAW 缓存解码工作线程：在后台线程用 lightdrift-libraw 解码 RAW 并写出缓存 JPG，
// 避免在主进程占用事件循环造成界面卡顿。只负责 demosaic 出图，不含内嵌预览兜底
// （兜底用 electron nativeImage，主进程才能访问，留在 main.js 中）。
//
// 朝向说明（完整旋转方案见 util/raw-rotate.js 顶部说明）：
// libraw 默认 user_flip = -1，会按相机 EXIF 朝向直接输出已摆正的像素（90°/270° 时宽高互换），
// 因此这里写出的缓存已是正的，不要再做旋转，否则会双重旋转。
'use strict'
const { parentPort, threadId } = require('worker_threads')
const fs = require('fs')
const path = require('path')

// RAW 缓存 JPG 的编码质量（显示缓存与全尺寸转换缓存共用）；
// 与渲染端格式转换输出质量 JPG_REENCODE_Q（renderer.js）取值一致
const RAW_CACHE_JPEG_Q = 95

// worker 日志：既打到主进程控制台，也作为 type:'log' 消息回传，由池转发到调用方（状态栏可见）
function workerLog(msg) {
    try { console.log(`[raw-worker:${threadId}] ${msg}`) } catch (e) {}
    try { parentPort.postMessage({ type: 'log', msg: `[raw-worker:${threadId}] ${msg}` }) } catch (e) {}
}

async function decodeViaLibraw(fp, cache, full) {
    const { LibRaw } = require('lightdrift-libraw')
    const lib = new LibRaw()
    const t0 = Date.now()
    try {
        workerLog(`libraw 开始加载文件: ${fp}${full ? '（全尺寸）' : ''}`)
        if (await lib.loadFile(fp) === false) {
            workerLog(`libraw 加载文件返回失败: ${fp}`)
            return false
        }
        // 显示缓存：优先 half_size 半尺寸解码（实测约为全尺寸 1/4），失败回退全尺寸；
        // 全尺寸任务（格式转换用）：直接全尺寸且不缩放，跳过半尺寸尝试
        let r = null
        if (full) {
            try {
                workerLog(`libraw 全尺寸解码（不缩放）: ${fp}`)
                await lib.setOutputParams({ half_size: false })
                r = await lib.createJPEGBuffer({ quality: RAW_CACHE_JPEG_Q })
                workerLog(`libraw 全尺寸解码完成 ${(Date.now() - t0)}ms, 产出=${(r && r.size) || 0} 字节`)
            } catch (e) { workerLog(`libraw 全尺寸解码异常: ${e && e.message}`); r = null }
        } else {
            try {
                workerLog(`libraw 尝试半尺寸解码: ${fp}`)
                await lib.setOutputParams({ half_size: true })
                r = await lib.createJPEGBuffer({ width: 3200, quality: RAW_CACHE_JPEG_Q })
                workerLog(`libraw 半尺寸解码完成 ${(Date.now() - t0)}ms, 产出=${(r && r.size) || 0} 字节`)
            } catch (e) { workerLog(`libraw 半尺寸解码异常: ${e && e.message}`); r = null }
            if (!r || !r.data || !r.size) {
                workerLog(`半尺寸未产出数据，回退全尺寸解码: ${fp}（已用 ${Date.now() - t0}ms）`)
                try {
                    await lib.setOutputParams({ half_size: false })
                    r = await lib.createJPEGBuffer({ width: 3200, quality: RAW_CACHE_JPEG_Q })
                    workerLog(`libraw 全尺寸解码完成 ${(Date.now() - t0)}ms, 产出=${(r && r.size) || 0} 字节`)
                } catch (e) { workerLog(`libraw 全尺寸解码异常: ${e && e.message}`); r = null }
            }
        }
        if (!r || !r.data || !r.size) {
            workerLog(`libraw 解码未产出数据: ${fp}`)
            return false
        }
        fs.mkdirSync(path.dirname(cache), { recursive: true })
        fs.writeFileSync(cache, r.data)
        workerLog(`缓存已写入: ${cache}（总耗时 ${Date.now() - t0}ms）`)
        return true
    } catch (e) {
        workerLog(`libraw 解码异常: ${e && e.message}`)
        return false
    } finally {
        try { await lib.close() } catch (e) {}
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
        if (fp && cache) ok = await decodeViaLibraw(fp, cache, full)
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