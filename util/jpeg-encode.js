// 旋转保存用的基线 JPEG 编码器（浏览器 / Node 双用，UMD）
//
// 为什么需要它：
//   像素级 90° 旋转必须先把 JPEG 解码成像素，再重新编码。而 canvas.toDataURL('image/jpeg', q)
//   只能用 Chromium 内置量化表按 q 缩放，与原图的量化表无关，于是要么画质掉一档，要么体积涨数倍
//   （实测 1312x736 的原图 101KB，q=1.0 重编码后 436KB）。本模块在重编码时**沿用原图的量化表
//   (DQT) 与原图的霍夫曼表 (DHT)**，因此压缩强度、体积与原图同级，画质差异仅在解码/重编码
//   的 ±1 灰度级量级；同时把原图的 APPn 段（JFIF/EXIF/ICC 等）原样搬过去，只把 EXIF 的
//   Orientation 置回 1 —— 像素已经真的转过了，不能再让显示端转第二次。
//
// 输出始终是基线 JPEG（SOF0），像素数据真旋转、无需任何 EXIF 支持即可正确显示。
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory()
    else root.JpegEncode = factory()
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict'

    // zigzag 顺序 -> 自然顺序索引（自然顺序按 u + v*8 排列，u 为水平频率）
    const ZIGZAG = new Uint8Array([
        0, 1, 8, 16, 9, 2, 3, 10,
        17, 24, 32, 25, 18, 11, 4, 5,
        12, 19, 26, 33, 40, 48, 41, 34,
        27, 20, 13, 6, 7, 14, 21, 28,
        35, 42, 49, 56, 57, 50, 43, 36,
        29, 22, 15, 23, 30, 37, 44, 51,
        58, 59, 52, 45, 38, 31, 39, 46,
        53, 60, 61, 54, 47, 55, 62, 63,
    ])

    function readU16(b, o) { return (b[o] << 8) | b[o + 1] }

    // 由 DHT 的 BITS/HUFFVAL 建立范式霍夫曼码表
    function buildTable(counts, vals) {
        const code = new Int32Array(256).fill(-1)
        const len = new Int8Array(256)
        let c = 0, k = 0
        for (let l = 1; l <= 16; l++) {
            for (let i = 0; i < counts[l - 1]; i++) {
                const v = vals[k++]
                code[v] = c++
                len[v] = l
            }
            c <<= 1
        }
        return { counts, vals, code, len }
    }

    // ============ 源 JPEG 头部解析 ============
    // 只取重编码需要的东西：量化表、霍夫曼表、分量与采样、尺寸、APPn 段。
    // 不解析熵编码数据（像素由 canvas 解码提供），因此渐进式 JPEG 也能照常处理。
    function parseSource(bytes) {
        if (!bytes || bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return null
        const out = {
            width: 0, height: 0, comps: [], apps: [], hasJFIF: false, orientation: 0,
            qt: {}, dc: {}, ac: {}, adobeTransform: null,
        }
        let p = 2
        while (p + 4 <= bytes.length) {
            if (bytes[p] !== 0xFF) return null
            const m = bytes[p + 1]
            if (m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { p += 2; continue }
            if (m === 0xD9 || m === 0xDA) break
            const len = readU16(bytes, p + 2)
            if (len < 2) return null
            const s = p + 4, e = p + 2 + len
            if (e > bytes.length) return null

            if (m === 0xDB) {                       // DQT
                let q = s
                while (q < e) {
                    const pq = bytes[q] >> 4, tq = bytes[q] & 15
                    q++
                    if (pq !== 0) return null          // 16 位量化表（12 位精度）不支持
                    if (q + 64 > e) return null
                    const t = new Uint16Array(64)
                    for (let i = 0; i < 64; i++) { t[ZIGZAG[i]] = bytes[q + i] }
                    out.qt[tq] = t
                    q += 64
                }
            } else if (m === 0xC4) {                // DHT
                let q = s
                while (q < e) {
                    const tc = bytes[q] >> 4, th = bytes[q] & 15
                    q++
                    if (q + 16 > e) return null
                    const counts = bytes.slice(q, q + 16)
                    q += 16
                    let n = 0
                    for (let i = 0; i < 16; i++) n += counts[i]
                    if (q + n > e) return null
                    const vals = bytes.slice(q, q + n)
                    q += n
                    const tbl = buildTable(counts, vals)
                    if (tc === 0) out.dc[th] = tbl
                    else out.ac[th] = tbl
                }
            } else if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
                if (m === 0xC3 || m === 0xC7 || m === 0xCB || m === 0xCF) return null // 无损 JPEG
                if (bytes[s] !== 8) return null        // 只支持 8 位精度
                out.height = readU16(bytes, s + 1)
                out.width = readU16(bytes, s + 3)
                const nc = bytes[s + 5]
                if (!out.width || !out.height || !nc || nc > 4) return null
                let q = s + 6
                for (let i = 0; i < nc; i++) {
                    if (q + 3 > e) return null
                    out.comps.push({ id: bytes[q], h: bytes[q + 1] >> 4, v: bytes[q + 1] & 15, tq: bytes[q + 2] })
                    q += 3
                }
            } else if (m >= 0xE0 && m <= 0xEF) {    // APPn：原样保留
                const seg = bytes.slice(p, e)
                out.apps.push(seg)
                if (m === 0xE0) out.hasJFIF = true
                if (m === 0xE1 && out.orientation === 0) {
                    // EXIF 自动朝向（手机竖拍照片常见）：>1 表示浏览器显示时已按它摆正，
                    // 保存时要把这个"自动旋转"也落到像素上，所以这里把朝向读出来交给调用方判断
                    const o = findOrientation(seg)
                    if (o) out.orientation = (o.value >= 1 && o.value <= 8) ? o.value : 1
                }
                if (m === 0xEE && e - s >= 12 &&
                    bytes[s] === 0x41 && bytes[s + 1] === 0x64 && bytes[s + 2] === 0x6F && bytes[s + 3] === 0x62 &&
                    bytes[s + 4] === 0x65) {
                    out.adobeTransform = bytes[s + 11]      // 'A','d','o','b','e'
                }
            } else if (m === 0xFE) {                // COM：保留
                out.apps.push(bytes.slice(p, e))
            }
            p = e
        }
        if (!out.comps.length || !out.width || !out.height) return null
        for (const c of out.comps) {
            if (!c.h || !c.v) return null
            if (out.qt[c.tq] === undefined) return null
        }
        if (!out.dc[0] || !out.ac[0]) return null     // 没有可用霍夫曼表则放弃
        if (!out.orientation) out.orientation = 1     // 无 EXIF 或无朝向标记 -> 正常朝向
        return out
    }

    // 在 APP1 段里定位 EXIF 的 Orientation 标记（tag 0x0112）。
    // 返回 null 表示该段不是 Exif 段；返回 at < 0 表示是 Exif 但没有朝向标记（等价于 1）。
    function findOrientation(seg) {
        if (!seg || seg.length < 16) return null
        if (seg[0] !== 0xFF || seg[1] !== 0xE1) return null
        if (String.fromCharCode(seg[4], seg[5], seg[6], seg[7], seg[8], seg[9]) !== 'Exif\0\0') return null
        const tiff = 10
        const order = readU16(seg, tiff)
        const le = order === 0x4949
        if (!le && order !== 0x4D4D) return { value: 1, le: true, at: -1 }
        const g16 = (o) => (le ? seg[o] | (seg[o + 1] << 8) : (seg[o] << 8) | seg[o + 1])
        const g32 = (o) => (le
            ? (seg[o] | (seg[o + 1] << 8) | (seg[o + 2] << 16) | (seg[o + 3] << 24)) >>> 0
            : ((seg[o] << 24) | (seg[o + 1] << 16) | (seg[o + 2] << 8) | seg[o + 3]) >>> 0)
        if (g16(tiff + 2) !== 42) return { value: 1, le, at: -1 }
        const ifd = tiff + g32(tiff + 4)
        if (ifd + 2 > seg.length) return { value: 1, le, at: -1 }
        const count = g16(ifd)
        for (let i = 0; i < count; i++) {
            const p = ifd + 2 + i * 12
            if (p + 12 > seg.length) break
            if (g16(p) === 0x0112 && g16(p + 2) === 3 && g32(p + 4) === 1) {
                return { value: g16(p + 8), le, at: p + 8 }
            }
        }
        return { value: 1, le, at: -1 }
    }

    // 像素已经真的转过了，必须把 EXIF 朝向标记清零，否则显示端会再转一次
    function forceOrientationNormal(seg) {
        const e = findOrientation(seg)
        if (!e || e.at < 0 || e.value === 1) return seg
        const out = new Uint8Array(seg)
        if (e.le) { out[e.at] = 1; out[e.at + 1] = 0 }
        else { out[e.at] = 0; out[e.at + 1] = 1 }
        return out
    }

    // ============ 像素重排（整数下标映射，90° 倍数无插值） ============
    function rotateRGBA(src, w, h, steps) {
        const s = ((steps % 4) + 4) % 4
        if (s === 0) return { data: src, w, h }
        const ow = (s % 2) ? h : w
        const oh = (s % 2) ? w : h
        const out = new Uint8Array(ow * oh * 4)
        if (s === 1) {                      // 顺时针 90°：(x,y) -> (h-1-y, x)
            for (let y = 0; y < h; y++) {
                const row = y * w * 4
                const xd = h - 1 - y
                for (let x = 0; x < w; x++) {
                    const si = row + x * 4
                    const di = (x * ow + xd) * 4
                    out[di] = src[si]; out[di + 1] = src[si + 1]; out[di + 2] = src[si + 2]; out[di + 3] = src[si + 3]
                }
            }
        } else if (s === 2) {               // 180°
            const n = w * h
            for (let i = 0; i < n; i++) {
                const si = i * 4, di = (n - 1 - i) * 4
                out[di] = src[si]; out[di + 1] = src[si + 1]; out[di + 2] = src[si + 2]; out[di + 3] = src[si + 3]
            }
        } else {                            // 顺时针 270°（逆时针 90°）：(x,y) -> (y, w-1-x)
            for (let y = 0; y < h; y++) {
                const row = y * w * 4
                for (let x = 0; x < w; x++) {
                    const si = row + x * 4
                    const di = ((w - 1 - x) * ow + y) * 4
                    out[di] = src[si]; out[di + 1] = src[si + 1]; out[di + 2] = src[si + 2]; out[di + 3] = src[si + 3]
                }
            }
        }
        return { data: out, w: ow, h: oh }
    }

    // ============ 分量取值与平面构建 ============
    // mode: 'gray' | 'rgb' | 'ycbcr'；mode 由分量 id 与 Adobe 标记推断
    function pickMode(src) {
        const n = src.comps.length
        if (n === 1) return 'gray'
        if (n !== 3) return null                       // CMYK 等少见情形交给调用方兜底
        const ids = src.comps.map((c) => c.id)
        if (ids[0] === 0x52 && ids[1] === 0x47 && ids[2] === 0x42) return 'rgb'   // 'R','G','B'
        if (src.adobeTransform === 0) return 'rgb'
        return 'ycbcr'
    }

    // 按分量采样因子把（已旋转的）图像降采样为分量平面，越界按边界复制
    function buildPlane(rgba, W, H, sx, sy, mode, idx) {
        const pw = Math.ceil(W / sx), ph = Math.ceil(H / sy)
        const plane = new Uint8Array(pw * ph)
        const rgbMode = mode === 'rgb'
        const gray = mode === 'gray'
        let o = 0
        for (let py = 0; py < ph; py++) {
            const y0 = py * sy
            for (let px = 0; px < pw; px++) {
                const x0 = px * sx
                let sum = 0
                for (let dy = 0; dy < sy; dy++) {
                    let yy = y0 + dy
                    if (yy > H - 1) yy = H - 1          // 边界复制延拓
                    const row = yy * W * 4
                    for (let dx = 0; dx < sx; dx++) {
                        let xx = x0 + dx
                        if (xx > W - 1) xx = W - 1
                        const i = row + xx * 4
                        const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2]
                        let v
                        if (rgbMode) v = idx === 0 ? r : idx === 1 ? g : b
                        else if (idx === 0 || gray) v = 0.299 * r + 0.587 * g + 0.114 * b
                        else if (idx === 1) v = -0.168736 * r - 0.331264 * g + 0.5 * b + 128
                        else v = 0.5 * r - 0.418688 * g - 0.081312 * b + 128
                        sum += v
                    }
                }
                let v = Math.round(sum / (sx * sy))
                if (v < 0) v = 0
                if (v > 255) v = 255
                plane[o++] = v
            }
        }
        return { data: plane, w: pw, h: ph }
    }

    // ============ DCT（二维可分离，浮点） ============
    const DCT_M = (function () {
        const m = new Float64Array(64)
        for (let u = 0; u < 8; u++) {
            const a = u === 0 ? Math.sqrt(1 / 8) : Math.sqrt(2 / 8)
            for (let x = 0; x < 8; x++) m[u * 8 + x] = a * Math.cos((2 * x + 1) * u * Math.PI / 16)
        }
        return m
    })()
    const DCT_TMP = new Float64Array(64)

    function fdct(block, out) {
        for (let u = 0; u < 8; u++) {
            for (let y = 0; y < 8; y++) {
                const base = u * 8
                let s = 0
                for (let x = 0; x < 8; x++) s += DCT_M[base + x] * block[x + y * 8]
                DCT_TMP[u + y * 8] = s
            }
        }
        for (let u = 0; u < 8; u++) {
            for (let v = 0; v < 8; v++) {
                let s = 0
                for (let y = 0; y < 8; y++) s += DCT_M[v * 8 + y] * DCT_TMP[u + y * 8]
                out[u + v * 8] = s
            }
        }
    }

    // ============ 输出缓冲与熵编码 ============
    function ByteBuf(cap) {
        this.b = new Uint8Array(cap || 1 << 16)
        this.n = 0
    }
    ByteBuf.prototype.byte = function (v) {
        if (this.n >= this.b.length) {
            const nb = new Uint8Array(this.b.length * 2)
            nb.set(this.b)
            this.b = nb
        }
        this.b[this.n++] = v
    }
    ByteBuf.prototype.u16 = function (v) { this.byte((v >> 8) & 0xFF); this.byte(v & 0xFF) }
    ByteBuf.prototype.arr = function (a) { for (let i = 0; i < a.length; i++) this.byte(a[i]) }
    ByteBuf.prototype.out = function () { return this.b.slice(0, this.n) }

    function Entropy(bb) { this.bb = bb; this.acc = 0; this.n = 0 }
    Entropy.prototype.put = function (code, len) {
        this.acc = (this.acc << len) | code
        this.n += len
        while (this.n >= 8) {
            this.n -= 8
            const b = (this.acc >>> this.n) & 0xFF
            this.bb.byte(b)
            if (b === 0xFF) this.bb.byte(0x00)      // 字节填充
        }
        this.acc &= (1 << this.n) - 1               // 只保留待输出的低位，避免高位累积
    }
    Entropy.prototype.flush = function () {
        if (this.n > 0) {
            const pad = 8 - this.n
            this.put((1 << pad) - 1, pad)           // 末尾补 1
            this.n = 0
        }
    }

    function magSize(v) { let s = 0, a = v < 0 ? -v : v; while (a) { s++; a >>= 1 } return s }

    // ============ 主入口：像素 -> 旋转 -> 用原图量化表/霍夫曼表重编码 ============
    // rgba: RGBA 像素（Uint8ClampedArray/Uint8Array，来自 canvas getImageData）
    // steps: 顺时针 90° 的倍数
    // src: parseSource 的返回值
    // 返回 Uint8Array（JPEG 文件内容）；无法处理时返回 null（调用方走兜底方案）
    function encodeRotated(rgba, w, h, steps, src) {
        const mode = pickMode(src)
        if (!mode) return null
        const k = ((steps % 4) + 4) % 4
        const rot = rotateRGBA(rgba, w, h, k)
        const W = rot.w, H = rot.h

        // 采样因子：旋转奇数步时 H/V 互换，保持色度分辨率与原图对应
        const comps = src.comps.map((c) => ({ id: c.id, h: c.h, v: c.v, tq: c.tq }))
        if (k % 2 === 1) {
            for (const c of comps) { const t = c.h; c.h = c.v; c.v = t }
        }
        let Hmax = 1, Vmax = 1
        for (const c of comps) { if (c.h > Hmax) Hmax = c.h; if (c.v > Vmax) Vmax = c.v }
        for (const c of comps) {
            if (Hmax % c.h !== 0 || Vmax % c.v !== 0) return null
        }

        const planes = comps.map((c, i) => buildPlane(rot.data, W, H, Hmax / c.h, Vmax / c.v, mode, i))

        // 霍夫曼表：0 号给第一个分量（亮度），1 号给其余（色度）；缺 1 号表则都用 0 号。
        // 必须与 SOS 里声明的 Td/Ta 完全一致，否则解码端用错表会导致比特流错位（整幅图花掉）。
        const useChromaTbl = comps.length > 1 && src.dc[1] && src.ac[1]
        const dcIdx = comps.map((c, i) => (i === 0 || !useChromaTbl ? 0 : 1))
        const acIdx = comps.map((c, i) => (i === 0 || !useChromaTbl ? 0 : 1))
        const dcT = dcIdx.map((t) => src.dc[t])
        const acT = acIdx.map((t) => src.ac[t])

        const bb = new ByteBuf(Math.max(1 << 16, Math.round(W * H * 0.6)))
        bb.u16(0xFFD8)                                  // SOI

        for (const seg of src.apps) {                   // APPn/COM 原样搬，EXIF 朝向清零
            if (seg[1] === 0xE1) bb.arr(forceOrientationNormal(seg))
            else bb.arr(seg)
        }

        // DQT：沿用原图量化表（8 位）
        for (const key of Object.keys(src.qt)) {
            const t = src.qt[key]
            bb.u16(0xFFDB); bb.u16(67); bb.byte(Number(key))
            for (let i = 0; i < 64; i++) bb.byte(t[ZIGZAG[i]])
        }

        // SOF0
        bb.u16(0xFFC0); bb.u16(8 + 3 * comps.length); bb.byte(8)
        bb.u16(H); bb.u16(W); bb.byte(comps.length)
        for (const c of comps) { bb.byte(c.id); bb.byte((c.h << 4) | c.v); bb.byte(c.tq) }

        // DHT：沿用原图霍夫曼表
        const emitHuff = (cls, th, tbl) => {
            bb.u16(0xFFC4); bb.u16(2 + 1 + 16 + tbl.vals.length)
            bb.byte((cls << 4) | th)
            bb.arr(tbl.counts)
            bb.arr(tbl.vals)
        }
        for (const key of Object.keys(src.dc)) emitHuff(0, Number(key), src.dc[key])
        for (const key of Object.keys(src.ac)) emitHuff(1, Number(key), src.ac[key])

        // SOS
        bb.u16(0xFFDA); bb.u16(6 + 2 * comps.length); bb.byte(comps.length)
        for (let i = 0; i < comps.length; i++) {
            bb.byte(comps[i].id)
            bb.byte((dcIdx[i] << 4) | acIdx[i])       // 与实际使用的表一致
        }
        bb.byte(0); bb.byte(63); bb.byte(0)

        // 熵编码数据
        const ent = new Entropy(bb)
        const pred = new Int32Array(comps.length)
        const mcuW = Hmax * 8, mcuH = Vmax * 8
        const mcuCols = Math.ceil(W / mcuW), mcuRows = Math.ceil(H / mcuH)
        const blk = new Float64Array(64), coef = new Float64Array(64)
        const quant = new Int32Array(64)

        try {
            for (let mj = 0; mj < mcuRows; mj++) {
                for (let mi = 0; mi < mcuCols; mi++) {
                    for (let ci = 0; ci < comps.length; ci++) {
                        const c = comps[ci]
                        const pl = planes[ci]
                        const qt = src.qt[c.tq]
                        const dc = dcT[ci], ac = acT[ci]
                        for (let by = 0; by < c.v; by++) {
                            for (let bx = 0; bx < c.h; bx++) {
                                const gx = (mi * c.h + bx) * 8
                                const gy = (mj * c.v + by) * 8
                                // 取 8x8 块，越界按边界复制
                                for (let y = 0; y < 8; y++) {
                                    let yy = gy + y
                                    if (yy >= pl.h) yy = pl.h - 1
                                    const row = yy * pl.w
                                    for (let x = 0; x < 8; x++) {
                                        let xx = gx + x
                                        if (xx >= pl.w) xx = pl.w - 1
                                        blk[x + y * 8] = pl.data[row + xx] - 128
                                    }
                                }
                                fdct(blk, coef)
                                for (let i = 0; i < 64; i++) {
                                    const q = qt[i]
                                    quant[i] = Math.round(coef[i] / q)
                                }
                                // DC
                                const d = quant[0]
                                const diff = d - pred[ci]
                                pred[ci] = d
                                const ds = magSize(diff)
                                if (ds > 11 || dc.code[ds] < 0) return null
                                ent.put(dc.code[ds], dc.len[ds])
                                if (ds) ent.put(diff >= 0 ? diff : diff + (1 << ds) - 1, ds)
                                // AC
                                let run = 0
                                for (let k = 1; k < 64; k++) {
                                    const v = quant[ZIGZAG[k]]
                                    if (v === 0) { run++; continue }
                                    while (run > 15) {
                                        if (ac.code[0xF0] < 0) return null
                                        ent.put(ac.code[0xF0], ac.len[0xF0])
                                        run -= 16
                                    }
                                    const s = magSize(v)
                                    const sym = (run << 4) | s
                                    if (ac.code[sym] < 0) return null
                                    ent.put(ac.code[sym], ac.len[sym])
                                    ent.put(v >= 0 ? v : v + (1 << s) - 1, s)
                                    run = 0
                                }
                                if (run > 0) {
                                    if (ac.code[0x00] < 0) return null
                                    ent.put(ac.code[0x00], ac.len[0x00])
                                }
                            }
                        }
                    }
                }
            }
            ent.flush()
        } catch (e) {
            return null
        }

        bb.u16(0xFFD9)                                  // EOI
        return bb.out()
    }

    return { parseSource, encodeRotated, rotateRGBA, buildPlane, pickMode, fdct, ZIGZAG }
})
