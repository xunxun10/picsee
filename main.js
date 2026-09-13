// 程序入口：窗口创建 + 系统/文件操作 IPC
const { app, BrowserWindow, Menu, ipcMain, dialog, clipboard, shell, nativeImage, screen, desktopCapturer, session } = require('electron')
const fs = require('fs')
const path = require('path')
const Exif = require('./util/exif')
const JpegEncode = require('./util/jpeg-encode')
const { createRawPool } = require('./util/raw-pool')
const { rotateBGRA } = require('./util/raw-rotate')

const is_mac = process.platform === 'darwin'
const is_windows = process.platform === 'win32'

let G_MAIN_WINDOW = null

// 支持的图片后缀（与原生 GetFiles 保持一致，含 raw）
const PIC_EXT = ['bmp', 'png', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'avif', 'svg', 'ico', 'tiff', 'tif', 'crw', 'cr2', 'nef', 'raf', 'arw', 'rw2', 'dng', 'orf']
const RAW_EXT = ['crw', 'cr2', 'nef', 'orf', 'raf', 'rw2', 'arw', 'dng']
// 由 PIC_EXT 同源构建的启动参数匹配正则，避免两份清单不同步（历史上加 webp 时曾漏改导致双击无法打开）
const PIC_EXT_RE = new RegExp('\\.(' + PIC_EXT.map((e) => e.replace(/[.+^${}()|[\]\\?*]/g, '\\$&')).join('|') + ')$', 'i')

function GetExt(fp) {
    const base = path.basename(fp)
    const i = base.lastIndexOf('.')
    return i === -1 ? '' : base.slice(i + 1)
}

function IsImageFile(fp) {
    return PIC_EXT.includes(GetExt(fp).toLowerCase())
}

function IsRawFile(fp) {
    return RAW_EXT.includes(GetExt(fp).toLowerCase())
}

// RAW 缓存路径：与原 CMyImage::GetRawCachePath 一致，缓存名保留原始文件名（含原后缀），
// 即 a/b/c.CR2 -> a/b/raw.cache/c.CR2.jpg，以便与原程序生成的缓存互相复用
function RawCachePath(fp) {
    const dir = path.join(path.dirname(fp), 'raw.cache')
    return path.join(dir, path.basename(fp) + '.jpg')
}

// RAW 全尺寸缓存路径（格式转换用）：a/b/c.CR2 -> a/b/raw.cache/c.CR2.full.jpg。
// 显示缓存是半尺寸解码产物（约为全尺寸 1/4），转换需另行全尺寸解码，避免分辨率损失。
function RawFullCachePath(fp) {
    const dir = path.join(path.dirname(fp), 'raw.cache')
    return path.join(dir, path.basename(fp) + '.full.jpg')
}

// 从 RAW 文件字节流中提取内嵌的整幅 JPEG 预览图（多数 RAW 都内嵌一张全尺寸 JPEG）。
// 用栈按嵌套深度配对 SOI/EOI：只有最外层 SOI..EOI 才算一个完整候选，
// 这样内嵌缩略图不会把整幅大图截断。RAW 像素数据可能误命中 0xFFD8，产生
// 夹带大量数据的伪候选（实测可达 32MB），故每个候选都需 nativeImage 验证可解码，
// 从大到小取第一个有效者。
function ExtractValidEmbeddedJpeg(buf) {
    const candidates = []
    const stack = []
    for (let i = 0; i + 1 < buf.length; i++) {
        if (buf[i] !== 0xFF) continue
        const b = buf[i + 1]
        if (b === 0xD8) {
            stack.push(i)
            i++
        } else if (b === 0xD9 && stack.length > 0) {
            const start = stack.pop()
            if (stack.length === 0) candidates.push({ start: start, size: i + 2 - start })
        }
    }
    candidates.sort((a, b) => b.size - a.size)
    for (const c of candidates) {
        if (c.size < 1024 || c.size > 20 * 1024 * 1024) continue
        try {
            const img = nativeImage.createFromBuffer(buf.slice(c.start, c.start + c.size))
            if (!img.isEmpty()) return img
        } catch (e) { /* 候选无效，继续下一个 */ }
    }
    return null
}

// ===== RAW 缓存后台解码 =====
// RAW 无法被浏览器解码，需由主进程解码为 raw.cache/<原名>.jpg（如 xx.CR2.jpg）供渲染端显示。
// 解码是 CPU 密集的原生调用，若在主进程执行会长期占用事件循环导致界面卡顿；
// 改为投递给 worker 线程池（util/raw-pool.js），主进程只做调度与罕见的内嵌预览兜底。
// 约束：写入缓存时像素必须已按 EXIF 朝向摆正（完整旋转方案见 util/raw-rotate.js 顶部说明），
// 因为渲染端对 RAW 不再旋转（exif-info 返回 baked=true）。
const rawPool = createRawPool({
    workerPath: path.join(__dirname, 'rawcache-worker.js'),
    poolSize: 2,
    timeoutMs: 60000,
    onReady: (cache) => {
        // 缓存已就绪，通知渲染端刷新（若该 RAW 正在显示）
        SendToWeb('send-to-web', { type: 'raw-cache-ready', data: cache })
    },
    onLog: (msg) => {
        // 后台解码等日志：打控制台，并走专用 app-log 频道供菜单弹窗查看（不进状态栏）
        try { console.log(msg) } catch (e) {}
        try { SendToWeb('app-log', String(msg)) } catch (e) {}
    },
})

// 按 RAW 的 EXIF 朝向旋转 nativeImage（Electron 未提供直接旋转接口，故走位图搬运）。
// 仅内嵌预览兜底路径需要调用；libraw 解码路径的朝向已由 libraw 自行烘进像素，不要在此再转。
function RotateNativeImage(img, orientation) {
    try {
        const size = img.getSize()
        const bmp = img.toBitmap()   // BGRA
        // 朝向 1 时 rotateBGRA 原样返回同一引用，据此跳过重建
        const r = rotateBGRA(bmp, size.width, size.height, orientation)
        if (r.data === bmp) return img
        return nativeImage.createFromBitmap(r.data, { width: r.width, height: r.height })
    } catch (e) {
        return img
    }
}

// 内嵌预览兜底：从 RAW 中取整幅内嵌 JPEG，按 RAW 的 EXIF 朝向摆正后写缓存。
// 这一步是旋转方案里的路径 B（详见 util/raw-rotate.js 顶部说明）：内嵌 JPEG 是传感器
// 原始朝向且无可用 EXIF 标记，必须靠这一步转正，否则缓存会表现为“没有自动旋转”。
// maxSide：最大边上限（0 = 不限制）；显示缓存用 3200，全尺寸缓存（格式转换）不限制。
function WriteEmbeddedFallback(fp, cache, maxSide) {
    const buf = fs.readFileSync(fp)
    const img = ExtractValidEmbeddedJpeg(buf)
    if (!img) return false
    const size = img.getSize()
    const maxSideSide = Math.max(size.width, size.height)
    let out = img
    if (maxSide > 0 && maxSideSide > maxSide) {
        const scale = maxSide / maxSideSide
        out = img.resize({ width: Math.round(size.width * scale), height: Math.round(size.height * scale) })
    }
    const orientation = Exif.RawExifOrientation(fp)
    if (orientation > 1) out = RotateNativeImage(out, orientation)
    fs.mkdirSync(path.dirname(cache), { recursive: true })
    fs.writeFileSync(cache, out.toJPEG(90))
    return true
}

// 保证 RAW 有可显示的缓存 JPG，返回可显示路径（失败时返回原路径）。
// 两条缓存生成路径（旋转方案见 util/raw-rotate.js 顶部说明）：
//   路径 A：LibRaw 后台线程解码（half_size 快，失败自动退全尺寸）——朝向由 libraw 自行摆正；
//   路径 B：内嵌预览兜底 —— 按 RAW 的 EXIF 朝向旋转后再写出。
// 无论走哪条，缓存像素都已是摆正的，故渲染端对 RAW 不再旋转。
// 本函数保证不向调用方抛异常：任一环节出错都退化为“返回原路径”，
// 以免单个文件的问题影响整批缓存生成（后续文件仍会继续尝试）。
async function EnsureRawCache(fp) {
    try {
        if (!IsRawFile(fp) || !IsExist(fp)) return fp
        const cache = RawCachePath(fp)
        if (IsExist(cache)) return cache
        // 路径 A：后台 worker 解码；失败/超时/异常都会以 false 返回，继续走兜底
        try {
            if (await rawPool.decode(fp, cache)) return cache
            console.log('[raw] 后台解码未成功，改走内嵌预览兜底: ' + fp)
        } catch (e) { /* 落到内嵌预览兜底 */ }
        // 路径 B：内嵌预览兜底（自带按 EXIF 朝向摆正）
        try {
            if (WriteEmbeddedFallback(fp, cache)) return cache
        } catch (e) { /* 兜底也失败则回退原路径 */ }
        try {
            // 关键失败信息保留状态栏展示（与原程序一致）；详细线程日志走 app-log 弹窗
            SendToWeb('trace', { level: 'error', msg: 'RAW 解码失败: ' + path.basename(fp) })
            SendToWeb('app-log', 'RAW 解码失败: ' + path.basename(fp))
        } catch (e) { /* 提示失败不影响返回 */ }
    } catch (e) {
        // 兜底捕获：任何意外都不外抛，避免中断整个文件夹的缓存生成
    }
    return fp
}

// 扫描某文件所在文件夹内的所有图片，返回排序后的数组和当前文件索引
async function ScanFolder(firstFile) {
    if (!firstFile) return { files: [], curIndex: -1 }
    const folder = path.dirname(firstFile)
    let names = []
    try {
        names = fs.readdirSync(folder)
    } catch (e) {
        return { files: [], curIndex: -1 }
    }
    const files = names.filter(IsImageFile).map(n => path.join(folder, n))
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    // RAW 无法被浏览器直接解码，需生成 raw.cache/<原名>.jpg（如 xx.CR2.jpg）供渲染进程显示。
    // 全部在后台线程解码：仅等待本次打开的图片就绪保证立即显示，其余入队，
    // 生成完成后主进程推送 raw-cache-ready，渲染端再刷新，故不阻塞出列表。
    // 健壮性：逐文件隔离异常，任一文件失败/超时都不影响后续文件继续生成缓存。
    try {
        const lowFirst = String(firstFile).toLowerCase()
        let rawCount = 0
        for (const f of files) { if (IsRawFile(f)) rawCount++ }
        if (rawCount > 0) console.log(`[raw] 文件夹内 RAW 共 ${rawCount} 个，开始后台缓存预热（线程池=2）`)
        for (const f of files) {
            try {
                if (!IsRawFile(f)) continue
                if (f.toLowerCase() === lowFirst) {
                    // 本次打开的图片优先等待缓存就绪，保证立即显示；异常不阻断出列表
                    await EnsureRawCache(f)
                } else {
                    // 后台排队生成，不阻塞出列表；失败也不影响其它文件
                    EnsureRawCache(f).catch(() => {})
                }
            } catch (e) {
                // 单个文件异常：跳过该文件，继续处理后续文件
            }
        }
    } catch (e) {
        // 缓存预热整体异常也不能阻断返回文件列表
    }
    let curIndex = -1
    const low = firstFile.toLowerCase()
    for (let i = 0; i < files.length; i++) {
        if (files[i].toLowerCase() === low) { curIndex = i; break }
    }
    return { files, curIndex }
}

// 删除文件（与原 DelFile(path, true) 行为一致）：
// 优先放入系统回收站；回收站不可用时（网络盘、Linux ARM 无回收站等）移动到同目录的 _del 目录，绝不直接抹掉
async function DeleteFile(fp) {
    if (!IsExist(fp)) return { ok: false, via: '', err: '文件不存在' }
    try {
        await shell.trashItem(fp)
        return { ok: true, via: 'trash' }
    } catch (e) {
        const dst = AddChildDirAndMake(fp, '_del')
        try {
            fs.renameSync(fp, dst)
            return { ok: true, via: 'del-dir', dst }
        } catch (e2) {
            return { ok: false, via: '', err: '回收站与 _del 目录均不可用' }
        }
    }
}

// 判断路径是否存在
function IsExist(p) { try { return fs.existsSync(p) } catch (e) { return false } }

// 生成添加子目录后的目标路径并创建子目录: src -> folder/child/fileName.ext
function AddChildDirAndMake(src, child) {
    const folder = path.dirname(src)
    const newDir = path.join(folder, child)
    const newPath = path.join(newDir, path.basename(src))
    try { fs.mkdirSync(newDir, { recursive: true }) } catch (e) {}
    return newPath
}

// 拷贝文件（返回新路径）
function CopyFileTo(src, dst) {
    try {
        fs.copyFileSync(src, dst)
        return true
    } catch (e) {
        return false
    }
}

// 将文件放入剪贴板（Windows 下用 Set-Clipboard -LiteralPath 写入 CF_HDROP，
// 可在资源管理器中直接粘贴；Electron 的 clipboard.writeBuffer 无法写入该格式）
function ClipboardPutFiles(files) {
    const list = (files || []).filter(IsExist)
    if (list.length === 0) return false
    if (!is_windows) {
        try { clipboard.writeText(list.join('\n')) ; return true } catch (e) { return false }
    }
    const { execFile } = require('child_process')
    // PowerShell 单引号字符串转义：内部单引号写成两个
    const psQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'"
    const cmd = 'Set-Clipboard -LiteralPath @(' + list.map(psQuote).join(',') + ')'
    try {
        execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', cmd], () => {})
        return true
    } catch (e) {
        return false
    }
}

// 截屏取屏：Electron 未内置 navigator.mediaDevices.getDisplayMedia 的默认实现，
// 必须注册该处理器，渲染端调用 getDisplayMedia 时才能拿到窗口所在显示器的画面。
// 这里只指定源、不生成缩略图（thumbnailSize 为 0），画面走桌面捕获原始帧，分辨率即屏幕原生分辨率。
function RegisterDisplayMedia() {
    session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
        try {
            const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
            if (!sources || sources.length === 0) { callback({}); return }
            let display = null
            if (G_MAIN_WINDOW && !G_MAIN_WINDOW.isDestroyed()) {
                const b = G_MAIN_WINDOW.getBounds()
                display = screen.getDisplayNearestPoint({
                    x: Math.round(b.x + b.width / 2),
                    y: Math.round(b.y + b.height / 2),
                })
            }
            // 优先取窗口所在显示器，display_id 对不上时退回第一个
            const src = (display && sources.find(s => String(s.display_id) === String(display.id))) || sources[0]
            callback({ video: src })
        } catch (e) {
            callback({})
        }
    })
}

// 打开目录并选中文件
async function OpenDirSelect(fp) {
    if (is_windows) {
        const { execFile } = require('child_process')
        execFile('explorer.exe', ['/select,', fp], () => {})
        return true
    }
    shell.showItemInFolder(fp)
    return true
}

// 通过 <image> 关联的程序打开文件
function OpenExternal(fp) {
    return shell.openPath(fp)
}

// 应用自身占用的额外尺寸：状态栏 26px + 相框模式图片四周各留 5px 边距
const UI_PAD_W = 10
const UI_PAD_H = 26 + 10

// 窗口最小尺寸（与 createWindow 的 minWidth/minHeight 共用同一组值，
// 贴合图片时按同一上限计算居中位置，避免被最小尺寸截断后位置偏掉）
const MIN_WIN_W = 600
const MIN_WIN_H = 400

// 轻量读取图片像素尺寸：只解析文件头，避免为大图做整幅解码。
// 覆盖 JPEG/PNG/GIF/BMP，其余格式回退到 Electron 解码。
function ReadImageSize(fp) {
    try {
        const fd = fs.openSync(fp, 'r')
        try {
            const head = Buffer.alloc(64)
            const n = fs.readSync(fd, head, 0, head.length, 0)
            if (n >= 8) {
                // PNG: IHDR 宽高为大端 32 位
                if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47 && n >= 24) {
                    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) }
                }
                // GIF: 逻辑屏幕宽高为小端 16 位
                if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && n >= 10) {
                    return { width: head.readUInt16LE(6), height: head.readUInt16LE(8) }
                }
                // BMP: 宽高为小端 32 位（高度可能为负，表示自上而下）
                if (head[0] === 0x42 && head[1] === 0x4D && n >= 26) {
                    return { width: Math.abs(head.readInt32LE(18)), height: Math.abs(head.readInt32LE(22)) }
                }
            }
        } finally {
            fs.closeSync(fd)
        }
        // JPEG: 逐段扫描定位 SOFn 帧头
        const buf = fs.readFileSync(fp)
        if (buf.length > 4 && buf[0] === 0xFF && buf[1] === 0xD8) {
            let off = 2
            while (off + 9 < buf.length) {
                if (buf[off] !== 0xFF) { off++; continue }
                const marker = buf[off + 1]
                // 无长度字段的标记直接跳过
                if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { off += 2; continue }
                if (marker === 0xDA) break // 进入压缩数据，后面不会再有帧头
                const len = buf.readUInt16BE(off + 2)
                if (len < 2) break
                const isSOF = (marker >= 0xC0 && marker <= 0xC3) ||
                              (marker >= 0xC5 && marker <= 0xC7) ||
                              (marker >= 0xC9 && marker <= 0xCB) ||
                              (marker >= 0xCD && marker <= 0xCF)
                if (isSOF) {
                    return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) }
                }
                off += 2 + len
            }
        }
    } catch (e) { /* 解析失败则回退 */ }
    try {
        const img = nativeImage.createFromPath(fp)
        if (img && !img.isEmpty()) return img.getSize()
    } catch (e) { /* 无法读取尺寸 */ }
    return null
}

// 按图片尺寸调整窗口大小并居中（对应原 setWindowSizeWithPic）
// 无参启动时按默认图 res/index.jpg 调整，避免用固定 1200x800 导致留白过大
async function FitWindowToImage(fp) {
    if (!G_MAIN_WINDOW) return false
    let showPath = fp
    if (!showPath || !IsExist(showPath)) {
        showPath = path.join(__dirname, 'res', 'index.jpg')
        if (!IsExist(showPath)) return false
    }
    if (IsRawFile(showPath)) showPath = await EnsureRawCache(showPath)
    const size = ReadImageSize(showPath)
    if (!size || !size.width || !size.height) return false
    const imgW = size.width
    const imgH = size.height

    // 实测窗口边框（含标题栏）占位，避免硬编码导致四周留白过大
    let frameW = 16
    let frameH = 39
    // 底部不可见的拖拽边框厚度（Windows DWM 外框上下不对称：顶部是可见标题栏，
    // 底部还有一条约 8px 看不见的边框，导致按矩形居中时视觉上窗口偏上）
    let frameBottom = 8
    try {
        const b = G_MAIN_WINDOW.getBounds()
        const c = G_MAIN_WINDOW.getContentBounds()
        frameW = Math.max(0, b.width - c.width)
        frameH = Math.max(0, b.height - c.height)
        frameBottom = Math.max(0, (b.y + b.height) - (c.y + c.height))
    } catch (e) { /* 取不到时用默认值 */ }

    // 贴合图片：只缩小不放大，窗口铺满任务栏以上区域（工作区），图片尽量大。
    // 注意：任务栏占了屏幕底部一条，窗口按工作区居中后，顶边距屏幕顶部只剩几像素，
    // 屏幕下方那 40px 是任务栏本身——这是"图片最大"换来代价，不再为视觉居中缩小窗口。
    let dsp = null
    try { dsp = screen.getDisplayMatching(G_MAIN_WINDOW.getBounds()) } catch (e) { dsp = null }
    if (!dsp) dsp = screen.getPrimaryDisplay()
    const wa = dsp.workArea
    const maxImgW = Math.max(120, wa.width - frameW - UI_PAD_W - 4)
    const maxImgH = Math.max(120, wa.height - frameH - UI_PAD_H - 4)
    // 只缩小不放大，保证整图可见且铺满可用区域
    const scale = Math.min(1, maxImgW / imgW, maxImgH / imgH)
    let dispW = Math.round(imgW * scale)
    let dispH = Math.round(imgH * scale)
    // 最小尺寸不超过图片本身，小图不额外留白（原实现为 480x300 下限）
    dispW = Math.max(Math.min(480, imgW), dispW)
    dispH = Math.max(Math.min(300, imgH), dispH)

    try {
        // 一次性 setBounds 同时定尺寸与位置：setContentSize 后立刻 center() 可能
        // 读到未同步的旧外框尺寸，按 1200x800 计算位置导致窗口偏高、底部留白偏大。
        // 统一按「内容 + 实测边框」算出目标外框（并受最小尺寸约束）。
        const winW = Math.max(MIN_WIN_W, dispW + UI_PAD_W + frameW)
        const winH = Math.max(MIN_WIN_H, dispH + UI_PAD_H + frameH)
        // 纵向用「可见高度」居中：底部那 8px 不可见边框不算视觉留白，
        // 否则可见底边会比顶边多出这一段，看起来就是"下面空得多"。
        const visH = Math.max(1, winH - frameBottom)
        const x = Math.round(wa.x + Math.max(0, (wa.width - winW) / 2))
        const y = Math.round(wa.y + Math.max(0, (wa.height - visH) / 2))
        G_MAIN_WINDOW.setBounds({ x, y, width: winW, height: winH })
    } catch (e) { /* 忽略窗口调整异常 */ }
    return true
}

// 构造窗口
function createWindow() {
    let startFile = null
    let unsupportedArg = null
    // 解析启动参数中的图片路径
    for (const arg of process.argv.slice(1)) {
        if (PIC_EXT_RE.test(arg)) {
            const p = path.resolve(arg)
            if (IsExist(p)) { startFile = p; break }
        } else {
            // 参数是存在的文件但不属受支持类型（如强行用 picsee 打开 txt）：稍后提醒
            try { if (!unsupportedArg && fs.statSync(arg).isFile()) unsupportedArg = arg } catch (e) { /* 非文件参数忽略 */ }
        }
    }

    G_MAIN_WINDOW = new BrowserWindow({
        width: 1200,
        height: 800,
        center: true, // 初始即居中，避免贴合图片尺寸前窗口停在系统默认位置
        minWidth: 600,
        minHeight: 400,
        autoHideMenuBar: false,
        icon: path.join(__dirname, 'res', 'icon.ico'),
        backgroundColor: '#e6e6e6',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            // 允许渲染进程加载本地图片文件，并严格限制为图片可被 <img>/canvas 读取
            webSecurity: true,
        }
    })

    G_MAIN_WINDOW.setMenuBarVisibility(false)
    G_MAIN_WINDOW.loadFile('index.html')

    G_MAIN_WINDOW.webContents.once('did-finish-load', async () => {
        // 无论是否带参数启动，都按图片尺寸贴合窗口（无参数时用默认索引图）。
        // 用 finally 兜底：即便贴合窗口/生成缓存期间出错，也必须把启动图交给渲染进程，
        // 否则直接打开 RAW 时会卡在默认页、渲染端收不到 startup-open-image 而无法加载图片。
        try {
            await FitWindowToImage(startFile)
        } finally {
            if (startFile) {
                G_MAIN_WINDOW.webContents.send('startup-open-image', startFile)
            } else if (unsupportedArg) {
                SendToWeb('send-to-web', { type: 'unsupported-file', data: path.basename(unsupportedArg) })
            }
        }
    })

    // 拦截渲染进程外部链接导航，统一用系统浏览器打开
    G_MAIN_WINDOW.webContents.on('will-navigate', (e, url) => {
        if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('mailto:')) {
            e.preventDefault()
            shell.openExternal(url)
        }
    })
    G_MAIN_WINDOW.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('mailto:')) {
            shell.openExternal(url)
        }
        return { action: 'deny' }
    })
}

// 渲染进程发来的请求转发给目标窗口（窗口销毁后忽略）
function SendToWeb(name, data) {
    if (G_MAIN_WINDOW && !G_MAIN_WINDOW.isDestroyed()) {
        G_MAIN_WINDOW.webContents.send(name, data)
    }
}

// ===== IPC 处理 =====
function registerIpc() {
    ipcMain.on('send-to-bgsys', (_evt, msg) => {
        HandleWebMsg(msg)
    })
    ipcMain.handle('invoke', async (_evt, msg) => {
        return await HandleInvoke(msg)
    })
}

async function HandleInvoke(msg) {
    try {
        switch (msg.type) {
            case 'scan-folder':
                return await ScanFolder(msg.path)
            case 'delete-file':
                // 删除到系统回收站，回收站不可用时移到同目录的 _del 目录
                return await DeleteFile(msg.path)
            case 'copy-file': {
                if (!IsExist(msg.path)) return { ok: false, err: '文件不存在' }
                const dst = AddChildDirAndMake(msg.path, '_copied')
                const ok = CopyFileTo(msg.path, dst)
                return { ok, dst, err: ok ? '' : '拷贝失败' }
            }
            case 'move-file': {
                if (!IsExist(msg.path)) return { ok: false, err: '文件不存在' }
                const dst = AddChildDirAndMake(msg.path, '_moved')
                try {
                    fs.renameSync(msg.path, dst)
                    return { ok: true, dst, err: '' }
                } catch (e) {
                    return { ok: false, err: '移动失败', dst }
                }
            }
            case 'clipboard-put-files':
                ClipboardPutFiles(msg.files || [])
                return { ok: true }
            case 'exist':
                return IsExist(msg.path)
            case 'dir-select':
                return await OpenDirSelect(msg.path)
            case 'open-dir':
                try { shell.openPath(msg.path); return true } catch (e) { return false }
            case 'open-external':
                return await OpenExternal(msg.path)
            case 'exif-info':
                return Exif.ReadExifInfo(msg.path)
            case 'jpeg-source': {
                // 供渲染进程的内置编码器复用原图参数：量化表(DQT)、霍夫曼表(DHT)、
                // 分量与采样因子、以及 APPn 段（EXIF/ICC 等原样搬过去）
                if (!IsExist(msg.path)) return { ok: false, err: '文件不存在' }
                let buf
                try { buf = fs.readFileSync(msg.path) } catch (e) { return { ok: false, err: e.message } }
                const src = JpegEncode.parseSource(buf)
                if (!src) return { ok: false, err: '不是支持的 JPEG 结构' }
                return { ok: true, src }
            }
            case 'save-format-bin': {
                // 直接写入二进制内容（旋转保存用，避免 base64 膨胀）
                if (!msg.path || !msg.bytes) return { ok: false, err: '参数不完整' }
                try {
                    fs.mkdirSync(path.dirname(msg.path), { recursive: true })
                    fs.writeFileSync(msg.path, Buffer.from(msg.bytes))
                    return { ok: true }
                } catch (e) { return { ok: false, err: e.message } }
            }
            case 'read-file-bytes': {
                try { return new Uint8Array(fs.readFileSync(msg.path)) } catch (e) { return null }
            }
            case 'display-path':
                // RAW 返回 raw.cache 下的缓存 JPG，其余原样返回
                return await EnsureRawCache(msg.path)
            case 'raw-full-path': {
                // 供格式转换获取 RAW 的全尺寸数据（显示缓存是半尺寸预览，直接转换会损失分辨率）：
                // 优先后台线程全尺寸解码（不缩放），失败用内嵌全尺寸预览兜底（不限制边长），
                // 全部失败返回 null，渲染端回退半尺寸显示缓存继续转换。
                const fp = msg.path
                try {
                    if (!IsRawFile(fp) || !IsExist(fp)) return null
                    const full = RawFullCachePath(fp)
                    if (IsExist(full)) return full
                    try {
                        if (await rawPool.decode(fp, full, { full: true })) return full
                        console.log('[raw] 全尺寸解码未成功，改走内嵌预览兜底: ' + fp)
                    } catch (e) { /* 落到内嵌预览兜底 */ }
                    try {
                        if (WriteEmbeddedFallback(fp, full, 0)) return full
                    } catch (e) { /* 兜底失败则回退半尺寸 */ }
                } catch (e) { /* 任何异常都回退半尺寸 */ }
                return null
            }
            case 'fit-window':
                return await FitWindowToImage(msg.path)
            case 'app-dir':
                return __dirname
            case 'file-size': {
                if (!IsExist(msg.path)) return 0
                try { return fs.statSync(msg.path).size } catch (e) { return 0 }
            }
            case 'app-info':
                return {
                    versions: process.versions,
                    isPackaged: app.isPackaged,
                    name: app.getName(),
                    appVersion: app.getVersion(),
                    author: 'xunxun10',
                    license: 'MIT',
                }
            case 'license-text':
                try { return fs.readFileSync(path.join(__dirname, 'LICENSE'), 'utf8') } catch (e) { return '' }
            default:
                return null
        }
    } catch (e) {
        return { ok: false, err: e.message }
    }
}

async function HandleWebMsg(msg) {
    if (!msg || !msg.type) return
    switch (msg.type) {
        case 'open-image-dialog': {
            const { canceled, filePaths } = await dialog.showOpenDialog(G_MAIN_WINDOW, {
                title: '打开图片',
                filters: [
                    { name: '图片', extensions: PIC_EXT },
                    { name: '所有文件', extensions: ['*'] },
                ],
                properties: ['openFile', 'multiSelections'],
            })
            if (!canceled && filePaths && filePaths.length > 0) {
                // 用户可在对话框切到“所有文件”选到不支持的类型：过滤后把不支持的逐一提醒
                const ok = filePaths.filter((f) => IsImageFile(f))
                const bad = filePaths.filter((f) => !IsImageFile(f))
                if (bad.length > 0) {
                    SendToWeb('send-to-web', { type: 'unsupported-file', data: bad.map((f) => path.basename(f)).join('、') })
                }
                if (ok.length > 0) {
                    FitWindowToImage(ok[0])
                    SendToWeb('open-image-files', ok)
                }
            }
            // 不论是否选择文件都通知渲染进程，用于解除“正在打开”状态，避免重复弹出对话框
            SendToWeb('send-to-web', { type: 'dialog-closed' })
            break
        }
        case 'save-format': {
            // msg: { path, dataUrl } 直接写入指定路径（格式转换/压缩/旋转保存使用，不弹对话框）
            if (!msg.path || !msg.dataUrl) {
                SendToWeb('trace', { level: 'error', msg: '保存失败：参数不完整' })
                break
            }
            try {
                fs.mkdirSync(path.dirname(msg.path), { recursive: true })
                const b64 = String(msg.dataUrl).split(',')[1]
                fs.writeFileSync(msg.path, Buffer.from(b64, 'base64'))
            } catch (e) {
                SendToWeb('trace', { level: 'error', msg: '保存失败: ' + e.message })
            }
            break
        }
        case 'save-image': {
            // msg: { defaultName, filterExt, dataUrl } canvas dataURL -> 文件
            const { canceled, filePath } = await dialog.showSaveDialog(G_MAIN_WINDOW, {
                title: '保存图片',
                defaultPath: msg.defaultPath || msg.defaultName || 'image.png',
                filters: [{ name: '图片', extensions: [msg.filterExt || 'png'] }],
            })
            if (canceled || !filePath || !msg.dataUrl) break
            try {
                const b64 = msg.dataUrl.split(',')[1]
                const buf = Buffer.from(b64, 'base64')
                fs.writeFileSync(filePath, buf)
                SendToWeb('image-saved', filePath)
            } catch (e) {
                SendToWeb('trace', { level: 'error', msg: '保存失败: ' + e.message })
            }
            break
        }
        case 'minimize-window':
            if (G_MAIN_WINDOW) G_MAIN_WINDOW.minimize()
            break
        case 'restore-window':
            if (G_MAIN_WINDOW) G_MAIN_WINDOW.restore()
            break
        case 'set-window-title':
            if (G_MAIN_WINDOW && msg.title) G_MAIN_WINDOW.setTitle(msg.title)
            break
        case 'fullscreen': {
            if (!G_MAIN_WINDOW) return
            if (msg.on) G_MAIN_WINDOW.setFullScreen(true)
            else G_MAIN_WINDOW.setFullScreen(false)
            SendToWeb('send-to-web', { type: 'fullscreen-state', data: G_MAIN_WINDOW.isFullScreen() })
            break
        }
        case 'fullscreen-check': {
            if (G_MAIN_WINDOW) {
                SendToWeb('send-to-web', { type: 'fullscreen-state', data: G_MAIN_WINDOW.isFullScreen() })
            }
            break
        }
        case 'devtools': {
            if (G_MAIN_WINDOW) G_MAIN_WINDOW.webContents.openDevTools({ mode: 'detach' })
            break
        }
        default:
            return
    }
}

app.whenReady().then(() => {
    registerIpc()
    RegisterDisplayMedia()
    createWindow()
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
        else G_MAIN_WINDOW && G_MAIN_WINDOW.show()
    })
})

app.on('window-all-closed', () => {
    if (!is_mac) app.quit()
})