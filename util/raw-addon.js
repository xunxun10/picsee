// 自研 LibRaw N-API 插件（native/）的统一加载入口。
// 后台解码线程（rawcache-worker.js）与 EXIF 读取（util/exif.js）都要用它，
// 故把“路径解析 + asar 解包路径改写 + 只加载一次”集中在这里。
'use strict'
const path = require('path')

// 插件相对仓库根目录的路径（构建产物，见 package.json 的 build:native）
const ADDON_RELATIVE_PATH = path.join('native', 'build', 'Release', 'picsee_raw.node')

let loaded = null

// 插件真实路径。打包后 native/ 被 asarUnpack 到 asar 之外，
// .node 只能从 app.asar.unpacked 下加载，否则 require 会失败。
function resolveAddonPath() {
    let addonPath = path.join(__dirname, '..', ADDON_RELATIVE_PATH)
    const packedPrefix = `app.asar${path.sep}`
    if (addonPath.includes(packedPrefix)) {
        addonPath = addonPath.replace(packedPrefix, `app.asar.unpacked${path.sep}`)
    }
    return addonPath
}

// 返回 { addon, path, error }；addon 为 null 表示加载失败（原因见 error）。
// 结果只计算一次：插件缺失时不做重复的 require 尝试，避免反复抛错拖慢流程。
function loadRawAddon() {
    if (loaded) return loaded
    const addonPath = resolveAddonPath()
    let addon = null
    let error = ''
    try {
        addon = require(addonPath)
    } catch (e) {
        error = (e && e.message) || String(e)
    }
    loaded = { addon: addon, path: addonPath, error: error }
    return loaded
}

module.exports = { loadRawAddon }