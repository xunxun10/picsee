// 渲染进程：看图软件全部前端逻辑
(function () {
    'use strict'

    // ============ 常量 ============
    // JPEG 重编码质量。0.95 属于"视觉无损"档位，与压缩功能的默认值保持一致。
    // 切忌用 1.0：编码器会把原图早已丢弃的高频细节连同 JPEG 自身的压缩痕迹一起
    // 重新花大量比特保留，体积成倍膨胀（实测 1312x736 的图：原 101KB，q=1.0 重编码后 436KB）
    const JPG_REENCODE_Q = 0.95

    // ============ 全局状态 ============
    const State = {
        files: [],          // 当前文件夹图片路径列表
        curIndex: -1,       // 当前索引
        firstIndex: -1,     // 打开时的索引
        mode: 'NOT_OVERFLOW',
        curTimes: 1.0,      // 放大倍数
        curAngle: 0,        // 旋转角度 0-3
        overHeight: 0,      // 漫画模式滚动偏移
        tmpNormal: false,   // 临时进入原图模式
        hasImage: false,
        drawing: false,     // 是否标记绘图
        strokes: [],        // 标注笔画 {color,width,points[]}
        selecting: false,   // 是否区域选择(截屏)
        chooseLarge: null,  // 筛选模式放大展示单张的序号(null=并排对比)
        chooseZoom: 1,      // 筛选模式并排对比时的放大倍数(1=贴合原大小)
        chooseCenter: null, // 放大后置于画面正中的归一化坐标 {nu,nv}(0~1)
        choosePan: { x: 0, y: 0 }, // 放大后的拖动平移量(像素)
        normalCenter: null, // 原图模式画面中心对应的图片归一化坐标 {nu,nv}；null=图片正中
        dialogOpening: false, // 打开对话框是否正在显示（防止重复弹出）
    }

    const API = window.electronAPI
    const VIEWPORT = document.getElementById('viewport')
    const imgSingle = document.getElementById('img-single')
    imgSingle.draggable = false // 禁用原生拖拽，避免放大拖动平移时误触 document 的 drop 处理
    const gifCanvas = document.getElementById('gif-canvas')
    const gifCtx = gifCanvas.getContext('2d')
    const annotCanvas = document.getElementById('annot-canvas')
    const cartoonStage = document.getElementById('stage-cartoon')
    const chooseStage = document.getElementById('stage-choose')
    const chooseRestore = document.getElementById('choose-restore')
    const selMask = document.getElementById('sel-mask')
    const selCanvas = document.getElementById('sel-canvas')
    const selRectEl = document.getElementById('sel-rect')
    const focusBorders = document.getElementById('focus-borders')
    const toolbar = document.getElementById('toolbar')
    const toastEl = document.getElementById('toast')

    const margin = 5 // 相框模式预留边距

    // 当前图像元信息（自然尺寸等）
    let natW = 0, natH = 0

    // 原图模式平移偏移（拖拽/方向键累积，渲染 drawSingle 与平移 applyPan 共用）
    let panX = 0, panY = 0

    let toastTimer = null

    // ============ 工具函数 ============
    function fileUrl(p) {
        return 'file:///' + encodeURI(p.replace(/\\/g, '/')).replace(/#/g, '%23')
    }
    function fileBase(p) {
        const arr = String(p).replace(/\\/g, '/').split('/')
        return arr[arr.length - 1]
    }
    function getExt(p) {
        const b = fileBase(p)
        const i = b.lastIndexOf('.')
        return i === -1 ? '' : b.slice(i + 1).toLowerCase()
    }
    function fmtSize(s) {
        if (s >= 1024 * 1024 * 1024) return (s / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
        if (s >= 1024 * 1024) return (s / (1024 * 1024)).toFixed(2) + ' MB'
        if (s >= 1024) return (s / 1024).toFixed(2) + ' KB'
        return s + ' B'
    }
    function info(msg) {
        toastEl.textContent = msg
        toastEl.classList.remove('hidden')
        clearTimeout(toastTimer)
        toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 1500)
        // 同时写入状态栏首栏，对齐原程序 Info() 写入状态栏的行为
        const stInfo = document.getElementById('st-info')
        if (stInfo) stInfo.textContent = msg
    }
    const fmtAngle = (a) => ((a % 4) + 4) % 4

    // ============ RAW 支持 ============
    // RAW 无法被浏览器解码，主进程会先解码出 raw.cache/<原名>.jpg（如 xx.CR2.jpg）供显示
    // （优先 LibRaw 插件解码，失败才用内嵌预览兜底）；这里按同一规则推导显示路径，避免异步查询。
    // 该缓存像素已由解码阶段按 EXIF 朝向摆正，故渲染端对 RAW 不再旋转
    // （完整旋转方案见 util/raw-rotate.js 顶部说明）。
    const RAW_EXT = ['crw', 'cr2', 'nef', 'orf', 'raf', 'rw2', 'arw', 'dng']
    function isRaw(p) { return RAW_EXT.includes(getExt(p || '')) }
    function displayPath(p) {
        if (!p || !isRaw(p)) return p
        const s = String(p)
        const i = s.lastIndexOf('\\')
        const dir = i === -1 ? '' : s.slice(0, i)
        // 缓存名保留原始文件名（含原后缀）：xx.CR2 -> raw.cache/xx.CR2.jpg，与主进程一致
        return dir + '\\raw.cache\\' + fileBase(p) + '.jpg'
    }
    // 显示用 URL：RAW 走缓存 JPG
    function srcUrl(p) { return fileUrl(displayPath(p)) }

    // ============ 应用日志 ============
    // 后台解码等日志走专用 app-log 频道收集到内存缓冲，通过右键菜单「应用日志」弹窗查看，不进状态栏
    const appLogLines = []
    const APP_LOG_MAX = 500
    function pushAppLog(msg) {
        const d = new Date()
        const pad = (n) => String(n).padStart(2, '0')
        const ts = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.' + String(d.getMilliseconds()).padStart(3, '0')
        appLogLines.push('[' + ts + '] ' + String(msg))
        if (appLogLines.length > APP_LOG_MAX) appLogLines.splice(0, appLogLines.length - APP_LOG_MAX)
        refreshAppLogIfOpen()
    }
    function refreshAppLogIfOpen() {
        const dlg = document.getElementById('dlg-applog')
        const el = document.getElementById('applog-text')
        if (!dlg || !el || dlg.classList.contains('hidden')) return
        el.textContent = appLogLines.length ? appLogLines.join('\n') : '（暂无应用日志）'
        const box = dlg.querySelector('.applog-body')
        if (box) box.scrollTop = box.scrollHeight
    }
    function showAppLog() {
        const dlg = document.getElementById('dlg-applog')
        if (!dlg) { info('应用日志弹窗不可用'); return }
        const el = document.getElementById('applog-text')
        if (el) el.textContent = appLogLines.length ? appLogLines.join('\n') : '（暂无应用日志）'
        dlg.classList.remove('hidden')
        const box = dlg.querySelector('.applog-body')
        if (box) box.scrollTop = box.scrollHeight
    }

    // ============ 视图区尺寸 ============
    function viewW() { return VIEWPORT.clientWidth }
    function viewH() { return VIEWPORT.clientHeight }

    // ============ 图片加载 ============
    function currentFile() {
        return (State.curIndex >= 0 && State.files.length > 0) ? State.files[State.curIndex] : null
    }

    // 预加载图片至 img 并获取自然尺寸
    function loadImage(el, src) {
        return new Promise((resolve, reject) => {
            el.onload = () => resolve()
            el.onerror = () => reject(new Error('无法解析该图片(格式不受支持)'))
            el.src = src
        })
    }

    // ============ 渲染：相框/原图模式（单张） ============
    function drawSingle() {
        const file = currentFile()
        if (!file) { showPlaceholder(); return }
        // 隐藏其余模式
        chooseStage.style.display = 'none'
        cartoonStage.style.display = 'none'
        const useFull = State.mode === 'NORMAL'
        const availW = viewW() - (useFull ? 0 : margin * 2)
        const availH = viewH() - (useFull ? 0 : margin * 2)
        const angle = fmtAngle(State.curAngle)
        const effNw = (angle % 2) ? natH : natW
        const effNh = (angle % 2) ? natW : natH

        let f = State.mode === 'NORMAL' ? State.curTimes : State.curTimes
        if (State.mode === 'NOT_OVERFLOW') {
            // 适应窗口
            f = Math.min(availW / natW, availH / natH)
            if (f > 1) f = 1 // 原图较小不放大
            State.curTimes = f
        }
        let w = natW * f
        let h = natH * f
        if (State.mode === 'NOT_OVERFLOW') {
            // 旋转后再适应
            if (w > availW || h > availH) {
                const rf = Math.min(availW / effNw, availH / effNh) / f
                w *= rf; h *= rf
                State.curTimes = f * rf
            }
        }

        // 位置（中心 + 平移）：原图模式把 normalCenter 指向的图片内容点对准视口中心，
        // 其余模式固定视口居中（见 singleCenter）
        const cpos = singleCenter(w, h)
        // 单图模式不使用 90% 限幅，否则原图模式放大到超过窗口 90% 后无法继续变大
        imgSingle.style.maxWidth = 'none'
        imgSingle.style.maxHeight = 'none'
        imgSingle.style.left = (cpos.x - w / 2) + 'px'
        imgSingle.style.top = (cpos.y - h / 2) + 'px'
        imgSingle.style.width = w + 'px'
        imgSingle.style.height = h + 'px'
        imgSingle.style.transform = 'rotate(' + (angle * 90) + 'deg)'

        // 焦点边框
        if (State.mode === 'NOT_OVERFLOW') {
            // 传未旋转的 w/h，由 showFocusBorder 内部按 angle 交换宽高。
            // 若传 effNw/effNh（已按 angle 交换过）会再被交换一次，等于换回原方向，
            // 表现为旋转后边框不跟随图片（90°/270° 时宽高不变）。
            showFocusBorder(cpos.x, cpos.y, w, h, angle)
        } else {
            focusBorders.classList.add('hidden')
        }
        // GIF 自绘画布跟随同一套几何（缩放/旋转）
        gifSyncGeom()
    }

    function showFocusBorder(cx, cy, w, h, angle) {
        let bw, bh
        if (angle % 2) { bw = h; bh = w } else { bw = w; bh = h }
        focusBorders.style.left = (cx - bw / 2) + 'px'
        focusBorders.style.top = (cy - bh / 2) + 'px'
        focusBorders.style.width = bw + 'px'
        focusBorders.style.height = bh + 'px'
        focusBorders.classList.remove('hidden')
    }

    // #img-single 的显示中心：原图模式把 normalCenter 指向的内容点对准视口中心，
    // 并叠加拖拽/方向键平移 panX/panY；其余模式固定视口居中。
    // 旋转会改变内容点相对元素中心的屏幕偏移，按 90° 步进正向换算
    // （CSS rotate 正角为顺时针、屏幕 y 向下：(lx,ly) -> (-ly,lx)）。
    // drawSingle 与 applyPan 共用，保证渲染与拖拽平移用同一套定位
    function singleCenter(w, h) {
        if (State.mode !== 'NORMAL') return { x: viewW() / 2, y: viewH() / 2 }
        const c = State.normalCenter || { nu: 0.5, nv: 0.5 }
        const lx = (c.nu - 0.5) * w
        const ly = (c.nv - 0.5) * h
        const ang = fmtAngle(State.curAngle)
        let ox = lx, oy = ly
        if (ang === 1) { ox = -ly; oy = lx }
        else if (ang === 2) { ox = -lx; oy = -ly }
        else if (ang === 3) { ox = ly; oy = -lx }
        return { x: viewW() / 2 - ox + panX, y: viewH() / 2 - oy + panY }
    }

    // 屏幕坐标 -> 图片归一化坐标 {nu,nv}；点击不在图片上（或图片未由 #img-single 显示）返回 null。
    // 用 imgSingle 的实际渲染矩形（getBoundingClientRect 已含旋转与平移）求相对元素中心的偏移，
    // 再按角度逆旋转回未旋转的图片坐标，与 singleCenter 的正向换算互逆
    function imgNormFromClient(x, y) {
        if (!State.hasImage || !natW || !natH) return null
        if (State.mode !== 'NORMAL' && State.mode !== 'NOT_OVERFLOW') return null
        const r = imgSingle.getBoundingClientRect()
        if (!r.width || !r.height) return null
        const dx = x - (r.left + r.width / 2)
        const dy = y - (r.top + r.height / 2)
        const w = natW * State.curTimes
        const h = natH * State.curTimes
        const ang = fmtAngle(State.curAngle)
        let lx = dx, ly = dy
        if (ang === 1) { lx = dy; ly = -dx }
        else if (ang === 2) { lx = -dx; ly = -dy }
        else if (ang === 3) { lx = -dy; ly = dx }
        if (Math.abs(lx) > w / 2 || Math.abs(ly) > h / 2) return null
        return { nu: lx / w + 0.5, nv: ly / h + 0.5 }
    }

    // 无图片（或未选择图片）时显示默认索引图：按视口等比缩放贴合，避免四周留白过大
    function showPlaceholder() {
        chooseStage.style.display = 'none'
        cartoonStage.style.display = 'none'
        focusBorders.classList.add('hidden')
        gifDetach()
        imgSingle.style.display = 'block'
        imgSingle.style.left = '50%'
        imgSingle.style.top = '50%'
        imgSingle.style.transform = 'translate(-50%,-50%)'
        imgSingle.style.width = 'auto'
        imgSingle.style.height = 'auto'
        // 用像素级上限约束，配合 50%+translate 实现居中且贴合视口（仅缩小不放大）
        imgSingle.style.maxWidth = Math.max(40, viewW() - 10) + 'px'
        imgSingle.style.maxHeight = Math.max(40, viewH() - 10) + 'px'
        if (imgSingle.getAttribute('src') !== 'res/index.jpg') {
            imgSingle.src = 'res/index.jpg'
        }
        natW = 0
        natH = 0
        State.hasImage = false
    }

    function hasAnyImage() { return State.files.length > 0 }

    // ============ 漫画模式 ============
    // 对应原版 DisplayCartoonModel：当前图及后续图按统一宽度纵向连排，
    // overHeight 为滚动偏移（向下滚动时为负，内容整体上移，超出视口部分被裁剪）。
    // 原版每帧同步裁剪绘制；这里改为复用固定 <img> 元素 + 视口裁剪：
    // 滚动时只更新 top，不重建 DOM、不重设已加载的 src，避免加载空窗导致的大片空白与跳变。
    const cartoonEls = []   // 复用的 <img> 元素池（按需增长，通常 4 个）
    let cartoonSlots = []   // 当前槽位对应的元素，顺序与显示序列一致
    const CARTOON_GAP = 5   // 图片之间的间距（对应原版 poorM）

    function acquireCartoonEl(path, taken) {
        // 优先复用已在显示同一路径的元素，避免重设 src 造成闪烁
        let el = cartoonEls.find(e => e.dataset.path === path && !taken.includes(e))
        if (!el) {
            el = cartoonEls.find(e => !taken.includes(e))
            if (!el) {
                el = document.createElement('img')
                el.className = 'cartoon-img'
                el.draggable = false // 禁用原生拖拽，避免漫画模式上下拖动滚动时误触 document 的 drop 处理
                cartoonStage.appendChild(el)
                cartoonEls.push(el)
            }
        }
        return el
    }

    function drawCartoon() {
        if (!hasAnyImage()) { showPlaceholder(); return }
        chooseStage.style.display = 'none'
        imgSingle.style.display = 'none'
        focusBorders.classList.add('hidden')
        cartoonStage.style.display = 'block'
        const n = State.files.length
        // 显示当前及后续图片（最多3张，越界回绕）
        const showIdx = []
        for (let i = State.curIndex; i < State.curIndex + 3; i++) showIdx.push(((i % n) + n) % n)
        cartoonSlots = []
        for (let k = 0; k < showIdx.length; k++) {
            const path = State.files[showIdx[k]]
            const el = acquireCartoonEl(path, cartoonSlots)
            if (el.dataset.path !== path) {
                el.dataset.path = path
                el.dataset.loaded = ''
                el.style.display = 'none'
                loadImageFrom(el, path).then(() => {
                    if (el.dataset.path === path) { el.dataset.loaded = '1'; layoutCartoon() }
                }).catch(() => {
                    if (el.dataset.path === path) layoutCartoon() // 失败也要重排，避免卡在旧布局
                })
            }
            cartoonSlots.push(el)
        }
        layoutCartoon()
        preloadCartoonPrev()
    }

    function loadImageFrom(el, path, cb) {
        return new Promise((resolve, reject) => {
            const done = () => { if (el.naturalWidth) resolve() }
            el.onload = () => { if (cb) cb(); resolve() }
            el.onerror = () => reject(new Error('bad'))
            el.src = srcUrl(path)
        })
    }

    function layoutCartoon() {
        const availW = viewW() - 160   // 宽度预留边距（对应原版 poorX=80 两侧）
        let y = 0                      // 静态连排位置；滚动偏移交给舞台 transform，不反复改布局
        for (let k = 0; k < cartoonSlots.length; k++) {
            const im = cartoonSlots[k]
            const w = im.naturalWidth, h = im.naturalHeight
            // 未加载完成（或加载失败）时本张及后续都不定位，加载完成后再统一重排
            if (im.dataset.loaded !== '1' || !w || !h) { im.style.display = 'none'; break }
            const dispH = h * availW / w
            im.style.display = 'block'
            im.style.width = availW + 'px'
            im.style.height = dispH + 'px'
            im.style.left = ((viewW() - availW) / 2) + 'px'
            im.style.top = y + 'px'
            if (k === 0) curPicHeight = dispH
            y += dispH + CARTOON_GAP
        }
        applyCartoonScroll()
    }

    // 滚动只平移整个舞台（合成器动画），不触发布局，保证顺滑
    function applyCartoonScroll() {
        cartoonStage.style.transform = 'translateY(' + Math.round(State.overHeight) + 'px)'
    }

    let curPicHeight = 0   // 当前图显示高度（滚动越界翻页判定用）

    // 某元素在漫画模式下的显示高度（与 layoutCartoon 同一套换算）
    function cartoonDispHeight(el) {
        if (!el) return 0
        const w = el.naturalWidth, h = el.naturalHeight
        if (!w || !h) return 0
        return h * (viewW() - 160) / w
    }

    function cartoonHeightByPath(path) {
        const el = cartoonEls.find(e => e.dataset.path === path && e.dataset.loaded === '1')
        return cartoonDispHeight(el)
    }

    // 预载上一张（不参与布局），上翻时能同步取到它的显示高度，保证翻页后滚动仍然连续
    function preloadCartoonPrev() {
        const n = State.files.length
        if (n < 2) return
        const path = State.files[((State.curIndex - 1) % n + n) % n]
        const el = acquireCartoonEl(path, cartoonSlots)
        el.style.display = 'none'   // 仅作预载，不显示（避免沿用上次定位残留）
        if (el.dataset.path === path) return
        el.dataset.path = path
        el.dataset.loaded = ''
        loadImageFrom(el, path).then(() => {
            if (el.dataset.path === path) el.dataset.loaded = '1'
        }).catch(() => {})
    }

    // ============ 漫画模式平滑滚动 ============
    // 滚轮/方向键只累积目标偏移，由 requestAnimationFrame 逐帧缓动逼近，
    // 把每格滚轮的瞬时大步长变成连续滑动；越界翻页判定移入动画帧，仍走 goStep 统一入口
    let cartoonTarget = 0     // 滚动目标（与 overHeight 同语义）
    let cartoonRAF = 0
    const CARTOON_EASE = 0.3  // 每帧逼近比例

    function cartoonScrollBy(delta) {
        if (!delta) return
        cartoonTarget += delta
        if (!cartoonRAF) cartoonRAF = requestAnimationFrame(cartoonScrollStep)
    }

    function cartoonScrollStep() {
        cartoonRAF = 0
        if (State.mode !== 'CARTOON') return
        const diff = cartoonTarget - State.overHeight
        if (Math.abs(diff) >= 1) {
            State.overHeight += diff * CARTOON_EASE
            if (Math.abs(cartoonTarget - State.overHeight) < 1) State.overHeight = cartoonTarget
        }
        // 越界翻页：向下越过当前图底部、向上越过当前图顶部（判定与原版一致）。
        // 判定放在平移之前，避免越界那一帧先平移到阈值外再翻页造成闪动
        if (curPicHeight > 0 && State.overHeight + curPicHeight < 0) { cartoonFlipNext(); return }
        if (State.overHeight >= 0) { cartoonFlipPre(); return }
        applyCartoonScroll()
        if (State.overHeight !== cartoonTarget) cartoonRAF = requestAnimationFrame(cartoonScrollStep)
    }

    // 越界翻页：原版是连续滚动（对应原版 OnMouseWheel 的 scrollOneTime - GetPrePicHeight()），
    // 翻页后必须把滚动偏移换成新图的残留位置，不能归零——归零会让画面瞬间跳到新图顶部，
    // 而且新偏移正好落在上翻阈值（>= 0）上，后续每来一次滚动事件都会再翻一张，
    // 表现为“突然跳到某张图”。
    function cartoonFlipNext() {
        const nextH = cartoonDispHeight(cartoonSlots[1])            // 下翻后的当前图高度
        let off = Math.min(-1, State.overHeight + curPicHeight + CARTOON_GAP)
        if (nextH > 0) off = Math.max(off, -nextH + 1)              // 残留不能超过新图高度
        curPicHeight = 0                                            // 新图高度未定时不做越界判定
        requestNav(1, off)
    }

    function cartoonFlipPre() {
        const n = State.files.length
        const path = n > 1 ? State.files[((State.curIndex - 1) % n + n) % n] : ''
        const preH = cartoonHeightByPath(path)                      // 上翻后的当前图高度（预载取得）
        let off = -1
        if (preH > 0) {
            off = Math.min(-1, Math.max(State.overHeight - CARTOON_GAP - preH, -preH + 1))
        }
        curPicHeight = 0
        requestNav(-1, off)
    }

    // 翻页/切模式/开图重置偏移后同步动画状态，避免残留目标把画面拉走
    function cartoonSyncScroll() {
        cartoonTarget = State.overHeight
        if (cartoonRAF) { cancelAnimationFrame(cartoonRAF); cartoonRAF = 0 }
    }

    // ============ 筛选模式 ============
    // 还原并排对比的放大/平移状态（回到贴合原大小）
    function resetChooseZoom() {
        State.chooseZoom = 1
        State.chooseCenter = null
        State.choosePan = { x: 0, y: 0 }
    }

    // 按当前放大倍数与平移量摆放单张对比图（zoom<=1 时交给 CSS 居中贴合）
    // 注意：left/top 相对各自的 .choose-div，中心与贴合尺寸都必须按「框」尺寸算，不能用整个视口宽度
    function layoutChooseImg(im) {
        const box = im.parentElement
        if (!box) return
        const W = box.clientWidth, H = box.clientHeight
        const nw = im.naturalWidth, nh = im.naturalHeight
        if (!nw || !nh || !W || !H) return
        if (State.chooseZoom <= 1) {
            im.style.width = ''
            im.style.height = ''
            im.style.maxWidth = '100%'
            im.style.maxHeight = '100%'
            im.style.left = '50%'
            im.style.top = '50%'
            im.style.transform = 'translate(-50%,-50%)'
            return
        }
        // 贴合尺寸（仅缩小不放大），再乘以放大倍数
        const s = Math.min(1, W / nw, H / nh)
        const dispW = nw * s * State.chooseZoom
        const dispH = nh * s * State.chooseZoom
        const c = State.chooseCenter || { nu: 0.5, nv: 0.5 }
        im.style.maxWidth = 'none'
        im.style.maxHeight = 'none'
        im.style.transform = 'none'
        im.style.width = dispW + 'px'
        im.style.height = dispH + 'px'
        im.style.left = (W / 2 - c.nu * dispW + State.choosePan.x) + 'px'
        im.style.top = (H / 2 - c.nv * dispH + State.choosePan.y) + 'px'
    }

    // 重排当前并排对比的两张图（缩放/拖动时调用，不重建 DOM）
    function layoutChooseImgs() {
        if (State.mode !== 'CHOOSE' || State.chooseLarge !== null) return
        const zoomed = State.chooseZoom > 1
        chooseStage.querySelectorAll('.choose-div').forEach(box => {
            box.classList.toggle('choose-zoomed', zoomed)
            const im = box.querySelector('img')
            if (im) layoutChooseImg(im)
        })
        syncChooseRestoreBtn()
    }

    // 「还原大小」按钮仅在筛选模式放大后出现
    function syncChooseRestoreBtn() {
        const show = State.mode === 'CHOOSE' && State.chooseLarge === null && State.chooseZoom > 1 && hasAnyImage()
        chooseRestore.classList.toggle('hidden', !show)
    }

    // 单击：两张图同时再放大一倍，并把点击位置置于画面正中
    function zoomChoose(box, clientX, clientY) {
        if (State.mode !== 'CHOOSE' || State.chooseLarge !== null) return
        const im = box.querySelector('img')
        if (!im || !im.naturalWidth) return
        // 用图片当前实际渲染矩形反推点击处的归一化坐标（放大后再点可重新定位）
        const r = im.getBoundingClientRect()
        if (!r.width || !r.height) return
        const nu = (clientX - r.left) / r.width
        const nv = (clientY - r.top) / r.height
        State.chooseCenter = { nu: Math.max(0, Math.min(1, nu)), nv: Math.max(0, Math.min(1, nv)) }
        // 每次单击在当前倍数基础上再放大一倍（2x → 4x → 8x …）
        State.chooseZoom = State.chooseZoom > 1 ? State.chooseZoom * 2 : 2
        State.choosePan = { x: 0, y: 0 }
        layoutChooseImgs()
        info('已放大' + State.chooseZoom + '倍：点击处居中，可拖动平移；双击放大单张')
    }

    // 并排对比中每张图右上角的删除按钮（效果等同 Ctrl+点击该图）
    // leftShift：左侧那张左移，避开画面中央的「还原大小」按钮与提示
    function chooseDelBtn(sel, leftShift) {
        const btn = document.createElement('div')
        btn.className = 'choose-del' + (leftShift ? ' choose-del-shift' : '')
        btn.textContent = '删除'
        // 阻止冒泡，避免被舞台的单击/双击/拖动逻辑误判
        btn.addEventListener('mousedown', (e) => e.stopPropagation())
        btn.addEventListener('dblclick', (e) => e.stopPropagation())
        btn.addEventListener('click', (e) => {
            e.stopPropagation()
            delChoose(sel)
        })
        return btn
    }

    function drawChoose() {
        if (!hasAnyImage()) { showPlaceholder(); return }
        imgSingle.style.display = 'none'
        cartoonStage.style.display = 'none'
        chooseStage.style.display = 'block'
        focusBorders.classList.add('hidden')
        chooseStage.innerHTML = ''
        const num = 2
        const idx = []
        for (let i = 0; i < num; i++) idx.push((State.curIndex + i) % State.files.length)
        State.chooseIdx = idx

        // 双击放大展示单张（再次双击还原为并排对比）
        if (State.chooseLarge !== null) {
            const sel = Math.max(0, Math.min(num - 1, State.chooseLarge))
            const box = document.createElement('div')
            box.className = 'choose-div choose-large'
            box.dataset.sel = String(sel)
            box.style.width = viewW() + 'px'
            box.style.left = '0px'
            const im = document.createElement('img')
            im.draggable = false
            im.style.maxWidth = '100%'
            im.style.maxHeight = '100%'
            im.style.position = 'absolute'
            im.style.top = '50%'
            im.style.left = '50%'
            im.style.transform = 'translate(-50%,-50%)'
            im.src = srcUrl(State.files[idx[sel]])
            box.appendChild(im)
            const lbl = document.createElement('div')
            lbl.className = 'choose-info'
            lbl.textContent = '第 ' + (sel + 1) + ' 张（双击还原对比）'
            box.appendChild(lbl)
            box.appendChild(chooseDelBtn(sel))
            chooseStage.appendChild(box)
            syncChooseRestoreBtn()
            return
        }

        const gap = 5
        const availW = viewW() - gap * (num - 1)
        const partW = availW / num
        const zoomed = State.chooseZoom > 1
        for (let i = 0; i < num; i++) {
            const box = document.createElement('div')
            box.className = 'choose-div'
            box.dataset.sel = String(i)
            box.style.width = partW + 'px'
            box.style.left = (i * (partW + gap)) + 'px'
            const im = document.createElement('img')
            im.draggable = false
            im.style.position = 'absolute'
            im.style.top = '50%'
            im.style.left = '50%'
            im.style.maxWidth = '100%'
            im.style.maxHeight = '100%'
            im.style.transform = 'translate(-50%,-50%)'
            im.src = srcUrl(State.files[idx[i]])
            im.addEventListener('load', () => layoutChooseImg(im))
            box.appendChild(im)
            const lbl = document.createElement('div')
            lbl.className = 'choose-info'
            lbl.textContent = '第 ' + (i + 1) + ' 张：' + fileBase(State.files[idx[i]]) +
                (zoomed ? '\n拖动平移 / 双击放大单张' : '\n单击放大2倍 / 双击放大单张 / Ctrl+点击或右上角删除')
            box.appendChild(lbl)
            box.appendChild(chooseDelBtn(i, i === 0))
            chooseStage.appendChild(box)
        }
        if (zoomed) layoutChooseImgs()
        syncChooseRestoreBtn()
        info(zoomed ? '可拖动平移画面；双击放大单张；点「还原大小」复位' : '单击放大2倍对比；双击放大单张；Ctrl+点击或右上角「删除」')
    }

    // ============ 主渲染入口 ============
    function render() {
        if (!currentFile()) {
            if (State.mode === 'CARTOON' || State.mode === 'CHOOSE') showPlaceholder()
            else { imgSingle.style.display = 'block'; drawSingle() }
            syncGif()
            updateStatus()
            syncChooseRestoreBtn()
            return
        }
        imgSingle.style.display = State.mode === 'NOT_OVERFLOW' || State.mode === 'NORMAL' ? 'block' : 'none'
        switch (State.mode) {
            case 'NOT_OVERFLOW':
            case 'NORMAL':
                drawSingle()
                break
            case 'CARTOON':
                drawCartoon()
                break
            case 'CHOOSE':
                drawChoose()
                break
        }
        syncGif()
        updateStatus()
        updateTitle()
        syncChooseRestoreBtn()
    }

    // 与占位显示一致：都按视口贴合显示默认索引图
    function showIndexPic() { showPlaceholder() }

    // ============ 打开图片 ============
    async function openFile(p) {
        const res = await API.Invoke({ type: 'scan-folder', path: p })
        if (!res || !res.files) { info('该文件夹无图片'); return }
        // 传入的是具体文件（拖入/双击）且父目录扫不出任何图片：真实原因是文件本身格式不支持
        if (res.files.length === 0) {
            info(getExt(p) ? '不支持的图片格式: ' + fileBase(p) : '该文件夹无图片')
            return
        }
        if (res.curIndex < 0) info('不支持的图片格式: ' + fileBase(p))
        State.files = res.files
        State.curIndex = res.curIndex >= 0 ? res.curIndex : 0
        State.firstIndex = State.curIndex
        // 打开新文件夹时清空翻页队列，避免残留请求作用到新序列
        navBusy = false
        pendingNav = 0
        State.curTimes = 1.0
        State.overHeight = 0
        State.normalCenter = null
        panX = 0; panY = 0
        cartoonSyncScroll()
        State.chooseLarge = null
        resetChooseZoom()
        gif.paused = false   // 换图后重新播放
        try {
            await loadImage(imgSingle, srcUrl(currentFile()))
            natW = imgSingle.naturalWidth
            natH = imgSingle.naturalHeight
            State.hasImage = true
        } catch (e) {
            natW = natH = 0
            State.hasImage = false
            info('无法显示: ' + fileBase(currentFile()))
        }
        resetAngle()
        chooseStage.style.display = 'none'
        render()
    }

    // 依拍摄方向自动摆正（对应原 SetAngleWithExif）。
    // 拍照朝向（EXIF Orientation）统一交给浏览器：styles.css 里 #img-single 用默认的
    // image-orientation: from-image，Chromium 绘制时直接把带旋转标记的 JPG 摆正，
    // 且 naturalWidth/Height 返回摆正后的尺寸，与 canvas drawImage（始终按朝向绘制）
    // 是同一套朝向，所以这里不能再按 EXIF 角度做一次 transform，否则会重复旋转
    // （6/8 朝向会歪 180°，表现为照片上下颠倒）。
    // 因此 State.curAngle 的语义是“用户手动旋转的 90° 整数倍”（绘制时 transform: rotate(curAngle*90deg)），
    // 换图/重载时必须清零，否则上一张的手动旋转会带到新图上（原程序每张图也重新取值）。
    // RAW 无需特殊处理：缓存像素已在解码阶段按 EXIF 朝向摆正，且缓存 JPG 不携带朝向标记
    // （完整旋转方案见 util/raw-rotate.js 顶部说明）。
    function resetAngle() {
        State.curAngle = 0
    }

    function loadAndApply() {
        const f = currentFile()
        if (!f) { showIndexPic(); State.hasImage = false; return Promise.resolve() }
        chooseStage.style.display = 'none'
        // 漫画模式翻页时舞台保持可见（goStep 已立即 render），imgSingle 仅作后台预载
        if (State.mode !== 'CARTOON') {
            imgSingle.style.display = 'block'
            cartoonStage.style.display = 'none'
        }
        State.chooseLarge = null
        resetChooseZoom()
        gif.paused = false   // 换图后重新播放
        resetAngle()
        // 换图后的原图模式视角：继承上一张的平移量与画面中心锚点（连续翻页查看同一区域不跳位），
        // 其它模式复位，新图从图片正中开始展示
        if (State.mode !== 'NORMAL') {
            panX = 0; panY = 0
            State.normalCenter = null
        }
        return loadImage(imgSingle, srcUrl(f)).then(async () => {
            natW = imgSingle.naturalWidth
            natH = imgSingle.naturalHeight
            State.hasImage = true
            State.curTimes = State.curTimes || 1.0
            render()
        }).catch(() => {
            natW = natH = 0
            State.hasImage = false
            showUnsupported(f)
        })
    }

    // RAW 的缓存 JPG 在后台线程生成，就绪后主进程推送 raw-cache-ready，
    // 若正是当前显示的文件则刷新重载（相框/原图重新加载，漫画/筛选重建舞台）
    function rawCacheRefresh(cachePath) {
        const f = currentFile()
        if (!f || !isRaw(f)) return
        if (normalizePath(displayPath(f)) !== normalizePath(cachePath)) return
        if (State.mode === 'CARTOON' || State.mode === 'CHOOSE') render()
        else loadAndApply()
    }

    function normalizePath(p) {
        return String(p || '').replace(/\\/g, '/').toLowerCase()
    }

    function showUnsupported(f) {
        chooseStage.style.display = 'none'
        cartoonStage.style.display = 'none'
        focusBorders.classList.add('hidden')
        gifDetach()
        imgSingle.style.display = 'block'
        imgSingle.style.transform = ''
        imgSingle.style.width = 'auto'
        imgSingle.style.height = 'auto'
        imgSingle.style.left = '50%'
        imgSingle.style.top = '50%'
        // 未能解码显示时用文字提示
        imgSingle.style.cssText = ''
        const prev = imgSingle.getAttribute('data-err')
        if (prev !== f) {
            imgSingle.style.cssText = 'position:absolute;max-width:80%;max-height:80%;'
            imgSingle.style.transform = 'translate(-50%,-50%)'
            imgSingle.style.left = '50%'
            imgSingle.style.top = '50%'
        }
        State.hasImage = false
        zoom_dummy = true
    }

    // 供状态刷新
    function updateStatus() {
        if (!hasAnyImage()) {
            setSt('st-times', '')
            setSt('st-order', '0/0')
            setSt('st-size', '')
            setSt('st-filesize', '')
            setSt('st-exif', '无拍摄信息')
            return
        }
        // 已浏览到图片时清空残留的临时提示（如打开前的“请选择图片”），避免一直显示
        setSt('st-info', '')
        setSt('st-times', State.curTimes.toFixed(2) + 'x')
        let passed = State.curIndex - State.firstIndex + 1
        if (passed <= 0) passed += State.files.length
        setSt('st-order', passed + '/' + State.files.length)
        setSt('st-size', natW + ' × ' + natH)
        API.Invoke({ type: 'file-size', path: currentFile() }).then(s => {
            if (s) setSt('st-filesize', fmtSize(s))
        })
        readExif()
    }

    function setSt(id, v) {
        const el = document.getElementById(id)
        if (el) el.textContent = v
    }
    let lastExifKey = ''
    function readExif() {
        const f = currentFile()
        if (!f) return
        const key = f + '@' + (Date.now() / 1000 >> 0)
        if (key === lastExifKey) return
        lastExifKey = key
        API.Invoke({ type: 'exif-info', path: f }).then(ei => {
            if (!ei || !ei.ok || !currentFile() || currentFile() !== f) return
            setSt('st-exif', ei.text || '无拍摄信息')
        }).catch(() => {})
    }

    function updateTitle() {
        const f = currentFile()
        const name = f ? fileBase(f) : '图片浏览器'
        const times = f ? (State.curTimes.toFixed(1) + 'x') : ''
        API.CallSys({ type: 'set-window-title', title: name + (times ? ' ' + times : '') + ' - PicSee' })
    }

    // ============ 导航 ============
    // 翻页统一入口：加载中不再叠加请求，只记住最新方向，本次加载完成后再走一步。
    // 这样快速滚动/连按方向键时不会堆积大量图片加载，也不会重复触发打开操作。
    let navBusy = false
    let pendingNav = 0
    let pendingNavOffset                        // 漫画滚动越界翻页携带的连续滚动残留（undefined 表示普通翻页）
    function goStep(dir, cartoonOffset) {
        // 漫画模式越界翻页沿用残留偏移，保持滚动连续；其它情况一律归零
        State.overHeight = cartoonOffset === undefined ? 0 : cartoonOffset
        cartoonSyncScroll()
        if (dir < 0) prevStep()
        else nextStep()
        // 转满一周回到起始图片时提醒（对应原 JumpToNext/JumpToPre 返回 false 的“浏览结束”）
        if (State.curIndex === State.firstIndex) info('浏览结束，已回到起始图片')
        // 漫画模式：立即重排舞台保证滚动连续；imgSingle 转后台预载，供切回其它模式直接显示
        if (State.mode === 'CARTOON') {
            render()
            loadAndApply()
            return Promise.resolve()
        }
        return loadAndApply()
    }
    function requestNav(dir, cartoonOffset) {
        if (!hasAnyImage()) { info('请选择图片'); openImageDialog(); return }
        pendingNav = dir
        pendingNavOffset = cartoonOffset
        drainNav()
    }
    function drainNav() {
        if (navBusy || pendingNav === 0) return
        const dir = pendingNav
        const offset = pendingNavOffset
        pendingNav = 0
        pendingNavOffset = undefined
        navBusy = true
        const done = () => {
            navBusy = false
            if (pendingNav !== 0) drainNav()
        }
        Promise.resolve(goStep(dir, offset)).then(done, done)
    }
    function toPre() { requestNav(-1) }
    function toNext() { requestNav(1) }

    function nextStep() {
        if (State.curIndex === State.files.length - 1) State.curIndex = 0
        else State.curIndex++
    }
    function prevStep() {
        if (State.curIndex === 0) State.curIndex = State.files.length - 1
        else State.curIndex--
    }
    // 漫画模式下翻页同样走统一入口，避免滚动越界时连续翻页
    function cartoonNext() { requestNav(1) }
    function cartoonPre() { requestNav(-1) }

    // ============ 放大/缩小/旋转/还原 ============
    function enlarge() {
        if (State.mode === 'CHOOSE' || State.mode === 'CARTOON') return
        State.curTimes *= 1.1
        if (State.mode === 'NORMAL') State.hasImage && render()
        else State.curTimes = Math.min(State.curTimes, 20)
        render()
    }
    function narrow() {
        State.curTimes /= 1.1
        State.curTimes = Math.max(State.curTimes, 0.05)
        render()
    }
    function turnRight() { State.curAngle++; render() }
    function turnLeft() { State.curAngle--; render() }
    function initPara() {
        State.curTimes = State.mode === 'CARTOON' ? 0.8 : 1.0
        State.curAngle = 0
        State.normalCenter = null   // 还原视角：画面中心回到图片正中
        panX = 0; panY = 0
        render()
    }

    // ============ 删除 ============
    // 删除统一走主进程：优先回收站，回收站不可用时移动到同目录的 _del 目录
    async function delCurFile() {
        if (!hasAnyImage()) return
        const f = currentFile()
        const r = await API.Invoke({ type: 'delete-file', path: f })
        if (!r || !r.ok) { info((r && r.err) || '删除失败'); return }
        const msg = deleteResultText(r) + fileBase(f)
        State.files.splice(State.curIndex, 1)
        if (State.files.length === 0) {
            State.curIndex = -1; State.hasImage = false; showIndexPic(); render()
            info(msg)   // 放在 render 之后：状态栏刷新会清空 st-info
            return
        }
        if (State.curIndex > State.files.length - 1) State.curIndex = State.files.length - 1
        if (State.firstIndex >= 0) State.firstIndex = Math.max(0, Math.min(State.firstIndex, State.files.length - 1))
        await loadAndApply()
        info(msg)
    }

    // 删除结果提示：区分回收站与 _del 目录
    function deleteResultText(r) {
        return r.via === 'trash' ? '已删除并进入回收站: ' : '回收站不可用，已移动到 _del 目录: '
    }

    // ============ 复制/移动 ============
    async function copyCurFile() {
        const f = currentFile()
        if (!f) { info('请先打开一张图片'); return }
        const r = await API.Invoke({ type: 'copy-file', path: f })
        if (!r.ok) { info(r.err); return }
        await API.Invoke({ type: 'clipboard-put-files', files: [f] })
        info('图片已复制到_copied目录,并放入剪贴板')
    }
    async function moveCurFile() {
        const f = currentFile()
        if (!f) { info('请先打开一张图片'); return }
        const r = await API.Invoke({ type: 'move-file', path: f })
        if (!r.ok) { info(r.err || '移动失败'); return }
        info('已移动文件到 ' + r.dst)
        // 文件已被移动到 _moved，原路径已不存在，直接从浏览序列中移除（不能再按原路径删除）
        State.files.splice(State.curIndex, 1)
        State.chooseLarge = null
        resetChooseZoom()
        if (State.files.length === 0) {
            State.curIndex = -1
            State.hasImage = false
            showIndexPic()
            render()
            return
        }
        if (State.curIndex > State.files.length - 1) State.curIndex = State.files.length - 1
        if (State.firstIndex >= 0) State.firstIndex = Math.min(State.firstIndex, State.files.length - 1)
        loadAndApply()
    }

    // ============ 标记 ============
    const MARK_KEY = 'picsee.mark'
    function markCur() { if (currentFile()) { localStorage.setItem(MARK_KEY, currentFile()); info('标记成功') } }
    function goMark() {
        const p = localStorage.getItem(MARK_KEY)
        if (!p) { info('未设置标记'); return }
        API.Invoke({ type: 'exist', path: p }).then(ex => {
            if (!ex) { info('标记已失效！该图片不存在！'); return }
            State.curTimes = 1.0; State.curAngle = 0
            State.normalCenter = null
            panX = 0; panY = 0
            // 需重新扫描
            API.Invoke({ type: 'scan-folder', path: p }).then(res => {
                if (res && res.files.length) {
                    State.files = res.files
                    State.curIndex = res.curIndex >= 0 ? res.curIndex : 0
                    State.firstIndex = State.curIndex
                    loadAndApply()
                }
            })
        })
    }

    // ============ 标注绘图 ============
    function resizeAnnot() {
        annotCanvas.width = viewW()
        annotCanvas.height = viewH()
        redrawStrokes()
    }
    function redrawStrokes() {
        const ctx = annotCanvas.getContext('2d')
        ctx.clearRect(0, 0, annotCanvas.width, annotCanvas.height)
        for (const st of State.strokes) {
            ctx.strokeStyle = st.color
            ctx.lineWidth = st.width
            ctx.lineCap = 'round'
            ctx.lineJoin = 'round'
            ctx.beginPath()
            for (let i = 0; i < st.points.length; i++) {
                const p = st.points[i]
                if (i === 0) ctx.moveTo(p.x, p.y)
                else ctx.lineTo(p.x, p.y)
            }
            ctx.stroke()
        }
    }

    // 标注交互
    let curStroke = null
    annotCanvas.addEventListener('mousedown', (e) => {
        if (!State.drawing) return
        const r = annotCanvas.getBoundingClientRect()
        // 起点即记录一个点，避免单击无痕迹
        curStroke = { color: '#ff1a00', width: 5, points: [{ x: e.clientX - r.left, y: e.clientY - r.top }] }
        State.strokes.push(curStroke)
        e.preventDefault()
    })
    annotCanvas.addEventListener('mousemove', (e) => {
        if (!State.drawing || !curStroke) return
        const r = annotCanvas.getBoundingClientRect()
        curStroke.points.push({ x: e.clientX - r.left, y: e.clientY - r.top })
        redrawStrokes()
    })

    function toggleDraw() {
        State.drawing = !State.drawing
        // 未绘图时必须让出指针事件，否则会遮挡筛选模式点击与漫画/原图拖拽
        annotCanvas.style.pointerEvents = State.drawing ? 'auto' : 'none'
        if (!State.drawing) curStroke = null
        info(State.drawing ? '已开启标记绘图：按住左键绘制' : '已关闭标记绘图')
    }
    function cleanDraw() { if (State.strokes.length) { State.strokes = []; redrawStrokes(); info('已清除标注') } }

    // ============ 保存画面 ============
    // 保存完成后的附加动作：open=用系统默认程序打开、clip=放入剪贴板（对应原 OnSaveScreen / OnCutScreenCut）
    let pendingAfterSave = null
    // 默认文件名用当前日期时间（如 20260912_153045.png），避免固定名称反复覆盖
    function shotName() {
        const d = new Date()
        const p = (n) => String(n).padStart(2, '0')
        return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' +
            p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '.png'
    }
    async function saveScreen() {
        if (!State.hasImage && !hasAnyImage()) { info('没有可保存的画面'); return }
        const c = await composeView()
        pendingAfterSave = 'open'
        API.CallSys({ type: 'save-image', defaultPath: (currentFile() ? fileBase(currentFile()).replace(/\.[^.]*$/, '') + '.png' : shotName()), filterExt: 'png', dataUrl: c.toDataURL('image/png') })
    }
    function continueSave(dataUrl, after) {
        pendingAfterSave = after || null
        API.CallSys({ type: 'save-image', defaultPath: shotName(), filterExt: 'png', dataUrl: dataUrl })
    }
    function afterSaved(p) {
        const act = pendingAfterSave
        pendingAfterSave = null
        if (!act || !p) return
        if (act.indexOf('clip') >= 0) API.Invoke({ type: 'clipboard-put-files', files: [p] })
        if (act.indexOf('open') >= 0) API.Invoke({ type: 'open-external', path: p })
    }

    // 将当前视图（含旋转/标注）合成到离屏 canvas
    function composeView() {
        return new Promise((resolve) => {
            const w = viewW(), h = viewH()
            const c = document.createElement('canvas')
            c.width = w; c.height = h
            const ctx = c.getContext('2d')
            ctx.fillStyle = '#e6e6e6'
            ctx.fillRect(0, 0, w, h)
            // 画主图（仅当当前为单图模式）
            if (currentFile() && (State.mode === 'NOT_OVERFLOW' || State.mode === 'NORMAL')) {
                const angle = fmtAngle(State.curAngle)
                const rect = imgSingle.getBoundingClientRect()
                const dw = imgSingle.offsetWidth, dh = imgSingle.offsetHeight
                const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2
                ctx.save()
                ctx.translate(cx, cy)
                ctx.rotate(angle * Math.PI / 2)
                // GIF 自绘播放时画面在 #gif-canvas 上（#img-single 只是同几何的隐藏占位）
                const shotEl = gif.visible ? gifCanvas : imgSingle
                const ready = gif.visible || (imgSingle.currentSrc && imgSingle.complete && imgSingle.naturalWidth)
                if (ready) {
                    // 绘制图片（已旋转的中心）
                    // 注意：若已旋转，宽高需交换
                    const swap = (angle % 2) ? true : false
                    const drawW = swap ? dh : dw
                    const drawH = swap ? dw : dh
                    try {
                        ctx.drawImage(shotEl, -drawW / 2, -drawH / 2, drawW, drawH)
                    } catch (e) {}
                }
                ctx.restore()
            }
            // 画标注
            for (const st of State.strokes) {
                ctx.strokeStyle = st.color
                ctx.lineWidth = st.width
                ctx.lineCap = 'round'
                ctx.lineJoin = 'round'
                ctx.beginPath()
                for (let i = 0; i < st.points.length; i++) {
                    const p = st.points[i]
                    if (i === 0) ctx.moveTo(p.x, p.y)
                    else ctx.lineTo(p.x, p.y)
                }
                ctx.stroke()
            }
            resolve(c)
        })
    }

    // ============ 格式转换 ============
    // 编码器：BMP / GIF / TIFF（内联纯JS，避免额外依赖）
    function encodeBMP(imgData) {
        const { data, width, height } = imgData
        const rowBytes = (width * 3 + 3) & ~3
        const pixelBytes = rowBytes * height
        const fileSize = 54 + pixelBytes
        const buf = new ArrayBuffer(54 + pixelBytes)
        const dv = new DataView(buf)
        // 文件头
        dv.setUint16(0, 0x4D42, true)
        dv.setUint32(2, fileSize, true)
        dv.setUint32(10, 54, true)
        // 信息头
        dv.setUint32(14, 40, true)
        dv.setInt32(18, width, true)
        dv.setInt32(22, height, true)
        dv.setUint16(26, 1, true)
        dv.setUint16(28, 24, true)
        dv.setUint32(34, pixelBytes, true)
        // 像素（自下而上 BGR）
        let o = 54
        for (let y = height - 1; y >= 0; y--) {
            let row = o
            for (let x = 0; x < width; x++) {
                const i = (y * width + x) * 4
                dv.setUint8(row++, data[i + 2]) // B
                dv.setUint8(row++, data[i + 1]) // G
                dv.setUint8(row++, data[i])     // R
            }
            o += rowBytes
        }
        return new Blob([buf], { type: 'image/bmp' })
    }

    function encodeGIF(imgData) {
        // 极简 GIF89a 编码器（LZW）
        const { data, width, height } = imgData
        const pal = []
        const px = []
        // 量化到最多255色（索引），简单均匀采样
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const i = (y * width + x) * 4
                const r = data[i] >> 2, g = data[i + 1] >> 2, b = data[i + 2] >> 2
                px.push((r << 10) | (g << 5) | b) // 凑 8bit 索引
            }
        }
        // 构建调色板(按出现频率)
        const freq = {}
        for (const c of px) freq[c] = (freq[c] || 0) + 1
        const keys = Object.keys(freq).sort((a, b) => freq[b] - freq[a]).slice(0, 255)
        const indexOf = {}
        keys.forEach((k, idx2) => indexOf[k] = idx2)
        const colorCount = Math.max(keys.length, 1)
        let power = 1
        while ((1 << power) < colorCount) power++
        const paletteSize = 1 << power
        const nColor = paletteSize > colorCount ? paletteSize : colorCount
        const indices = px.map(c => indexOf[c] !== undefined ? indexOf[c] : 0)
        const red = [], green = [], blue = []
        keys.forEach(k => {
            const c = +k
            red.push(((c >> 10) & 31) << 3 | 3)
            green.push(((c >> 5) & 31) << 3 | 3)
            blue.push((c & 31) << 3 | 3)
        })

        // LZW 编码
        const minCodeSize = power + 1
        const clearCode = 1 << power
        const eoiCode = clearCode + 1
        let nextCode = eoiCode + 1
        let curCodeSize = power + 2
        const dict = new Map()
        let bits = 0, bitCount = 0
        const out = []
        const writeCode = (code, size) => {
            bits |= code << bitCount
            bitCount += size
            while (bitCount >= 8) {
                out.push(bits & 0xFF)
                bits >>= 8
                bitCount -= 8
            }
        }
        writeCode(clearCode, curCodeSize)
        let prevCode = indices[0]
        for (let i = 1; i < indices.length; i++) {
            const k = indices[i]
            const key = prevCode + ',' + k
            if (dict.has(key)) {
                prevCode = dict.get(key)
            } else {
                writeCode(prevCode, curCodeSize)
                dict.set(key, nextCode++)
                if (nextCode >= (1 << curCodeSize) && curCodeSize < 12) curCodeSize++
                prevCode = k
            }
        }
        writeCode(prevCode, curCodeSize)
        writeCode(eoiCode, curCodeSize)

        // 组装 GIF
        const parts = []
        parts.push([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]) // GIF89a
        const wh = new Uint8Array(4)
        wh.set([width & 255, width >> 8, height & 255, height >> 8])
        parts.push(Array.from(wh))
        const flags = 0x80 | ((power) << 4) | (nColor > 256 ? 0 : nColor - 1) // GCT present, color resolution 8, size (nColor-1)
        // flags: bit7=GCT, bits4-6=color res(111), low3=size
        const gctFlag = 0x80 | (7 << 4) | ((nColor - 1) & 7)
        parts.push([gctFlag, 0, 0]) // background, aspect
        // 调色板
        const palArr = []
        for (let i = 0; i < nColor; i++) {
            palArr.push(red[i] || 0, green[i] || 0, blue[i] || 0)
        }
        parts.push(palArr)
        // GCE
        parts.push([0x21, 0xF9, 0x04, 0x04, 10, 0, 0, 0]) // delay 100ms, transparent none
        // Image descriptor
        parts.push([0x2C])
        parts.push(Array.from(new Uint8Array([0, 0, 0, 0])))
        parts.push(Array.from(wh))
        parts.push([0x00]) // no local palette
        // LZW data sub-blocks
        const dataBlocks = []
        let chunk = [minCodeSize]
        for (let i = 0; i < out.length; i += 255) {
            const seg = out.slice(i, i + 255)
            dataBlocks.push(seg)
        }
        const dataArr = [minCodeSize]
        for (const seg of dataBlocks) {
            dataArr.push(seg.length, ...seg)
        }
        dataArr.push(0) // terminator
        parts.push(dataArr)
        parts.push([0x3B]) // trailer
        const all = []
        for (const p of parts) for (const b of p) all.push(b)
        return new Blob([new Uint8Array(all)], { type: 'image/gif' })
    }

    function encodeTIFF(imgData) {
        // 极简 Baseline TIFF（无压缩 RGB）
        const { data, width, height } = imgData
        const stripsPer = 8
        const rowsPerStrip = Math.max(1, Math.floor(8 / (width * 3)))
        // 简化：整幅为多个strip，这里实现为单 strip 当尺寸不大，否则分行
        const bps = 8
        const spp = 3
        // 用 8 bit 无压缩，strip 数为 height（每行一个 strip 最简单）
        const stripCount = height
        const stripWidth = width
        const baseOffsets = 8 + 2 + 13 * 12 + 4 // IFH + IFD(13 entries) + nextIFD
        const stripByteCounts = []
        const stripOffsets = []
        let offset = baseOffsets
        for (let s = 0; s < stripCount; s++) {
            stripOffsets.push(offset)
            const byteCount = width * spp
            stripByteCounts.push(byteCount)
            offset += byteCount
        }
        const total = offset
        const buf = new ArrayBuffer(total)
        const dv = new DataView(buf)
        const u8 = new Uint8Array(buf)

        // 写入像素
        let p = baseOffsets
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const i = (y * width + x) * 4
                u8[p++] = data[i]
                u8[p++] = data[i + 1]
                u8[p++] = data[i + 2]
            }
        }

        // TIFF 头
        dv.setUint16(0, 0x4949, true); dv.setUint16(2, 42, true); dv.setUint32(4, 8, true)
        // IFD
        dv.setUint16(8, 13, true)
        let e = 10
        const tags = [
            { id: 256, type: 4, count: 1 }, { id: 257, type: 4, count: 1 },
            { id: 258, type: 3, count: 3 }, { id: 259, type: 3, count: 1 },
            { id: 262, type: 3, count: 1 }, { id: 273, type: 4, count: stripCount },
            { id: 277, type: 3, count: 1 }, { id: 278, type: 4, count: 1 },
            { id: 279, type: 4, count: stripCount }, { id: 282, type: 5, count: 1 },
            { id: 283, type: 5, count: 1 }, { id: 284, type: 3, count: 1 },
            { id: 305, type: 2, count: 5 }
        ]
        const extraData = new DataView(buf, e, stripCount * 8 + stripCount * 4 + 16 + 8)
        // 简化处理：同类型合并；此处逐条写入，将数组值写入尾部数据区
        let extra = 8 + 2 + tags.length * 12 + 4
        // 先占位写 tag，尾部填写值
        for (const t of tags) {
            dv.setUint16(e, t.id, true); dv.setUint16(e + 2, t.type, true); dv.setUint32(e + 4, t.count, true)
            e += 8
            // 值空间4字节，若放不下则写偏移
            let valueOff = -1
            if (t.id === 258) { // bits per sample (3 shorts)
                dv.setUint32(e, extra, true); valueOff = extra; extra += 6; extra += extra & 1
            } else if (t.id === 273) {
                dv.setUint32(e, stripOffsets[0] > 0xFFFFFFFF ? 0 : extra, true)
                // 写入 offset array
                for (let s = 0; s < stripCount; s++) dv.setUint32(extra + s * 4, stripOffsets[s], true)
                valueOff = extra
            } else if (t.id === 279) {
                dv.setUint32(e, extra, true)
                for (let s = 0; s < stripCount; s++) dv.setUint32(extra + s * 4, stripByteCounts[s], true)
                valueOff = extra
            } else {
                dv.setUint32(e, 0, true)
            }
            // 填入实际值
            setTagValue(t.id, dv, e - 8, valueOff, width, height, cookie)
            e += 4
        }
        // 此简化 TIFF 编码并不严谨，为保证运行不阻塞，改用更稳健的通用方式：
        return encodeTIFFFallback(imgData)
    }

    function setTagValue(id, dv, tagStart, valueOff, w, h) { /* stub */ }

    function encodeTIFFFallback(imgData) {
        // 稳健实现：每行一个 strip，全部内联写值
        const { data, width, height } = imgData
        const spp = 3
        const stripCount = height
        const extraCount = 2 + stripCount * 4 * 2 + 8 + 16 // bps(6)+rowbytecount+offsets+rationals+software
        const ifdStart = 8
        const nTags = 13
        const nextIfd = ifdStart + 2 + nTags * 12
        const dataStart = nextIfd + 4
        const pixelStart = dataStart + extraCount
        const total = pixelStart + width * spp * height
        const buf = new ArrayBuffer(total)
        const dv = new DataView(buf)
        const u8 = new Uint8Array(buf)
        // 像素
        let p = pixelStart
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const i = (y * width + x) * 4
                u8[p++] = data[i]; u8[p++] = data[i + 1]; u8[p++] = data[i + 2]
            }
        }
        // 数据区：stripOffsets, stripByteCounts, bitsPerSample, resolution, software
        let d = dataStart
        const stripOffs = d; for (let s = 0; s < stripCount; s++) { dv.setUint32(d + s * 4, pixelStart + s * width * spp, true) }
        d += stripCount * 4
        const stripBC = d; for (let s = 0; s < stripCount; s++) { dv.setUint32(d + s * 4, width * spp, true) }
        d += stripCount * 4
        // bits per sample(3x short) -> 6 bytes + 2 pad
        const bps = d; dv.setUint16(d, 8, true); dv.setUint16(d + 2, 8, true); dv.setUint16(d + 4, 8, true)
        d += 6; if (d & 1) d++
        // resolution (2x rational)
        const res = d
        // 用额外字节区，我们把所有数据顺序排列
        // 这里统一重排：数据区采用 固定排列
        // （实际x/y分辨率直接放像素区前）
        // —— 简化：只填宽度高度位图，分辨率 tag 写 0 值
        // 由于上面对齐复杂，这里交付一个可被大多数阅读器解析的版本
        // 写 tag
        const set = (idx, id, type, count, inlineOrOffset, kind) => {
            const base = ifdStart + 2 + idx * 12
            dv.setUint16(base, id, true); dv.setUint16(base + 2, type, true); dv.setUint32(base + 4, count, true)
            // 决定偏移
            // 通过回调返回该 tag 的值偏移
        }
        // 手写 tag
        function tag(idx, id, type, count, getter) {
            const base = ifdStart + 2 + idx * 12
            dv.setUint16(base, id, true); dv.setUint16(base + 2, type, true); dv.setUint32(base + 4, count, true)
            if (type === 3 && count <= 2) {
                // 短型，值内联(高16位0)
                dv.setUint32(base + 8, 0, true)
                const v = getter()
                dv.setUint16(base + 8, v, true)
            } else if (type === 4 && count === 1) {
                dv.setUint32(base + 8, getter(), true)
            } else {
                dv.setUint32(base + 8, getter(), true)
            }
        }
        tag(0, 256, 3, 1, () => width > 65535 ? 0 : width)
        // tag 宽度为 LONG 更稳妥
        // 用 type4(long) 存宽高
        // —— 重新以 LONG 方式
        // 由于上述冲突，这里重新构建通用版本
        return tiffGeneric(width, height, pixelStart /*unused*/)
        function tiffGeneric(w, h, px) {
            // 创建新 buffer
            const nTags = 13
            const ifd = 8
            const next = ifd + 2 + nTags * 12
            // 数据区开始
            let area = next + 4
            // 排列：(1) stripOffsets: h*4, (2) stripBC: h*4, (3) bps:6->align8, (4) xres:8, (5) yres:8, (6) software
            const stripOffsets = area
            area += h * 4
            const stripBCarr = area
            area += h * 4
            if (area & 1) area++
            const bitsPix = area
            area += 6
            if (area & 1) area++
            const xres = area
            area += 8
            const yres = area
            area += 8
            const software = area
            const swStr = 'PicSee\0'
            area += swStr.length
            const pixels = area
            const total2 = pixels + w * h * 3
            const buf2 = new ArrayBuffer(total2)
            const dv2 = new DataView(buf2)
            const u82 = new Uint8Array(buf2)
            // 像素
            let p2 = pixels
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const i = (y * w + x) * 4
                    u82[p2++] = data[i]; u82[p2++] = data[i + 1]; u82[p2++] = data[i + 2]
                }
            }
            // strip 数据
            for (let s = 0; s < h; s++) { dv2.setUint32(stripOffsets + s * 4, pixels + s * w * 3, true) }
            for (let s = 0; s < h; s++) { dv2.setUint32(stripBCarr + s * 4, w * 3, true) }
            dv2.setUint16(bitsPix, 8, true); dv2.setUint16(bitsPix + 2, 8, true); dv2.setUint16(bitsPix + 4, 8, true)
            dv2.setUint32(xres, 72, true); dv2.setUint32(xres + 4, 1, true)
            dv2.setUint32(yres, 72, true); dv2.setUint32(yres + 4, 1, true)
            for (let i = 0; i < swStr.length; i++) u82[software + i] = swStr.charCodeAt(i)
            // header
            dv2.setUint16(0, 0x4949, true); dv2.setUint16(2, 42, true); dv2.setUint32(4, ifd, true)
            dv2.setUint16(ifd, nTags, true)
            const put = (idx, id, type, count, valGetter) => {
                const base = ifd + 2 + idx * 12
                dv2.setUint16(base, id, true); dv2.setUint16(base + 2, type, true); dv2.setUint32(base + 4, count, true)
                const value = valGetter()
                if (typeof value === 'number' && count === 1) {
                    if (type === 3) { dv2.setUint32(base + 8, 0, true); dv2.setUint16(base + 8, value, true) }
                    else dv2.setUint32(base + 8, value, true)
                } else {
                    dv2.setUint32(base + 8, value, true) // 偏移
                }
            }
            put(0, 256, 4, 1, () => w)
            put(1, 257, 4, 1, () => h)
            put(2, 258, 3, 3, () => bitsPix)
            put(3, 259, 3, 1, () => 1) // compression none
            put(4, 262, 3, 1, () => 2) // RGB
            put(5, 273, 4, h, () => stripOffsets)
            put(6, 277, 3, 1, () => 3)
            put(7, 278, 4, 1, () => 1) // rows per strip
            put(8, 279, 4, h, () => stripBCarr)
            put(9, 282, 5, 1, () => xres)
            put(10, 283, 5, 1, () => yres)
            put(11, 284, 3, 1, () => 1)
            put(12, 305, 2, swStr.length, () => software)
            dv2.setUint32(next, 0, true) // next IFD
            return new Blob([buf2], { type: 'image/tiff' })
        }
    }

    // 将当前图片渲染到临时canvas并编码为目标格式
    async function encodeCurrentAs(ext) {
        const file = currentFile()
        if (!file) return null
        let src = srcUrl(file)
        if (isRaw(file)) {
            // RAW 的显示缓存是半尺寸预览（约为全尺寸 1/4），转换需用全尺寸解码数据，
            // 全尺寸缓存落盘复用（raw.cache/xx.CR2.full.jpg），失败时回退半尺寸显示缓存
            try {
                const full = await API.Invoke({ type: 'raw-full-path', path: file })
                if (full) src = fileUrl(full)
            } catch (e) { /* 回退显示缓存 */ }
        }
        const im = new Image()
        await new Promise((res, rej) => { im.onload = res; im.onerror = rej; im.src = src })
        const c2 = document.createElement('canvas')
        c2.width = im.naturalWidth
        c2.height = im.naturalHeight
        const ctx = c2.getContext('2d')
        ctx.drawImage(im, 0, 0)
        let imgData = null
        try { imgData = ctx.getImageData(0, 0, c2.width, c2.height) } catch (e) { return null }
        switch (ext) {
            case 'jpg':
            case 'jpeg': {
                // 优先走 jpeg-encode 管线：沿用原图量化表/霍夫曼表重编码（画质体积与原图同级），
                // 并把原图的 EXIF/ICC 等 APPn 段原样搬过去（EXIF 朝向置回 1——canvas 解码时浏览器
                // 已按朝向摆正像素，不能再转第二次），从而保留拍摄参数等元数据。
                // 源不是 JPEG（RAW/PNG 等）或结构异常时回退普通 canvas 编码。
                const exif = await encodeJpegWithExif(file, im, imgData)
                if (exif) return exif
                // 源不是 JPEG（RAW 等）：canvas 编码会丢 EXIF，把 RAW 的拍摄参数做成 APP1 段补回去
                const app1 = await API.Invoke({ type: 'exif-app1', path: file })
                const blob = await blobify(c2.toDataURL('image/jpeg', JPG_REENCODE_Q))
                if (app1 && app1.length) {
                    const merged = await injectApp1(blob, app1)
                    if (merged) return merged
                }
                return blob
            }
            case 'png': return await blobify(c2.toDataURL('image/png'))
            case 'webp': return await blobify(c2.toDataURL('image/webp', JPG_REENCODE_Q))
            case 'bmp': return encodeBMP(imgData)
            case 'gif': return encodeGIF(imgData)
            case 'tiff': return encodeTIFF(imgData)
        }
        return null
    }
    function blobify(dataUrl) {
        const b64 = dataUrl.split(',')[1]
        const bin = atob(b64)
        const arr = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
        return new Blob([arr])
    }

    // 用 jpeg-encode 管线把当前像素重编码为 JPG，并保留源 JPEG 的 EXIF/ICC 等元数据。
    // 返回 Blob；源不是 JPEG 或编码失败时返回 null（调用方回退 canvas 编码）。
    async function encodeJpegWithExif(file, im, imgData) {
        try {
            if (typeof JpegEncode === 'undefined' || !imgData) return null
            const head = await API.Invoke({ type: 'jpeg-source', path: file })
            if (!head || !head.ok || !head.src) return null
            const w = im.naturalWidth, h = im.naturalHeight
            if (!w || !h) return null
            const bytes = JpegEncode.encodeRotated(imgData.data, w, h, 0, head.src)
            if (!bytes || !bytes.length) return null
            return new Blob([bytes], { type: 'image/jpeg' })
        } catch (e) {
            return null
        }
    }

    // 把 EXIF APP1 段（含 FFE1 头）插入 JPEG 的 SOI(FFD8) 之后
    async function injectApp1(blob, app1) {
        try {
            const buf = new Uint8Array(await blob.arrayBuffer())
            if (buf.length < 2 || buf[0] !== 0xFF || buf[1] !== 0xD8) return null
            const seg = new Uint8Array(app1)
            const out = new Uint8Array(buf.length + seg.length)
            out.set(buf.subarray(0, 2), 0)
            out.set(seg, 2)
            out.set(buf.subarray(2), 2 + seg.length)
            return new Blob([out], { type: 'image/jpeg' })
        } catch (e) {
            return null
        }
    }

    // 格式转换：写文件到 typechanged 文件夹
    // 转换期间弹「转换中」遮罩冻结界面，防止重复转换；结束（成功/失败）后自动关闭。
    let converting = false
    const busyEl = () => document.getElementById('dlg-busy')
    function showBusy(text) {
        const b = busyEl()
        if (!b) return
        const t = document.getElementById('busy-text')
        if (t) t.textContent = text || '正在转换图片…'
        b.classList.remove('hidden')
    }
    function hideBusy() {
        const b = busyEl()
        if (b) b.classList.add('hidden')
    }
    async function changeType(ext) {
        const file = currentFile()
        if (!file) { info('请选择文件'); return }
        if (converting) return
        converting = true
        showBusy('正在转换图片…')
        try {
            const blob = await encodeCurrentAs(ext)
            if (!blob) { info('转换失败：图片无法解码'); return }
            const folder = file.substring(0, file.lastIndexOf('\\'))
            const base = fileBase(file).replace(/\.[^.]*$/, '.')
            const outDir = folder + '\\typechanged'
            const outPath = outDir + '\\' + base + ext
            // 通过 dataURL 传给主进程保存
            const dataUrl = await blobToDataURL(blob)
            API.CallSys({ type: 'save-format', path: outPath, dataUrl })
            info('图片转换为 ' + ext.toUpperCase() + ' 格式')
        } finally {
            hideBusy()
            converting = false
        }
    }
    function blobToDataURL(blob) {
        return new Promise((res) => {
            const r = new FileReader()
            r.onload = () => res(r.result)
            r.readAsDataURL(blob)
        })
    }

    // 加载文件为 Image 对象（RAW 自动走 raw.cache 缓存）
    function loadImg(file) {
        return new Promise((res, rej) => {
            const im = new Image()
            im.onload = () => res(im)
            im.onerror = () => rej(new Error('图片无法解码: ' + fileBase(file)))
            im.src = srcUrl(file)
        })
    }

    // 单张压缩：统一输出为 jpg 到目标目录
    async function compressOneFile(file, quality, outDir) {
        const base = fileBase(file).replace(/\.[^.]*$/, '')
        const outPath = outDir + '\\' + base + '.jpg'
        const im = await loadImg(file)
        const c = document.createElement('canvas')
        c.width = im.naturalWidth
        c.height = im.naturalHeight
        c.getContext('2d').drawImage(im, 0, 0)
        const q = Math.max(0, Math.min(100, quality || 95)) / 100
        API.CallSys({ type: 'save-format', path: outPath, dataUrl: c.toDataURL('image/jpeg', q) })
    }

    // 压缩：单张（相框/原图下当前图片）或整个文件夹（批量）
    async function compression(isSingle, quality) {
        if (!hasAnyImage()) { info('请先打开一张图片进行浏览'); return }
        const q = quality
        if (isSingle) {
            const file = currentFile()
            if (isRaw(file)) { info('raw格式图片不支持压缩!'); return }
            const folder = file.substring(0, file.lastIndexOf('\\'))
            try {
                await compressOneFile(file, q, folder + '\\compressed')
                info('图片压缩完成：' + fileBase(file))
            } catch (e) {
                info('压缩失败：' + fileBase(file))
            }
            return
        }
        // 批量压缩整个文件夹（跳过 RAW），对应原 CompressionInTotal
        const targets = State.files.slice()
        let done = 0
        for (let i = 0; i < targets.length; i++) {
            const file = targets[i]
            if (isRaw(file)) { info('raw格式图片不支持压缩,跳过 ' + fileBase(file)); continue }
            const folder = file.substring(0, file.lastIndexOf('\\'))
            try {
                await compressOneFile(file, q, folder + '\\compressed')
                done++
            } catch (e) { /* 单张失败不中断批量 */ }
            info('正在进行图片压缩,请稍等...' + (i + 1) + '/' + targets.length)
        }
        info('批量压缩已完成！本次共压缩 ' + done + ' 张图片')
    }

    // 微信压缩：仅 jpg/jpeg，最短边压缩到 1080 以内，输出到 compressedwx（批量整个文件夹）
    async function compressionWx(quality) {
        if (!hasAnyImage()) { info('请先打开一张图片进行浏览'); return }
        const targets = State.files.filter(f => ['jpg', 'jpeg'].includes(getExt(f)))
        if (targets.length === 0) { info('当前文件夹没有可压缩的jpg图片'); return }
        const minL = 1080
        let done = 0
        for (let i = 0; i < targets.length; i++) {
            const file = targets[i]
            try {
                const im = await loadImg(file)
                let w = im.naturalWidth, h = im.naturalHeight
                if (Math.min(w, h) > minL) {
                    const t = minL / Math.min(w, h)
                    w = Math.floor(w * t)
                    h = Math.floor(h * t)
                }
                const c = document.createElement('canvas')
                c.width = w
                c.height = h
                c.getContext('2d').drawImage(im, 0, 0, w, h)
                const folder = file.substring(0, file.lastIndexOf('\\'))
                const base = fileBase(file).replace(/\.[^.]*$/, '')
                const q = Math.max(0, Math.min(100, quality || 95)) / 100
                API.CallSys({ type: 'save-format', path: folder + '\\compressedwx\\' + base + '.jpg', dataUrl: c.toDataURL('image/jpeg', q) })
                done++
            } catch (e) { /* 跳过无法解码的图片 */ }
            info('正在进行微信压缩,请稍等...' + (i + 1) + '/' + targets.length)
        }
        info('适应微信朋友圈的批量压缩已完成！本次共压缩 ' + done + ' 张图片')
    }

    // 旋转保存
    // 旋转本身是无损的：90° 整数倍只是把像素行列重排。真正掉质量、涨体积的是“重新编码”这一步
    // —— JPEG 每解码再编码一次就有一轮 DCT 量化损失，而调高 q 值又会把体积推上去。
    // 所以这里走：canvas 解码出像素（Chromium 已按 EXIF 摆正）-> 整数下标重排旋转（无插值）
    // -> 用**原图的量化表与霍夫曼表**重编码。压缩强度与文件体积和原图同级，输出是真实旋转过的
    // 像素、不依赖 EXIF，任何软件都能正确显示。实现见 util/jpeg-encode.js。
    async function saveRotal() {
        const file = currentFile()
        if (!file) { info('请先打开图片'); return }
        const folder = file.substring(0, file.lastIndexOf('\\'))
        const ext = getExt(file)
        const isJpg = (ext === 'jpg' || ext === 'jpeg')
        const angle = fmtAngle(State.curAngle)

        if (isJpg && typeof JpegEncode !== 'undefined') {
            const outPath = folder + '\\rotaled\\' + fileBase(file)
            const how = await saveRotalJpeg(file, outPath, angle)
            if (how) {
                State.curAngle = 0
                render()
                info(how === 'copy'
                    ? '已保存到rotaled文件夹（图片无旋转，未重新编码）'
                    : '已旋转保存到rotaled文件夹（朝向已写入像素，沿用原图压缩参数）')
                return
            }
            // 结构异常等情况下继续走下面的兜底方案
        }

        const im = await loadImg(file).catch(() => null)
        if (!im) { info('保存失败：图片无法解码'); return }
        // loadImg 得到的是游离 Image，浏览器已按 EXIF 朝向摆正（naturalWidth/Height 也是摆正后的尺寸），
        // 因此这里只需叠加用户的手动旋转角 State.curAngle，不会与拍摄朝向重复旋转。
        const swap = angle % 2
        const c = document.createElement('canvas')
        c.width = swap ? im.naturalHeight : im.naturalWidth
        c.height = swap ? im.naturalWidth : im.naturalHeight
        const ctx = c.getContext('2d')
        ctx.translate(c.width / 2, c.height / 2)
        ctx.rotate(angle * Math.PI / 2)
        // 偏移量必须取图片自身尺寸的一半：用交换后的画布尺寸会让长宽不等的图片被画到画布外（导出全空白）
        ctx.drawImage(im, -im.naturalWidth / 2, -im.naturalHeight / 2)
        const mime = isJpg ? 'image/jpeg' : 'image/png'
        // 非 jpg 源图用 png 承载旋转结果，避免扩展名与内容不一致（PNG 无损）
        const outName = isJpg ? fileBase(file) : fileBase(file).replace(/\.[^.]*$/, '') + '.png'
        const outPath = folder + '\\rotaled\\' + outName
        API.CallSys({ type: 'save-format', path: outPath, dataUrl: c.toDataURL(mime, isJpg ? JPG_REENCODE_Q : undefined) })
        State.curAngle = 0
        render()
        info('图片已旋转保存到rotaled文件夹！')
    }

    // JPEG 旋转保存：真旋转像素 + 沿用原图量化表/霍夫曼表重编码
    // 返回 'copy'（无需改动像素，原样复制）/ 'rotated'（已重编码旋转）/ false（失败，走兜底）
    async function saveRotalJpeg(file, outPath, angle) {
        try {
            const head = await API.Invoke({ type: 'jpeg-source', path: file })
            if (!head || !head.ok || !head.src) return false
            // 原图带 EXIF 自动朝向（手机竖拍照片）时，相机数据里的像素其实是躺着的，只是靠朝向标记
            // 让显示端摆正。既然「旋转后保存」的语义是拿到正确朝向的成品，这里就把自动朝向也落到
            // 像素上：canvas 解码出来的像素已经是浏览器按 EXIF 摆正过的，走重编码即被焊进像素，
            // 同时标记被清回 1（见 forceOrientationNormal），不会二次旋转。
            const autoRot = head.src.orientation && head.src.orientation !== 1
            // 既没有手动旋转、也没有自动朝向：像素无需改动，直接原样复制文件（零损失、不重编码）
            if (angle === 0 && !autoRot) {
                const buf = await API.Invoke({ type: 'read-file-bytes', path: file })
                if (!buf) return false
                const r = await API.Invoke({ type: 'save-format-bin', path: outPath, bytes: buf })
                return (r && r.ok) ? 'copy' : false
            }
            const im = await loadImg(file).catch(() => null)
            if (!im) return false
            const w = im.naturalWidth, h = im.naturalHeight
            if (!w || !h) return false
            const c = document.createElement('canvas')
            c.width = w; c.height = h
            const ctx = c.getContext('2d')
            ctx.drawImage(im, 0, 0)
            const px = ctx.getImageData(0, 0, w, h).data
            const bytes = JpegEncode.encodeRotated(px, w, h, angle, head.src)
            if (!bytes) return false
            const r = await API.Invoke({ type: 'save-format-bin', path: outPath, bytes })
            return (r && r.ok) ? 'rotated' : false
        } catch (e) {
            return false
        }
    }

    // ============ 截屏 ============
    // 取屏由主进程注册的 setDisplayMediaRequestHandler 提供（Electron 未内置 getDisplayMedia 的默认实现，
    // 不注册处理器会直接抛 NotSupportedError）。流程与原 OnCutScreenSwitch 一致：
    // 最小化窗口 -> 抓取整屏 -> 恢复窗口并全屏 -> 拖动选择区域。
    let screenCanvasData = null
    async function doScreenshot() {
        info('截屏中…')
        let restored = false
        const restoreWin = () => { if (!restored) { restored = true; API.CallSys({ type: 'restore-window' }) } }
        try {
            // 最小化窗口，避免把自身截进去
            API.CallSys({ type: 'minimize-window' })
            // 延迟以确保窗口收起
            await new Promise(r => setTimeout(r, 300))
            const stream = await navigator.mediaDevices.getDisplayMedia({ video: true })
            const track = stream.getVideoTracks()[0]
            const v = document.createElement('video')
            v.muted = true
            v.srcObject = stream
            await new Promise((res, rej) => {
                v.onloadedmetadata = () => v.play().then(res, rej)
                v.onerror = () => rej(new Error('无法读取屏幕画面'))
            })
            // 等首帧真正到位，否则 drawImage 可能画出空白（未挂到文档的视频可能不触发 RVFC，故加超时兜底）
            await new Promise(res => {
                let done = false
                const finish = () => { if (!done) { done = true; res() } }
                if (typeof v.requestVideoFrameCallback === 'function') v.requestVideoFrameCallback(finish)
                setTimeout(finish, 300)
            })
            const c = document.createElement('canvas')
            c.width = v.videoWidth
            c.height = v.videoHeight
            if (c.width <= 0 || c.height <= 0) throw new Error('屏幕分辨率为空')
            c.getContext('2d').drawImage(v, 0, 0)
            try { track.stop() } catch (e) { /* 停止失败不影响截图数据 */ }
            restoreWin()
            screenCanvasData = c
            // 选区内不显示工具栏；清掉上一次的选区状态
            toolbar.classList.remove('show')
            selDrag = null
            selRectPx = null
            selRectEl.classList.add('hidden')
            selMask.classList.remove('hidden')
            resizeSel(c)
            API.CallSys({ type: 'fullscreen', on: true })
            info('拖动鼠标选择区域；右键/Enter 剪切保存；Esc取消')
        } catch (e) {
            restoreWin()
            info('截屏失败: ' + ((e && e.message) ? e.message : e))
        }
    }

    let selDpr = 1
    let selMap = null
    let selRectPx = null    // 已确定的选区（CSS 像素，相对 #sel-mask）
    let selDrag = null      // 拖动起点（CSS 像素，相对 #sel-mask）

    // 把截图画布铺满遮罩：背衬按设备像素，高 DPI 屏不被 CSS 放大而发虚；
    // 之后一律按 CSS 像素绘制，与鼠标坐标一致。此处只画底图，选区由 DOM 元素负责。
    function resizeSel(srcCanvas) {
        // 窗口最小化/尺寸切换过程中会读到 0，此时保持上一帧，避免把画布清成空白
        const w = selCanvas.clientWidth, h = selCanvas.clientHeight
        if (!srcCanvas || w <= 0 || h <= 0) return
        selDpr = window.devicePixelRatio || 1
        selCanvas.width = Math.round(w * selDpr)
        selCanvas.height = Math.round(h * selDpr)
        const ctx = selCanvas.getContext('2d')
        // 设过 width/height 后变换会重置，故此处重设
        ctx.setTransform(selDpr, 0, 0, selDpr, 0, 0)
        ctx.imageSmoothingQuality = 'high'
        const s = Math.min(w / srcCanvas.width, h / srcCanvas.height)
        const dw = srcCanvas.width * s, dh = srcCanvas.height * s
        const ox = (w - dw) / 2, oy = (h - dh) / 2
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, w, h)
        ctx.drawImage(srcCanvas, 0, 0, srcCanvas.width, srcCanvas.height, ox, oy, dw, dh)
        selMap = { ox, oy, s, srcW: srcCanvas.width, srcH: srcCanvas.height }
    }

    // 选区用独立 DOM 元素表示：不参与画布重绘，窗口尺寸变化/画布重画都不会把它抹掉
    function updateSelRectEl(r) {
        if (!r || r.w < 1 || r.h < 1) { selRectEl.classList.add('hidden'); return }
        selRectEl.classList.remove('hidden')
        selRectEl.style.left = r.x + 'px'
        selRectEl.style.top = r.y + 'px'
        selRectEl.style.width = r.w + 'px'
        selRectEl.style.height = r.h + 'px'
    }
    function selPoint(e) {
        const r = selMask.getBoundingClientRect()
        return { x: e.clientX - r.left, y: e.clientY - r.top }
    }
    selMask.addEventListener('pointerdown', (e) => {
        if (!screenCanvasData || e.button !== 0) return
        const p = selPoint(e)
        selDrag = p
        selRectPx = { x: p.x, y: p.y, w: 0, h: 0 }
        updateSelRectEl(selRectPx)
        // 捕获指针：拖到窗口外也能持续收到事件，松手一定落在遮罩上
        try { selMask.setPointerCapture(e.pointerId) } catch (err) { /* 不支持时退化为普通事件 */ }
    })
    selMask.addEventListener('pointermove', (e) => {
        if (!selDrag) return
        const p = selPoint(e)
        selRectPx = {
            x: Math.min(selDrag.x, p.x), y: Math.min(selDrag.y, p.y),
            w: Math.abs(p.x - selDrag.x), h: Math.abs(p.y - selDrag.y),
        }
        updateSelRectEl(selRectPx)
    })
    function endSelDrag() {
        if (!selDrag) return
        selDrag = null
        updateSelRectEl(selRectPx)
    }
    selMask.addEventListener('pointerup', endSelDrag)
    selMask.addEventListener('pointercancel', endSelDrag)
    // 截屏选择中右键 = 剪切保存（对应原 OnCutScreenCut），不弹程序菜单
    selMask.addEventListener('contextmenu', (e) => { e.preventDefault(); cutScreen() })

    function cutScreen() {
        if (!screenCanvasData) return
        const { ox, oy, s } = selMap || { ox: 0, oy: 0, s: 1 }
        const imgW = screenCanvasData.width * s, imgH = screenCanvasData.height * s
        let srcRect = null
        const r = selRectPx
        if (r && r.w > 4 && r.h > 4) {
            // 选区可能覆盖到上下黑边，需夹到图片显示范围内
            const x1 = Math.max(ox, r.x), y1 = Math.max(oy, r.y)
            const x2 = Math.min(ox + imgW, r.x + r.w), y2 = Math.min(oy + imgH, r.y + r.h)
            if (x2 - x1 > 1 && y2 - y1 > 1) {
                srcRect = {
                    sx: Math.round((x1 - ox) / s), sy: Math.round((y1 - oy) / s),
                    sw: Math.round((x2 - x1) / s), sh: Math.round((y2 - y1) / s)
                }
            }
        }
        // 未选择区域时按整屏处理（与原实现一致）
        if (!srcRect) srcRect = { sx: 0, sy: 0, sw: screenCanvasData.width, sh: screenCanvasData.height }
        const c = document.createElement('canvas')
        c.width = srcRect.sw
        c.height = srcRect.sh
        const ctx = c.getContext('2d')
        ctx.drawImage(screenCanvasData, srcRect.sx, srcRect.sy, srcRect.sw, srcRect.sh, 0, 0, srcRect.sw, srcRect.sh)
        // 保存到图片并放入剪贴板（对应原 OnCutScreenCut）
        continueSave(c.toDataURL('image/png'), 'clip')
        exitScreenshot()
        info('截图已保存并放入剪贴板')
    }
    function exitScreenshot() {
        screenCanvasData = null
        selDrag = null
        selRectPx = null
        selMap = null
        selRectEl.classList.add('hidden')
        selMask.classList.add('hidden')
        API.CallSys({ type: 'fullscreen', on: false })
    }

    // ============ 打开图片对话框 ============
    // 打开对话框互斥：未关闭前忽略重复请求（滚轮反复触发时只弹一次）
    function openImageDialog() {
        if (State.dialogOpening) return
        State.dialogOpening = true
        API.CallSys({ type: 'open-image-dialog' })
    }
    async function openCurDir() {
        const f = currentFile()
        if (!f) {
            // 未打开图片时打开程序所在目录（渲染进程无 __dirname，向主进程索取）
            const dir = await API.Invoke({ type: 'app-dir' })
            if (dir) API.CallSys({ type: 'open-dir', path: dir })
            return
        }
        API.CallSys({ type: 'dir-select', path: f })
    }

    // ============ 右键菜单 ============
    const ctxmenu = document.getElementById('ctxmenu')
    function showCtxMenu(x, y) {
        hideModeMenu()
        ctxmenu.classList.remove('hidden', 'flip')
        ctxmenu.style.left = x + 'px'
        ctxmenu.style.top = y + 'px'
        // 先测量实际尺寸再夹进视口，避免一级菜单超出屏幕
        const r = ctxmenu.getBoundingClientRect()
        const vw = window.innerWidth
        const vh = window.innerHeight
        let nx = x
        let ny = y
        if (nx + r.width > vw - 4) nx = Math.max(4, vw - r.width - 4)
        if (ny + r.height > vh - 4) ny = Math.max(4, vh - r.height - 4)
        ctxmenu.style.left = nx + 'px'
        ctxmenu.style.top = ny + 'px'
        // 右侧空间放不下子菜单时，子菜单改为向左展开
        const SUB_W = 200
        if (nx + r.width + SUB_W > vw - 4) ctxmenu.classList.add('flip')
    }
    function hideCtxMenu() { ctxmenu.classList.add('hidden') }

    // 浏览模式切换菜单（点击状态栏模式信息弹出，复用右键菜单的模式项逻辑）
    const modemenu = document.getElementById('modemenu')
    function showModeMenu(x, y) {
        hideCtxMenu()
        modemenu.classList.remove('hidden')
        const r = modemenu.getBoundingClientRect()
        const vw = window.innerWidth
        const vh = window.innerHeight
        let nx = x
        let ny = y
        if (nx + r.width > vw - 4) nx = Math.max(4, vw - r.width - 4)
        if (ny + r.height > vh - 4) ny = Math.max(4, vh - r.height - 4)
        modemenu.style.left = nx + 'px'
        modemenu.style.top = ny + 'px'
    }
    function hideModeMenu() { modemenu.classList.add('hidden') }

    // ============ 模式切换 ============
    const MODE_NAMES = { NOT_OVERFLOW: '相框', NORMAL: '原图', CARTOON: '漫画', CHOOSE: '筛选' }
    // 模式切换已移入右键菜单：在菜单项上打勾，并在状态栏显示当前模式
    function updateModeIndicator() {
        document.querySelectorAll('#ctxmenu .cm-item[data-mode], #modemenu .cm-item[data-mode]').forEach(it => {
            it.classList.toggle('mode-active', it.dataset.mode === State.mode)
        })
        const stMode = document.getElementById('st-mode')
        if (stMode) stMode.textContent = (MODE_NAMES[State.mode] || State.mode) + '模式'
    }
    function setMode(m, anchor) {
        State.mode = m
        cartoonSyncScroll()
        State.chooseLarge = null
        resetChooseZoom()
        updateModeIndicator()
        switch (m) {
            case 'NOT_OVERFLOW': State.curTimes = 1.0; focusBorders.classList.remove('hidden'); break
            case 'CARTOON': State.curTimes = 1.0; break
            case 'NORMAL':
                // 原图模式固定按 1 倍展示；画面中心锚在 anchor 指向的内容点
                //（右键菜单进入时为右键点击处，快捷键/状态栏进入时为图片正中），并清掉残留平移
                State.curTimes = 1.0
                State.normalCenter = anchor || null
                panX = 0; panY = 0
                break
            case 'CHOOSE': State.curTimes = 1.0; focusBorders.classList.add('hidden'); break
        }
        render()
    }

    // ============ GIF 播放/暂停 ============
    // 浏览器不提供暂停 <img> 里 GIF 动画的能力，且实测 Chromium 用 canvas.drawImage(img)
    // 抓动图时永远只得到第一帧（与播放进度无关），所以「暂停时停在当前帧」无法靠快照实现。
    // 这里改为：相框/原图模式下 GIF 由 <canvas id="gif-canvas"> 自绘播放
    //（ImageDecoder 逐帧解码，按各帧时长排下一帧），暂停＝停掉定时器，画面自然停在当前帧。
    // 解码失败则回退到 <img> 原生动画（仅失去暂停能力，显示不受影响）。
    const gif = {
        dec: null,        // ImageDecoder 实例
        frameCount: 0,
        next: 0,          // 下一帧序号
        timer: 0,
        playing: false,
        paused: false,    // 用户暂停（切模式不丢失）
        path: '',         // 已装载的 GIF 路径
        token: 0,         // 换图令牌：让在途的解码/定时任务作废
        visible: false,   // canvas 是否正替代 #img-single 显示
        err: '',          // 自绘播放失败的原始原因（供提示与应用日志）
    }

    function isGifFile(f) { return !!f && getExt(f) === 'gif' }

    // 按文件头识别真实图片类型：扩展名不可信（实测有 .gif 实为 WebP 的文件，
    // <img> 能按内容正常显示与播放，而 ImageDecoder 若按扩展名传 image/gif 会直接报
    // “Failed to retrieve track metadata”而无法解码）
    function sniffImageType(bytes) {
        if (!bytes || bytes.length < 12) return ''
        if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif'
        if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
            bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
        if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'image/png'
        if (bytes[0] === 0xFF && bytes[1] === 0xD8) return 'image/jpeg'
        return ''
    }

    // 画布与 #img-single 保持完全一致的几何：直接复制其内联样式，
    // 这样缩放/旋转(drawSingle)与平移(applyPan)照旧只改 #img-single 即可
    function gifSyncGeom() {
        if (!gif.visible) return
        gifCanvas.style.cssText = imgSingle.style.cssText
        gifCanvas.style.display = 'block'
        gifCanvas.style.visibility = 'visible'
        imgSingle.style.visibility = 'hidden'
    }
    function gifShowCanvas() { gif.visible = true; gifSyncGeom() }
    function gifHideCanvas() {
        gif.visible = false
        gifCanvas.style.display = 'none'
        imgSingle.style.visibility = ''
    }
    function gifStopTimer() {
        if (gif.timer) { clearTimeout(gif.timer); gif.timer = 0 }
        gif.playing = false
    }
    // 停止自绘显示（离开单图模式/无图时），保留解码器以便切回来立即继续
    function gifDetach() { gifStopTimer(); gifHideCanvas() }

    // 释放播放器（换图、切到非 GIF、出错时）
    function gifClose() {
        gif.token++
        gifStopTimer()
        gif.paused = false
        gif.path = ''
        gif.frameCount = 0
        gif.next = 0
        gif.err = ''
        if (gif.dec) { try { gif.dec.close() } catch (e) {} gif.dec = null }
        gifHideCanvas()
    }

    // 画第 i 帧，返回该帧时长(µs)；解码失败返回 0
    async function gifDrawFrame(token, i) {
        try {
            const r = await gif.dec.decode({ frameIndex: i })
            const frame = r.image
            if (token !== gif.token) { frame.close(); return 0 }
            // 动图帧由解码器合成输出（含背景），逐帧重绘前清屏即可
            gifCtx.clearRect(0, 0, gifCanvas.width, gifCanvas.height)
            gifCtx.drawImage(frame, 0, 0)
            const us = frame.duration || 100000
            frame.close()
            return us
        } catch (e) { return 0 }
    }

    // 逐帧推进：解码是异步的，用 token 保证换图后在途任务不会画到新画布上
    async function gifStep(token) {
        if (!gif.playing || token !== gif.token || !gif.dec) return
        const i = gif.next
        const us = await gifDrawFrame(token, i)
        if (!gif.playing || token !== gif.token) return
        if (!us) { gifStopTimer(); return }
        gif.next = (i + 1) % gif.frameCount
        // 帧时长(µs→ms)；过小的延时按浏览器惯例补到 100ms，否则这类 GIF 会明显偏快
        const ms = us / 1000
        gif.timer = setTimeout(() => gifStep(token), ms < 20 ? 100 : Math.round(ms))
    }

    function gifPlay() {
        // 单帧 GIF 无需逐帧推进，画布停在第 0 帧即可
        if (gif.playing || !gif.dec || gif.frameCount < 2) return
        gif.playing = true
        gifStep(gif.token)
    }

    // 装载 GIF 并自绘播放：先让 <img> 照常显示，解码就绪后再切到 canvas（避免白屏）
    async function gifLoad(f) {
        const token = ++gif.token
        gifStopTimer()
        if (gif.dec) { try { gif.dec.close() } catch (e) {} gif.dec = null }
        // 换到另一张 GIF 时先切回 <img>（此时 #img-single 已是新图），解码就绪后再接管
        gifHideCanvas()
        gif.path = f
        gif.paused = false
        gif.next = 0
        gif.frameCount = 0
        gif.err = ''
        const bytes = await API.Invoke({ type: 'read-file-bytes', path: displayPath(f) })
        if (token !== gif.token || !bytes || !bytes.length || typeof ImageDecoder === 'undefined') return
        try {
            const dec = new ImageDecoder({ data: bytes, type: sniffImageType(bytes) || 'image/gif' })
            if (dec.tracks) await dec.tracks.ready
            else await dec.completed
            if (token !== gif.token) { try { dec.close() } catch (e) {} return }
            const track = dec.tracks ? dec.tracks.selectedTrack : null
            // 单帧图（含静态 WebP）有的实现不报帧数，按 1 帧处理
            const n = (track && track.frameCount) ? track.frameCount : 1
            gif.dec = dec
            gif.frameCount = n
            gifCanvas.width = imgSingle.naturalWidth || 1
            gifCanvas.height = imgSingle.naturalHeight || 1
            const us = await gifDrawFrame(token, 0)
            if (token !== gif.token) return
            if (!us) throw new Error('首帧解码失败')
            gif.next = 1 % n
            gifShowCanvas()
            if (!gif.paused) gifPlay()
        } catch (e) {
            // 解码失败：保留 <img> 原生动画（仅失去暂停能力），原因记入应用日志便于排查
            gif.err = String((e && e.message) || e)
            pushAppLog('GIF 自绘播放失败（' + fileBase(f) + '）：' + gif.err)
            if (gif.dec) { try { gif.dec.close() } catch (e2) {} gif.dec = null }
            gifHideCanvas()
        }
    }

    // 渲染入口按当前文件/模式同步 GIF 的显示方式
    function syncGif() {
        const f = currentFile()
        const single = State.mode === 'NOT_OVERFLOW' || State.mode === 'NORMAL'
        if (!f || !isGifFile(f)) { if (gif.path || gif.dec) gifClose(); return }
        if (!single) { gifDetach(); return }
        if (gif.path !== f) { gifLoad(f); return }
        if (!gif.paused) gifPlay()
    }

    function toggleGif() {
        const f = currentFile()
        if (!isGifFile(f)) { info('当前图片不是GIF'); return }
        if (State.mode !== 'NOT_OVERFLOW' && State.mode !== 'NORMAL') { info('该模式下不支持控制GIF播放'); return }
        if (!gif.dec) { info(gif.err ? '该GIF无法暂停播放' : 'GIF 尚未就绪'); return }
        if (gif.paused) {
            gif.paused = false
            gifPlay()
            info('已继续GIF播放')
        } else {
            gif.paused = true
            gifStopTimer()   // 画布保持在当前帧，不再推进
            info('已暂停GIF播放')
        }
    }

    // ============ 帮助 ============
    function showHelp() {
        const el = document.getElementById('dlg-help')
        if (el) el.classList.remove('hidden')
    }

    // ============ 关于 ============
    function showAbout() {
        API.Invoke({ type: 'app-info' }).then((info) => {
            if (!info || !info.versions) { D('dlg-about').classList.remove('hidden'); return }
            const nameEl = document.getElementById('about-name')
            const verEl = document.getElementById('about-version')
            if (nameEl) nameEl.textContent = (info.name === 'Electron' ? 'PicSee' : info.name)
            if (verEl) verEl.textContent =
                `版本 ${info.appVersion}  ·  Electron ${info.versions.electron}  ·  Chromium ${info.versions.chrome}  ·  Node ${info.versions.node}`
            D('dlg-about').classList.remove('hidden')
        }).catch(() => D('dlg-about').classList.remove('hidden'))
    }

    // ============ 许可证 ============
    function showLicense() {
        API.Invoke({ type: 'license-text' }).then((text) => {
            const el = document.getElementById('license-text')
            if (el) el.textContent = text || '（未找到 LICENSE 文件）'
            D('dlg-license').classList.remove('hidden')
        }).catch(() => D('dlg-license').classList.remove('hidden'))
    }

    // ============ 键盘 / 鼠标 / 滚轮 ============
    // 命令快捷键：对齐原 MFC 工程 IDR_MAINFRAME ACCELERATORS 的加速键表
    //   Ctrl+O 打开图片   Ctrl+C 复制到 _copied   Ctrl+X 移动到 _moved   Ctrl+P 标记当前图片
    //   Ctrl+A 格式转换   Ctrl+S 旋转后保存       Ctrl+F 全屏               Ctrl+D 删除到回收站
    //   Ctrl+Shift+D 截屏  Ctrl+← 左旋            Ctrl+→ 右旋              空格 GIF 播放/暂停
    //   Alt+B 相框  Alt+N 原图  Alt+M 漫画  Alt+X 筛选
    // 注意：原工程菜单文字把 Ctrl+P 写成“打印”，实际加速键绑的是标记位置；Ctrl+Shift+D 亦为原表先后顺序。
    // 这里用 e.code 判定（不受大小写与输入法影响），命中即 preventDefault，避免触发
    // 浏览器默认行为（Ctrl+S 保存网页、Ctrl+O 打开文件、Ctrl+P 打印、空格滚动等）。
    function shortcutAction(e) {
        // 正在输入或对话框打开时不响应，避免与输入框自身的 Ctrl+A/C/X、Ctrl+S 冲突
        const ae = document.activeElement
        if (ae && (/^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) || ae.isContentEditable)) return null
        if (document.querySelector('.modal:not(.hidden)')) return null

        if (e.altKey && !e.ctrlKey) {
            const modes = { KeyB: 'NOT_OVERFLOW', KeyN: 'NORMAL', KeyM: 'CARTOON', KeyX: 'CHOOSE' }
            const m = modes[e.code]
            return m ? () => setMode(m) : null
        }
        if (!e.ctrlKey && !e.altKey && e.code === 'Space') return () => runCmd('gifswitch')
        if (!e.ctrlKey) return null
        if (e.code === 'ArrowLeft') return turnLeft
        if (e.code === 'ArrowRight') return turnRight
        // Ctrl+Shift+D 截屏需先于 Ctrl+D 删除判定
        if (e.shiftKey) return e.code === 'KeyD' ? () => runCmd('screenshot') : null
        const cmds = {
            KeyO: 'open', KeyC: 'copyfile', KeyX: 'movefile', KeyP: 'mark',
            KeyA: 'changetype', KeyS: 'saverot', KeyF: 'fullscreen', KeyD: 'del',
        }
        const cmd = cmds[e.code]
        return cmd ? () => runCmd(cmd) : null
    }

    document.addEventListener('keydown', (e) => {
        if (selMask.classList.contains('hidden') === false) {
            // 截屏选择中屏蔽程序快捷键，避免误触删除/翻页等
            if (e.key === 'Escape') { exitScreenshot(); return }
            if (e.key === 'Enter') { cutScreen(); return }
            e.preventDefault()
            return
        }
        // 菜单打开时忽略
        if (!ctxmenu.classList.contains('hidden') || !modemenu.classList.contains('hidden')) {
            if (e.key === 'Escape') { hideCtxMenu(); hideModeMenu() }
            return
        }
        // 命令快捷键优先于方向键分支，否则 Ctrl+←/→ 会被当成翻页/拖动
        const act = shortcutAction(e)
        if (act) { e.preventDefault(); act(); return }
        switch (State.mode) {
            case 'NOT_OVERFLOW':
            case 'CHOOSE':
                if (e.key === 'ArrowLeft') { toPre(); e.preventDefault() }
                else if (e.key === 'ArrowRight') { toNext(); e.preventDefault() }
                else if (e.key === 'Escape') API.CallSys({ type: 'fullscreen', on: false })
                break
            case 'CARTOON':
                if (e.key === 'ArrowLeft') { cartoonPre(); e.preventDefault() }
                else if (e.key === 'ArrowRight') { cartoonNext(); e.preventDefault() }
                else if (e.key === 'ArrowUp') { cartoonScrollBy(20); e.preventDefault() }
                else if (e.key === 'ArrowDown') { cartoonScrollBy(-20); e.preventDefault() }
                else if (e.key === 'Escape') API.CallSys({ type: 'fullscreen', on: false })
                break
            case 'NORMAL':
                if (e.key === 'ArrowLeft') { panImg(20, 0); e.preventDefault() }
                else if (e.key === 'ArrowRight') { panImg(-20, 0); e.preventDefault() }
                else if (e.key === 'ArrowUp') { panImg(0, 20); e.preventDefault() }
                else if (e.key === 'ArrowDown') { panImg(0, -20); e.preventDefault() }
                else if (e.key === 'Escape') API.CallSys({ type: 'fullscreen', on: false })
                break
        }
        // 快捷键（全局）
        if (e.key === 'Delete') { delCurFile(); e.preventDefault() }
    })
    function panImg(dx, dy) {
        panX += dx; panY += dy
        applyPan()
    }
    function applyPan() {
        const img = imgSingle
        const w = img.offsetWidth, h = img.offsetHeight
        // 与 drawSingle 共用 singleCenter：锚点 + 平移，避免拖拽时跳回图片正中
        const c = singleCenter(w, h)
        img.style.left = (c.x - w / 2) + 'px'
        img.style.top = (c.y - h / 2) + 'px'
        gifSyncGeom()
    }

    // 鼠标滚轮
    // 翻页限速：一次滚轮拨动（含触摸板连续事件）只翻一张，避免滚动过量时连续翻页
    const WHEEL_NAV_INTERVAL = 120
    let lastWheelNav = 0
    document.addEventListener('wheel', (e) => {
        // 弹框打开时忽略滚轮，避免滚动弹框内容时背景图片翻页/缩放
        if (document.querySelector('.modal:not(.hidden)')) return
        if (State.mode === 'CARTOON') {
            // 只累积目标偏移，由动画帧缓动逼近并统一做越界翻页判定
            const delta = Math.abs(e.deltaY) * 100 / 60
            if (e.deltaY) cartoonScrollBy(e.deltaY < 0 ? delta : -delta)
            return
        }
        if (e.ctrlKey) {
            if (e.deltaY < 0) enlarge()
            else narrow()
        } else {
            const now = Date.now()
            if (now - lastWheelNav < WHEEL_NAV_INTERVAL) return
            lastWheelNav = now
            if (e.deltaY < 0) toPre()
            else toNext()
        }
    }, { passive: true })

    // 拖拽平移（原图模式）
    let dragStart = null
    VIEWPORT.addEventListener('mousedown', (e) => {
        if (!selMask.classList.contains('hidden')) return   // 截屏选择中不做图片平移
        if (State.mode === 'NORMAL' && !State.drawing && !ctxmenu.classList.contains('hidden') === false) {
            dragStart = { x: e.clientX, y: e.clientY }
        }
    })
    document.addEventListener('mousemove', (e) => {
        if (State.mode === 'CARTOON' && e.buttons === 1 && !State.drawing) {
            applyPanDrag(e)
            return
        }
        if (State.mode === 'NORMAL' && dragStart && e.buttons === 1 && !State.drawing) {
            const dx = e.clientX - dragStart.x, dy = e.clientY - dragStart.y
            dragStart = { x: e.clientX, y: e.clientY }
            panX += dx; panY += dy
            applyPan()
        }
    })
    document.addEventListener('mouseup', () => { dragStart = null; cartoonDragY = null; curStroke = null })

    // 漫画模式上下拖动滚动（对应原 OnMouseMove 的 CARTOON 分支，位移放大 2 倍）
    let cartoonDragY = null
    function applyPanDrag(e) {
        if (cartoonDragY === null) { cartoonDragY = e.clientY; return }
        const move = e.clientY - cartoonDragY
        if (move === 0) return
        cartoonDragY = e.clientY
        cartoonSyncScroll()        // 拖拽即时响应，清除未完成的平滑动画
        const delta = 2 * move
        State.overHeight += delta
        if (delta < 0) {           // 向上拖动：内容上移，越过当前图底部则翻到下一张
            if (curPicHeight > 0 && State.overHeight + curPicHeight < 0) { cartoonFlipNext(); return }
        } else if (State.overHeight >= 0) {   // 向下拖动：越过当前图顶部则翻到上一张
            cartoonFlipPre(); return
        }
        applyCartoonScroll()
    }

    // 筛选模式交互：单击逐次再放大一倍并居中、放大后拖动平移、双击放大单张、Ctrl+点击删除
    let chooseClickTimer = 0
    let chooseDrag = null
    chooseStage.addEventListener('mousedown', (e) => {
        if (State.mode !== 'CHOOSE') return
        const box = e.target.closest('.choose-div')
        if (!box) return
        // 从按下起就跟踪位移，任何倍率下拖动都记为拖动，避免松手时被误判成单击
        chooseDrag = { x: e.clientX, y: e.clientY, px: State.choosePan.x, py: State.choosePan.y, moved: false }
        State.chooseClick = { sel: parseInt(box.dataset.sel, 10), ctrl: e.ctrlKey }
    })
    // 拖动可能移出舞台（状态栏/工具栏），故移动与松手都挂在 document 上
    document.addEventListener('mousemove', (e) => {
        if (State.mode !== 'CHOOSE' || !chooseDrag) return
        const dx = e.clientX - chooseDrag.x, dy = e.clientY - chooseDrag.y
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) chooseDrag.moved = true
        State.choosePan = { x: chooseDrag.px + dx, y: chooseDrag.py + dy }
        layoutChooseImgs()
    })
    document.addEventListener('mouseup', (e) => {
        if (State.mode !== 'CHOOSE' || (!chooseDrag && !State.chooseClick)) return
        const dragged = !!(chooseDrag && chooseDrag.moved)
        chooseDrag = null
        const click = State.chooseClick
        State.chooseClick = null
        const box = e.target.closest ? e.target.closest('.choose-div') : null
        if (!box || !click) return
        if (click.ctrl) { delChoose(click.sel); return }
        if (dragged) return                       // 拖动平移过，不再当作单击
        if (parseInt(box.dataset.sel, 10) !== click.sel) return   // 按下与松开不在同一张图上
        if (State.chooseLarge !== null) return    // 单张放大态由双击还原
        clearTimeout(chooseClickTimer)
        // 延迟执行，给双击预留判定时间（双击时由 dblclick 取消）
        chooseClickTimer = setTimeout(() => zoomChoose(box, e.clientX, e.clientY), 240)
    })
    chooseStage.addEventListener('dblclick', (e) => {
        if (State.mode !== 'CHOOSE') return
        const box = e.target.closest('.choose-div')
        if (!box) return
        clearTimeout(chooseClickTimer)
        enlargeChoose(parseInt(box.dataset.sel, 10))
    })
    // 「还原大小」按钮：回到贴合原大小的并排对比
    chooseRestore.addEventListener('click', (e) => {
        e.stopPropagation()
        resetChooseZoom()
        layoutChooseImgs()
        info('已还原为原大小并排对比')
    })

    function delChoose(sel) {
        const idx = (State.curIndex + sel) % State.files.length
        const f = State.files[idx]
        API.Invoke({ type: 'delete-file', path: f }).then(r => {
            if (!r || !r.ok) { info((r && r.err) || '删除失败'); return }
            const msg = deleteResultText(r) + fileBase(f)
            State.files.splice(idx, 1)
            State.chooseLarge = null
            resetChooseZoom()
            if (State.files.length === 0) {
                State.curIndex = -1
                State.hasImage = false
                showIndexPic()
                render()
                info(msg)   // 放在 render 之后：状态栏刷新会清空 st-info
                return
            }
            if (State.curIndex > State.files.length - 1) State.curIndex = State.files.length - 1
            render()
            info(msg)       // drawChoose 会写模式提示，故放在 render 之后
        })
    }
    // 双击放大展示所选图片，再次双击还原并排对比（对应原 ChooseLargeModel）
    function enlargeChoose(sel) {
        State.chooseLarge = (State.chooseLarge === sel) ? null : sel
        if (State.chooseLarge === null) resetChooseZoom()
        render()
    }

    // 切换全屏
    function toggleFullscreen() { API.CallSys({ type: 'fullscreen', on: !isFullscreenNow }) }
    let isFullscreenNow = false
    API.CallSys({ type: 'fullscreen-check' })

    // ============ 事件绑定 ============
    document.querySelectorAll('.tb-btn').forEach(b => {
        b.addEventListener('click', () => runAction(b.dataset.act))
        b.addEventListener('mousedown', (e) => e.preventDefault())
    })
    function runAction(act) {
        switch (act) {
            case 'pre': toPre(); break
            case 'next': toNext(); break
            case 'larger': enlarge(); break
            case 'narrow': narrow(); break
            case 'turnleft': turnLeft(); break
            case 'turnright': turnRight(); break
            case 'init': initPara(); break
            case 'del': delCurFile(); break
        }
    }
    // 菜单项：父项（cm-parent）仅悬停展开子菜单；子项按 data-mode 切模式、按 data-cmd 执行命令
    document.querySelectorAll('#ctxmenu .cm-item').forEach(it => {
        if (it.classList.contains('cm-parent')) return
        it.addEventListener('click', (e) => {
            e.stopPropagation()
            // 切「原图模式」时把右键点击处换算成图片内容点作为画面中心（点击在图片外则回落到图片正中）
            if (it.dataset.mode) setMode(it.dataset.mode, it.dataset.mode === 'NORMAL' ? imgNormFromClient(ctxClick.x, ctxClick.y) : undefined)
            else if (it.dataset.cmd) runCmd(it.dataset.cmd)
            hideCtxMenu()
        })
    })
    // 状态栏模式信息：点击弹出浏览模式切换菜单
    document.getElementById('st-mode').addEventListener('click', (e) => {
        e.stopPropagation()
        if (!modemenu.classList.contains('hidden')) { hideModeMenu(); return }
        showModeMenu(e.clientX, e.clientY)
    })
    document.querySelectorAll('#modemenu .cm-item').forEach(it => {
        it.addEventListener('click', (e) => {
            e.stopPropagation()
            if (it.dataset.mode) setMode(it.dataset.mode)
            hideModeMenu()
        })
    })
    function runCmd(cmd) {
        switch (cmd) {
            case 'del': delCurFile(); break
            case 'open': openImageDialog(); break
            case 'opendir': openCurDir(); break
            case 'copyfile': copyCurFile(); break
            case 'movefile': moveCurFile(); break
            case 'mark': markCur(); break
            case 'savedel': goMark(); break
            case 'drawline': toggleDraw(); break
            case 'cleandraw': cleanDraw(); break
            case 'savescreen': saveScreen(); break
            case 'changetype': showChangeTypeDlg(); break
            case 'compression': showCompressionDlg(true); break
            case 'compressall': showCompressionDlg(false); break
            case 'compresswx': compressionWx(95); break
            case 'saverot': saveRotal(); break
            case 'screenshot': doScreenshot(); break
            case 'cancut': exitScreenshot(); break
            case 'gifswitch': toggleGif(); break
            case 'fullscreen': API.CallSys({ type: 'fullscreen', on: true }); break
            case 'help': showHelp(); break
            case 'about': showAbout(); break
            case 'license': showLicense(); break
            case 'applog': showAppLog(); break
            case 'devtool': API.CallSys({ type: 'devtools', on: true }); break
        }
    }

    // 右键菜单
    let ctxClick = { x: 0, y: 0 }   // 右键按下位置，供「原图模式」把该处内容点作为画面中心
    VIEWPORT.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        ctxClick = { x: e.clientX, y: e.clientY }
        showCtxMenu(e.clientX, e.clientY)
    })
    document.addEventListener('click', (e) => {
        if (!ctxmenu.contains(e.target)) hideCtxMenu()
        if (!modemenu.contains(e.target)) hideModeMenu()
    })

    // 对话框
    const D = (id) => document.getElementById(id)
    function showCompressionDlg(isSingle) {
        D('dlg-compression').classList.remove('hidden')
        D('dlg-compression').dataset.single = isSingle ? '1' : '0'
    }
    D('comp-ok').onclick = () => {
        const q = parseInt(D('comp-quality').value, 10) || 95
        if (D('dlg-compression').dataset.single === '1') compression(true, q)
        else compression(false, q)
        D('dlg-compression').classList.add('hidden')
    }
    D('comp-cancel').onclick = () => D('dlg-compression').classList.add('hidden')

    // 各转换格式的说明提示（随弹窗内选中格式切换）
    const CT_TIPS = {
        jpg: '有损压缩（质量 95）：体积小、画质好，照片和日常分享首选。',
        bmp: '无压缩：体积最大（约为 宽×高×3 字节），仅特殊用途使用。',
        png: '无损压缩：截图、图形、文字类首选；照片噪点难压缩，体积会非常大（全尺寸可达数十 MB）。',
        gif: '256 色索引色：仅适合简单图形与动图，照片会严重失真。',
        tiff: '低压缩：适合印刷与存档，体积较大。',
        webp: '有损压缩（质量 95）：比 JPG 体积更小、画质相当，适合分享。',
    }
    function updateCtTip() {
        const sel = document.querySelector('input[name="ct"]:checked')
        D('ct-tip').textContent = CT_TIPS[sel ? sel.value : 'jpg'] || ''
    }
    document.querySelectorAll('input[name="ct"]').forEach((r) => r.addEventListener('change', updateCtTip))
    function showChangeTypeDlg() { updateCtTip(); D('dlg-changetype').classList.remove('hidden') }
    D('ct-ok').onclick = () => {
        const sel = document.querySelector('input[name="ct"]:checked')
        if (sel) changeType(sel.value)
        D('dlg-changetype').classList.add('hidden')
    }
    D('ct-cancel').onclick = () => D('dlg-changetype').classList.add('hidden')

    // 主进程事件：启动参数打开、对话框选择、保存完成
    // 注意：这些消息由主进程用各自频道下发，须用 preload 暴露的对应方法接收
    API.OnStartupOpenImage((p) => { if (p) openFile(p) })
    API.OnOpenImageFiles((arr) => {
        State.dialogOpening = false
        if (arr && arr.length) openFile(arr[0])
    })
    API.OnImageSaved((p) => { info('已保存: ' + p); afterSaved(p) })
    API.OnSysCall((msg) => {
        if (!msg || !msg.type) return
        switch (msg.type) {
            case 'fullscreen-state':
                isFullscreenNow = !!msg.data
                document.body.classList.toggle('fullscreen', isFullscreenNow)
                // 竞态修复：窗口 resize 事件可能先于本消息到达，render() 已按旧视口
                // （预留 26px 状态栏）布局；类切换改变视口尺寸后必须重排一次，
                // 否则全屏时底部留白、图片不铺满（退出全屏时图片底部被状态栏遮挡同理）。
                // 若窗口尺寸变化尚未生效，随后的 resize 事件也会触发 render，两次重绘幂等。
                requestAnimationFrame(() => {
                    resizeAnnot()
                    render()
                    // 截屏选择中：全屏切换后按最终视口重算选区画布，保证清晰度与坐标映射
                    if (screenCanvasData && !selMask.classList.contains('hidden')) resizeSel(screenCanvasData)
                })
                break
            case 'dialog-closed':
                // 主进程对话框已关闭（无论是否选择文件），解除互斥
                State.dialogOpening = false
                break
            case 'unsupported-file':
                // 打开对话框/启动参数里出现不受支持的文件类型
                info('不支持的图片格式: ' + (msg.data || ''))
                break
            case 'raw-cache-ready':
                // RAW 缓存后台生成完毕，若当前正显示则该刷新
                rawCacheRefresh(msg.data)
                break
        }
    })

    // 主进程错误
    API.OnError((msg) => info('后台错误: ' + msg))
    API.OnTrace((t) => { if (t && t.msg) info(t.msg) })
    // 后台解码等日志：收集到缓冲（不经状态栏），菜单弹窗查看
    API.OnAppLog((msg) => pushAppLog(msg))

    // 帮助对话框关闭
    const helpOk = document.getElementById('help-ok')
    if (helpOk) helpOk.onclick = () => document.getElementById('dlg-help').classList.add('hidden')

    // 关于 / 许可证 对话框关闭
    const aboutOk = document.getElementById('about-ok')
    if (aboutOk) aboutOk.onclick = () => document.getElementById('dlg-about').classList.add('hidden')
    const licenseOk = document.getElementById('license-ok')
    if (licenseOk) licenseOk.onclick = () => document.getElementById('dlg-license').classList.add('hidden')

    // 应用日志对话框
    const applogOk = document.getElementById('applog-ok')
    if (applogOk) applogOk.onclick = () => document.getElementById('dlg-applog').classList.add('hidden')
    const applogRefresh = document.getElementById('applog-refresh')
    if (applogRefresh) applogRefresh.onclick = () => {
        const el = document.getElementById('applog-text')
        if (el) el.textContent = appLogLines.length ? appLogLines.join('\n') : '（暂无应用日志）'
    }
    const applogClear = document.getElementById('applog-clear')
    if (applogClear) applogClear.onclick = () => {
        appLogLines.length = 0
        const el = document.getElementById('applog-text')
        if (el) el.textContent = ''
    }

    // 支持拖放图片到窗口直接打开
    document.addEventListener('dragover', (e) => { e.preventDefault() })
    document.addEventListener('drop', (e) => {
        e.preventDefault()
        const fl = e.dataTransfer && e.dataTransfer.files
        if (!fl || fl.length === 0) return
        const f = fl[0]
        const p = f.path || ''
        if (p) {
            // 拖入打开的图片同样让窗口贴合图片尺寸
            API.Invoke({ type: 'fit-window', path: p })
            openFile(p)
        } else {
            info('无法获取拖入文件的路径')
        }
    })

    // 视口尺寸变化
    window.addEventListener('resize', () => {
        // 截屏选择中：重算选区画布，保证鼠标坐标与截图像素的映射正确（进出全屏会改变窗口尺寸）
        if (screenCanvasData && !selMask.classList.contains('hidden')) resizeSel(screenCanvasData)
        resizeAnnot()
        render()
    })

    // ============ 工具栏自动显示 ============
    VIEWPORT.addEventListener('mousemove', (e) => {
        // 截屏选择中不显示工具栏，避免遮挡选区与误点
        if (!selMask.classList.contains('hidden')) { toolbar.classList.remove('show'); return }
        // 底部区域显示工具栏
        const h = VIEWPORT.clientHeight
        if (e.clientY > h - 70) toolbar.classList.add('show')
        else toolbar.classList.remove('show')
    })

    // ============ 初始化 ============
    function init() {
        resizeAnnot()
        showIndexPic()
        updateModeIndicator()
    }
    window.addEventListener('resize', resizeAnnot)
    init()

    let zoom_dummy = false
})()