// 轻量 EXIF 解析：从 JPEG 中读取拍摄参数（光圈/快门/ISO/焦距/尺寸/朝向等）
// 仅解析常用字段，避免引入外部依赖，保证启动速度。

const fs = require('fs')

const { loadRawAddon } = require('./raw-addon')

const TAG_NAMES = {
    // IFD0
    0x010F: 'Make',
    0x0110: 'Model',
    0x0112: 'Orientation',
    0x011A: 'XResolution',
    0x011B: 'YResolution',
    0x0131: 'Software',
    0x0132: 'DateTime',
    0x8769: 'ExifIFD',
    // ExifIFD
    0x829A: 'ExposureTime',
    0x829D: 'FNumber',
    0x8822: 'ExposureProgram',
    0x8827: 'ISOSpeedRatings',
    0x9003: 'DateTimeOriginal',
    0x9004: 'DateTimeDigitized',
    0x920A: 'FocalLength',
    0xA002: 'PixelXDimension',
    0xA003: 'PixelYDimension',
    0xA405: 'FocalLengthIn35mmFilm',
}

function parseRational(buf, o) {
    const num = buf.readInt32LE(o)
    const den = buf.readInt32LE(o + 4)
    return den ? num / den : 0
}

function parseTagList(buf, o, ifdOffset, out) {
    const count = buf.readUInt16LE(o)
    let p = o + 2
    for (let i = 0; i < count; i++) {
        const tag = buf.readUInt16LE(p)
        const type = buf.readUInt16LE(p + 2)
        const n = buf.readUInt32LE(p + 4)
        const name = TAG_NAMES[tag]
        if (name) {
            try {
                const val = readTagValue(buf, type, n, p + 8, ifdOffset, out)
                out[name] = val
            } catch (e) { /* 忽略无法解析的字段 */ }
        }
        p += 12
    }
}

function readTagValue(buf, type, n, dataPtr, ifdOffset, out) {
    const dataPos = n * sizeOfType(type) > 4 ? ifdOffset + buf.readUInt32LE(dataPtr) : dataPtr
    switch (type) {
        case 3: return buf.readUInt16LE(dataPos) // SHORT
        case 4: return buf.readUInt32LE(dataPos) // LONG
        case 5: return parseRational(buf, dataPos) // RATIONAL
        case 7: { // UNDEFINED
            const bytes = []
            for (let k = 0; k < Math.min(n, 8); k++) bytes.push(buf.readUInt8(dataPtr + k))
            return bytes
        }
        case 2: { // ASCII
            const bytes = []
            for (let k = 0; k < n; k++) {
                const b = buf.readUInt8(dataPtr + k)
                if (b === 0) break
                bytes.push(b)
            }
            return Buffer.from(bytes).toString('ascii').trim()
        }
        default: return undefined
    }
}

function sizeOfType(type) {
    switch (type) {
        case 1: case 2: case 6: case 7: return 1
        case 3: case 8: return 2
        case 4: case 9: case 11: return 4
        case 5: case 10: case 12: return 8
        default: return 1
    }
}

// 从 JPEG 缓冲中定位并解析 EXIF（APP1）
function parseJpegExif(buf) {
    // 查找 APP1 标记: FF E1
    let offset = 2
    while (offset + 8 < buf.length) {
        if (buf.readUInt8(offset) !== 0xFF) break
        const marker = buf.readUInt8(offset + 1)
        const segLen = buf.readUInt16BE(offset + 2)
        if (marker === 0xE1) {
            // 检查 Exif 头: "Exif\0\0"
            if (buf.readUInt32BE(offset + 4) === 0x45786966 && buf.readUInt16BE(offset + 8) === 0) {
                const tiffBase = offset + 10
                const out = {}
                parseTIFF(buf, tiffBase, out)
                return out
            }
        }
        if (marker === 0xDA) break // SOS 结束
        offset += 2 + segLen
    }
    return {}
}

function parseTIFF(buf, tiffBase, out) {
    // TIFF 头: II*\0 或 MM\0*，偏移4处是首个IFD偏移（相对tiffBase）
    const endian = buf.readUInt16LE(tiffBase) // 0x4949 'II' 或 0x4d4d 'MM'
    const little = endian === 0x4949
    const rd16 = (o) => little ? buf.readUInt16LE(o) : buf.readUInt16BE(o)
    const rd32 = (o) => little ? buf.readUInt32LE(o) : buf.readUInt32BE(o)
    const rdRat = (o) => {
        const num = little ? buf.readInt32LE(o) : buf.readInt32BE(o)
        const den = little ? buf.readInt32LE(o + 4) : buf.readInt32BE(o + 4)
        return den ? num / den : 0
    }

    const firstIFD = rd32(tiffBase + 4)
    if (!firstIFD) return out

    const readIFD = (ifdOffset) => {
        const cnt = rd16(tiffBase + ifdOffset)
        let p = tiffBase + ifdOffset + 2
        const values = {}
        for (let i = 0; i < cnt; i++) {
            const tag = rd16(p)
            const type = rd16(p + 2)
            const n = rd32(p + 4)
            const size = n * sizeOfType(type)
            let dataPos
            if (size <= 4) dataPos = p + 8
            else dataPos = tiffBase + rd32(p + 8)
            const name = TAG_NAMES[tag]
            if (name) {
                try {
                    switch (tag) {
                        case 0x010F: case 0x0110: case 0x0131: case 0x0132:
                        case 0x9003: case 0x9004: {
                            const bytes = []
                            for (let k = 0; k < n; k++) {
                                const b = buf.readUInt8(dataPos + k)
                                if (b === 0) break
                                bytes.push(b)
                            }
                            values[name] = Buffer.from(bytes).toString('ascii').trim()
                            break
                        }
                        case 0x829A: case 0x829D: case 0x920A: case 0x011A: case 0x011B: {
                            values[name] = rdRat(dataPos)
                            break
                        }
                        case 0x0112: case 0x8827: case 0xA002: case 0xA003: case 0xA405: {
                            values[name] = type === 3 ? rd16(dataPos) : rd32(dataPos)
                            break
                        }
                        case 0x8769: {
                            values.ExifIFD = rd32(dataPos)
                            break
                        }
                        default: break
                    }
                } catch (e) { /* 忽略 */ }
            }
            p += 12
        }
        return values
    }

    const ifd0 = readIFD(firstIFD)
    Object.assign(out, ifd0)
    // 读取 ExifIFD（子 IFD）
    if (out.ExifIFD) {
        const exif = readIFD(out.ExifIFD)
        Object.assign(out, exif)
        delete out.ExifIFD
    }
    return out
}

// 依据 EXIF Orientation 计算“把图片摆正需要顺时针旋转的角度”（0/90/180/270）。
// 注意：JPG 的摆正现在由浏览器按 EXIF 直接完成（styles.css 的 #img-single 用默认的
// image-orientation: from-image，详见 util/raw-rotate.js 顶部方案），渲染端不再据此做 transform，
// 因此该值仅用于信息展示/排查；带镜像的 2/4/5/7 由浏览器正确处理，这里仍按 0 返回。
function orientationAngle(or) {
    switch (Number(or)) {
        case 3: return 180
        case 6: return 90
        case 8: return 270
        default: return 0
    }
}

// 拍摄角度（度）：状态栏 A: 字段的取值，口径为 exif.GetAngle() * 90，
// 含义是“图片拍摄时的角度”（即图片当前的角度）。
//
// 【重要】它刻意与“需要顺时针旋转多少度才能摆正”互为反向，属设计如此，不是 bug，
// 请勿“顺手改成” orientationAngle() 的返回值。对照表：
//     EXIF 朝向 1（正常） → 拍摄角度 0°   （需旋转 0°）
//     EXIF 朝向 6         → 拍摄角度 270° （需旋转 90°）
//     EXIF 朝向 8         → 拍摄角度 90°  （需旋转 270°）
//     EXIF 朝向 3         → 拍摄角度 180° （需旋转 180°）
// 依据原程序 exif.h 的注释：“Orientation 值表示的是图片需要旋转的角度……本函数返回图片当前的角度，
// 因此需要调转 6、8 的值”，故这里同样对 6、8 取反向值，以保持与原程序显示一致。
// 另注：真正用于摆正图片的旋转角度由 orientationAngle() 提供（见 util/raw-rotate.js 顶部旋转方案），
// 两者用途不同，不要混用。
function shotAngle(orientation) {
    const need = orientationAngle(orientation)   // 需要顺时针旋转的角度（3→180、6→90、8→270）
    return need ? (360 - need) % 360 : 0
}

// 从 EXIF 组装拍摄参数文本，字段口径对齐原程序 GetExifInfo，仅调整顺序与分隔：
//   F:<光圈> T:<快门> ISO:<感光度> A:<拍摄角度>° | 焦距 <焦距>mm | <拍摄时间> | <相机厂商 型号>
// 说明：
//   - 快门沿用原程序 1/N 的写法（短于 1 秒时取整），长曝则直接给秒数；
//   - A 是“拍摄角度”（原始朝向口径，见 shotAngle 的说明），注意它不等于“需旋转的角度”；
//     首组无其它字段、且角度为 0 时不单独显示 A，避免纯相机信息时出现无意义的 A:0°；
//   - 相机置于末尾；Model 已含品牌前缀时不再重复 Make（避免 "Canon Canon"）；
//   - 不再显示像素尺寸。
function buildExifText(e) {
    if (!e || !e.ExposureTime && !e.FNumber && !e.ISOSpeedRatings && !e.FocalLength && !e.Make && !e.Model) {
        return ''
    }
    const groups = []
    // 第一组：光圈 / 快门 / 感光度 / 拍摄角度
    const main = []
    if (e.FNumber) main.push('F:' + parseFloat(e.FNumber.toFixed(1)))
    if (e.ExposureTime) {
        const t = e.ExposureTime
        main.push('T:' + (t >= 1 ? parseFloat(t.toFixed(2)) + 's' : '1/' + Math.round(1 / t)))
    }
    if (e.ISOSpeedRatings) main.push('ISO:' + e.ISOSpeedRatings)
    const angle = shotAngle(e.Orientation)
    if (main.length > 0 || angle !== 0) main.push('A:' + angle + '°')
    if (main.length > 0) groups.push(main.join(' '))
    // 第二组：焦距
    if (e.FocalLength) groups.push('焦距 ' + parseFloat(e.FocalLength.toFixed(0)) + 'mm')
    // 第三组：拍摄日期（2023:06:15 14:30:25 → 转成可读格式）
    const dt = e.DateTimeOriginal || e.DateTime
    if (dt) groups.push(fmtDateTime(dt))
    // 第四组：相机厂商与型号（置于末尾）
    if (e.Make || e.Model) {
        const mk = e.Make || ''
        const md = e.Model || ''
        // Model 常见已含品牌前缀（如 Canon 的 "Canon EOS 5D Mark IV"），避免 "Canon Canon"
        groups.push(mk && md && md.toLowerCase().startsWith(mk.toLowerCase()) ? md : [mk, md].filter(Boolean).join(' '))
    }
    return groups.join(' | ')
}

// EXIF 原始日期形如 "2023:06:15 14:30:25"，转成 "2023-06-15 14:30"
function fmtDateTime(dt) {
    const m = String(dt).match(/(\d{4}):(\d{2}):(\d{2})[ ]+(\d{2}):(\d{2})(?::\d{2})?/)
    if (!m) return String(dt).trim()
    return m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5]
}

// 与 main.js 的 RAW_EXT 保持一致，可被 libraw 解码
const RAW_EXT = ['crw', 'cr2', 'nef', 'orf', 'raf', 'rw2', 'arw', 'dng']

// 主入口：读取文件 EXIF，返回 { ok, text, orientation, angle, baked? }
// 其中 text 为拍摄参数文本；orientation 为 EXIF 朝向值、angle 为“摆正所需顺时针旋转的角度”。
// 注意：angle 现在仅供展示/排查——JPG 的摆正由浏览器按 EXIF 完成（styles.css 的 #img-single 用
// 默认的 image-orientation: from-image），RAW 的摆正在写缓存时已完成，渲染端都不再据此旋转。
// 另注意：text 里的 A（拍摄角度，见 shotAngle）与 angle（需旋转角度）口径相反，用途不同，勿混用。
// baked 表示“像素已按朝向摆正”（RAW 缓存，详见 util/raw-rotate.js 顶部方案）。
// JPG 用手写解析；RAW 用自研 LibRaw 插件读元数据（避免解像素，轻量）
async function ReadExifInfo(fp) {
    try {
        const ext = pathExt(fp)
        if (ext === 'jpg' || ext === 'jpeg') {
            const buf = fs.readFileSync(fp)
            const e = parseJpegExif(buf)
            return {
                ok: true,
                text: buildExifText(e),
                orientation: Number(e.Orientation) || 1,
                angle: orientationAngle(e.Orientation),
            }
        }
        const obj = {}
        if (RAW_EXT.includes(ext)) Object.assign(obj, await readRawExif(fp))
        // RAW 的朝向在“生成缓存像素”阶段就已处理（详见 util/raw-rotate.js 顶部方案）：
        // libraw 解码会按 EXIF 朝向直接输出摆正后的像素；libraw 失败时的内嵌预览兜底，
        // 也会先读下方 rawExifOrientation() 得到的朝向、把像素转正后再写缓存。
        // 因此这里返回真实朝向仅供展示/排查，并以 baked=true 告知渲染端不要再转，避免双重旋转。
        const orientation = rawExifOrientation(fp)
        obj.Orientation = orientation   // 供 buildExifText 输出拍摄角度 A
        return {
            ok: true,
            text: buildExifText(obj),
            orientation,
            angle: orientationAngle(orientation),
            baked: true,
        }
    } catch (e) {
        return { ok: false, text: '', orientation: 1, angle: 0, err: e.message }
    }
}

// 用自研 LibRaw 插件（native/）读取 RAW 拍摄参数，映射为 buildExifText 需要的公共字段
async function readRawExif(fp) {
    try {
        // 按需动态加载 native 依赖，避免拖慢程序启动
        const { addon } = loadRawAddon()
        if (!addon) return {}
        let meta = {}
        try { meta = addon.metadata(fp) || {} } catch (e) { meta = {} }
        // 元数据为空时解一次包补齐 EXIF（属兜底，较少触发）
        if (!meta.make && !meta.model && !meta.aperture && !meta.focalLength && !meta.isoSpeed && !meta.shutter) {
            try { meta = addon.metadata(fp, { unpack: true }) || {} } catch (e) { meta = {} }
        }
        return {
            Make: meta.make,
            Model: meta.model,
            FNumber: meta.aperture,
            ExposureTime: meta.shutter,
            ISOSpeedRatings: meta.isoSpeed,
            FocalLength: meta.focalLength,
            DateTime: tsToExifStr(meta.timestamp),
        }
    } catch (e) {
        return {}
    }
}

// Unix 秒时间戳 → "2023:06:15 14:30:25"（与 JPEG EXIF 日期同格式，交由 fmtDateTime 转换）
function tsToExifStr(ts) {
    if (!ts || typeof ts !== 'number' || !isFinite(ts)) return ''
    const d = new Date(ts * 1000)
    const p = n => String(n).padStart(2, '0')
    return d.getFullYear() + ':' + p(d.getMonth() + 1) + ':' + p(d.getDate()) +
        ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
}

// 解析 RAW 文件自身的 EXIF 朝向（CR2/NEF/ARW/RW2/DNG/ORF 均为 TIFF 结构，
// 朝向位于 IFD0 的 0x0112）。只读文件头部，不解像素，开销极小。
// 用途有二（详见 util/raw-rotate.js 顶部方案）：
//   1) main.js 的内嵌预览兜底据此把未摆正的像素转正后再写缓存；
//   2) ReadExifInfo 据此返回真实朝向信息（但标记 baked=true，渲染端不再旋转）。
function rawExifOrientation(fp) {
    try {
        const fd = fs.openSync(fp, 'r')
        let buf
        try {
            const size = fs.fstatSync(fd).size
            const cap = Math.min(size, 256 * 1024)
            buf = Buffer.alloc(cap)
            fs.readSync(fd, buf, 0, cap, 0)
        } finally {
            fs.closeSync(fd)
        }
        const mark = buf.slice(0, 2).toString('latin1')
        const le = mark === 'II'
        if (!le && mark !== 'MM') return 1
        const rd16 = o => le ? buf.readUInt16LE(o) : buf.readUInt16BE(o)
        const rd32 = o => le ? buf.readUInt32LE(o) : buf.readUInt32BE(o)
        if (rd16(2) !== 42) return 1
        const ifd0 = rd32(4)
        if (ifd0 <= 0 || ifd0 + 2 > buf.length) return 1
        const n = rd16(ifd0)
        if (n <= 0 || n > 512) return 1
        for (let k = 0; k < n; k++) {
            const e = ifd0 + 2 + k * 12
            if (e + 12 > buf.length) break
            if (rd16(e) === 0x0112 && rd16(e + 2) === 3 && rd32(e + 4) === 1) {
                const v = rd16(e + 8)
                return (v >= 1 && v <= 8) ? v : 1
            }
        }
        return 1
    } catch (e) {
        return 1
    }
}

function pathExt(fp) {
    const i = String(fp).lastIndexOf('.')
    return i === -1 ? '' : String(fp).slice(i + 1).toLowerCase()
}

// ============ EXIF 写入（供 RAW → JPG 格式转换保留拍摄参数） ============
// RAW 不是 JPEG，转换时走 canvas 普通编码，会丢掉 EXIF。这里用自研 LibRaw 插件读出
// 程序展示的常见拍摄参数，重新生成一个标准的 EXIF APP1 段（FFE1），由渲染端嵌回 JPG。
// 只保留常用字段；朝向固定为 1 —— RAW 全尺寸缓存像素已按朝向摆正，不能写回原朝向。

function asciiNull(s) {
    if (s == null || s === '') return null
    const str = String(s)
    const out = Buffer.alloc(str.length + 1)
    Buffer.from(str, 'ascii').copy(out)   // 末尾补一个 0 结束符
    return out
}

// 数值 → EXIF RATIONAL [分子, 分母]，整数直接 1，小数用递增分母逼近到足够精度
function toRational(v) {
    const n = Number(v)
    if (!isFinite(n) || n <= 0) return null
    if (Math.floor(n) === n) return [n, 1]
    let best = null, bestErr = Infinity
    for (let d = 1; d <= 100000; d++) {
        const num = Math.round(n * d)
        const err = Math.abs(num / d - n)
        if (err < bestErr) { bestErr = err; best = [num, d] }
        if (err < n * 0.00001) break
    }
    return best
}

// 生成 TIFF（II 小端）形式的 EXIF：IFD0 + ExifIFD 两段，数据区跟随。返回 Buffer。
function buildExifTiff(f) {
    const mk = asciiNull(f.Make), md = asciiNull(f.Model)
    const dt = asciiNull(f.DateTime), dto = asciiNull(f.DateTimeOriginal)
    const sw = asciiNull('PicSee')
    const expo = toRational(f.ExposureTime), fno = toRational(f.FNumber), fl = toRational(f.FocalLength)
    let iso = Array.isArray(f.ISOSpeedRatings) ? Number(f.ISOSpeedRatings[0]) : Number(f.ISOSpeedRatings)
    if (!isFinite(iso)) iso = 0

    const ifd0 = []
    ifd0.push([0x0112, 3, 1, 'ori'])                                   // Orientation
    if (mk) ifd0.push([0x010F, 2, mk.length, 'mk'])
    if (md) ifd0.push([0x0110, 2, md.length, 'md'])
    if (dt) ifd0.push([0x0132, 2, dt.length, 'dt'])
    ifd0.push([0x0131, 2, sw.length, 'sw'])                            // Software
    ifd0.push([0x8769, 4, 1, 'exifIfd'])                               // ExifIFD 指针
    const exifIfd = []
    if (dto) exifIfd.push([0x9003, 2, dto.length, 'dto'])
    if (expo) exifIfd.push([0x829A, 5, 1, 'expo'])
    if (fno) exifIfd.push([0x829D, 5, 1, 'fno'])
    if (iso > 0) exifIfd.push([0x8827, 3, 1, 'iso'])
    if (fl) exifIfd.push([0x920A, 5, 1, 'fl'])
    const n0 = ifd0.length, n1 = exifIfd.length

    const ifd0Off = 8
    const exifIfdOff = ifd0Off + 2 + n0 * 12 + 4
    let d = exifIfdOff + 2 + n1 * 12 + 4                            // 数据区起点
    const ratOff = {}
    for (const k of ['expo', 'fno', 'fl']) {
        const v = k === 'expo' ? expo : k === 'fno' ? fno : fl
        if (!v) continue
        if (d % 4) d += 4 - d % 4
        ratOff[k] = d
        d += 8
    }
    const strOff = {}
    for (const [name, buf] of [['mk', mk], ['md', md], ['dt', dt], ['sw', sw], ['dto', dto]]) {
        if (buf) { strOff[name] = d; d += buf.length }
    }

    const raw = Buffer.alloc(d)
    const w16 = (o, v) => raw.writeUInt16LE(v, o)
    const w32 = (o, v) => raw.writeUInt32LE(v, o)

    // TIFF 头
    w16(0, 0x4949); w16(2, 42); w32(4, ifd0Off)
    // IFD0
    w16(ifd0Off, n0)
    ifd0.forEach(([id, type, count, ref], i) => {
        const base = ifd0Off + 2 + i * 12
        w16(base, id); w16(base + 2, type); w32(base + 4, count)
        let val
        if (ref === 'exifIfd') val = exifIfdOff
        else if (ref === 'ori') val = 1
        else if (type === 2) val = strOff[ref]
        else val = 0
        w32(base + 8, val)
    })
    w32(ifd0Off + 2 + n0 * 12, 0)                                  // next IFD
    // ExifIFD
    w16(exifIfdOff, n1)
    exifIfd.forEach(([id, type, count, ref], i) => {
        const base = exifIfdOff + 2 + i * 12
        w16(base, id); w16(base + 2, type); w32(base + 4, count)
        let val
        if (type === 2) val = strOff[ref]
        else if (type === 5) val = ratOff[ref]
        else val = iso
        w32(base + 8, val)
    })
    w32(exifIfdOff + 2 + n1 * 12, 0)                               // next IFD
    // 数据区：rationals
    for (const k of ['expo', 'fno', 'fl']) {
        const v = k === 'expo' ? expo : k === 'fno' ? fno : fl
        if (!v || ratOff[k] === undefined) continue
        w32(ratOff[k], v[0] >>> 0); w32(ratOff[k] + 4, v[1] >>> 0)
    }
    // 数据区：strings
    for (const [name, buf] of [['mk', mk], ['md', md], ['dt', dt], ['sw', sw], ['dto', dto]]) {
        if (buf) buf.copy(raw, strOff[name])
    }
    return raw
}

// 从 RAW 文件生成 EXIF APP1 段（含 FFE1 头），供格式转换嵌入输出 JPG。失败返回 null。
async function buildRawExifApp1(fp) {
    try {
        const obj = {}
        if (RAW_EXT.includes(pathExt(fp))) Object.assign(obj, await readRawExif(fp))
        const tiff = buildExifTiff(obj)
        if (!tiff) return null
        const seg = Buffer.alloc(2 + 2 + 6 + tiff.length)          // FFE1 + LEN + "Exif\0\0" + TIFF
        seg[0] = 0xFF; seg[1] = 0xE1
        seg.writeUInt16BE(6 + tiff.length, 2)
        seg.write('Exif\0\0', 4, 'latin1')
        tiff.copy(seg, 10)
        return seg
    } catch (e) {
        return null
    }
}

// 把 EXIF APP1 段（含 FFE1 头）插入 JPEG 的 SOI(FFD8) 之后。Node 端使用（供 RAW 缓存写入）。
// 非 JPEG 或 app1 无效时原样返回。
function embedExifApp1(bytes, app1) {
    if (!bytes || bytes.length < 2 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return bytes
    if (!app1 || !app1.length) return bytes
    const src = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
    const out = Buffer.alloc(src.length + app1.length)
    src.copy(out, 0, 0, 2)
    app1.copy(out, 2)
    src.copy(out, 2 + app1.length, 2)
    return out
}

module.exports = { ReadExifInfo, buildExifText, orientationAngle, RawExifOrientation: rawExifOrientation, buildRawExifApp1, embedExifApp1 }