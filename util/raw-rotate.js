// 纯函数：按 EXIF 朝向旋转 BGRA 像素缓冲
// nativeImage.toBitmap() 返回的是 BGRA（每像素 4 字节），此处只做像素搬运，
// 不依赖 Electron，便于单测。
//
// ===== 图片旋转（朝向摆正）方案 =====
//
// 总原则：显示任何图片都是摆正的，且同一张图只允许旋转一次。
//
// 图片分两类来源，旋转的责任方不同：
//
// 1) JPG/JPEG —— 由浏览器负责摆正（程序不再自己按 EXIF 转）
//    styles.css 的 #img-single 使用默认的 image-orientation: from-image，Chromium 绘制时
//    直接按 EXIF 朝向输出，naturalWidth/Height 也返回摆正后的尺寸；canvas drawImage 同样
//    始终按朝向绘制 —— 显示、尺寸、导出三处朝向一致。渲染端 State.curAngle 只记录
//    “用户手动旋转的 90° 整数倍”（切图时由 renderer.js 的 resetAngle() 清零），
//    绘制时以 transform: rotate(curAngle * 90deg) 叠加，两处各转一次，不会重复旋转。
//    这样 8 种朝向（含 2/4/5/7 镜像）都由浏览器正确处理，不再局限于 90° 整数倍。
//
// 2) RAW（crw/cr2/nef/orf/raf/rw2/arw/dng）—— 在生成缓存像素时旋转
//    RAW 无法被浏览器解码，主进程先解码出 raw.cache/<原名>.jpg（如 xx.CR2.jpg）再交给渲染端显示，
//    因此旋转在“写缓存”这一步就完成，渲染端不再旋转（缓存 JPG 也不带朝向标记）。
//    缓存有两条生成路径，二者产出都必须是正的：
//
//    A. LibRaw 解码（主路径，在后台 worker 线程执行）
//       内置 LibRaw 官方源码 + 自研 N-API 插件（native/）直连解码，默认 user_flip = -1，
//       即沿用相机 EXIF 朝向；LibRaw 在 copy_mem_image() 中按 S.flip 调 flip_index()
//       输出像素，且当 S.flip & 4（90°/270°）时交换宽高 —— 即朝向已由 LibRaw 烘进像素，
//       这条路径不需要、也不能再额外旋转。（实测：把 CR2 朝向标记改为 6，输出尺寸由
//       3200x2136 变为 3200x4794，印证已自动摆正。）
//
//    B. 内嵌预览兜底（仅当 LibRaw 解码失败时启用）
//       盲扫出的内嵌 JPEG 是“传感器原始朝向”，且一般不含可用的 EXIF 朝向标记，
//       无从得知该转多少度，所以这种图看上去“没有自动旋转”。因此这里读取 RAW 文件
//       自身的 EXIF 朝向（util/exif.js 的 RawExifOrientation()），再用本模块的
//       rotateBGRA() 把像素转正，使兜底产出的缓存同样是摆正的。
//
// 关键约束：写缓存时必须把朝向摆正、且缓存 JPG 不携带 EXIF 朝向标记，否则浏览器显示时
// 会再转一次，与缓存阶段的翻转叠加成双重旋转（图像歪 90°/180°）。
// exif-info 的 baked 字段（RAW 恒为 true、JPG 不返回）可用于排查时区分两类来源。
//
// 依赖说明：nativeImage 未提供旋转接口，故 main.js 的 RotateNativeImage() 先取
// toBitmap() 的 BGRA 缓冲交给本模块搬运，再用 createFromBitmap() 还原为图片。
//
// 附：状态栏拍摄参数里的 A（拍摄角度）与本文所说的旋转角度不是同一个值
// A:<n>° 沿用原程序口径（见 util/exif.js 的 shotAngle()），含义是“图片拍摄时的角度/当前角度”，
// 与“为摆正图片所需顺时针旋转的角度”互为反向，属刻意设计，两处不要互相替换。
'use strict'

// EXIF 朝向取值语义（1-8，对应 TIFF IFD0 的 0x0112）：
//   1 正常        2 水平镜像      3 旋转 180       4 垂直镜像
//   5 水平镜像+顺时针 270（转置）   6 顺时针 90
//   7 水平镜像+顺时针 90（反转置）  8 顺时针 270
// 实现方式：先对 2/5/7 做水平镜像，再做 180/90/270 旋转
// （4 = 水平镜像 + 180，与垂直镜像等价，故直接走 180 分支）。
const ORIENTATION_NAMES = {
    1: 'normal',
    2: 'flip-h',
    3: 'rotate-180',
    4: 'flip-v',
    5: 'transpose',
    6: 'rotate-90-cw',
    7: 'transverse',
    8: 'rotate-270-cw',
}

function flipH(buf, w, h) {
    const out = Buffer.allocUnsafe(buf.length)
    for (let y = 0; y < h; y++) {
        const row = y * w * 4
        for (let x = 0; x < w; x++) {
            const s = row + x * 4
            const d = row + (w - 1 - x) * 4
            out[d] = buf[s]; out[d + 1] = buf[s + 1]; out[d + 2] = buf[s + 2]; out[d + 3] = buf[s + 3]
        }
    }
    return out
}

function rotate90(buf, w, h) {
    // 顺时针 90°：尺寸变为 (h, w)
    const nw = h, nh = w
    const out = Buffer.allocUnsafe(buf.length)
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const s = (y * w + x) * 4
            const dx = h - 1 - y
            const dy = x
            const d = (dy * nw + dx) * 4
            out[d] = buf[s]; out[d + 1] = buf[s + 1]; out[d + 2] = buf[s + 2]; out[d + 3] = buf[s + 3]
        }
    }
    return { data: out, width: nw, height: nh }
}

function rotate180(buf, w, h) {
    const out = Buffer.allocUnsafe(buf.length)
    const total = w * h
    for (let i = 0; i < total; i++) {
        const s = i * 4
        const d = (total - 1 - i) * 4
        out[d] = buf[s]; out[d + 1] = buf[s + 1]; out[d + 2] = buf[s + 2]; out[d + 3] = buf[s + 3]
    }
    return { data: out, width: w, height: h }
}

function rotate270(buf, w, h) {
    // 顺时针 270°（= 逆时针 90°）：尺寸变为 (h, w)
    const nw = h, nh = w
    const out = Buffer.allocUnsafe(buf.length)
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const s = (y * w + x) * 4
            const dx = y
            const dy = w - 1 - x
            const d = (dy * nw + dx) * 4
            out[d] = buf[s]; out[d + 1] = buf[s + 1]; out[d + 2] = buf[s + 2]; out[d + 3] = buf[s + 3]
        }
    }
    return { data: out, width: nw, height: nh }
}

// 按 EXIF 朝向旋转 BGRA 缓冲，返回 { data, width, height }
// 朝向为 1（正常）或非法值时原样返回（data 与入参同一引用，调用方据此可跳过重建）
function rotateBGRA(buf, w, h, orientation) {
    const o = Number(orientation) || 1
    if (o === 1 || !ORIENTATION_NAMES[o]) return { data: buf, width: w, height: h }
    // 2/5/7 需要先水平镜像（其余朝向只做旋转）
    const src = (o === 2 || o === 5 || o === 7) ? flipH(buf, w, h) : buf
    if (o === 3 || o === 4) return rotate180(src, w, h)
    if (o === 6 || o === 7) return rotate90(src, w, h)
    if (o === 5 || o === 8) return rotate270(src, w, h)
    return { data: src, width: w, height: h }
}

module.exports = { rotateBGRA, ORIENTATION_NAMES }
