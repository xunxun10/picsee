/*
 * 输出 native 下 vendored C/C++ 源码清单（每行一个，相对 native/ 的正斜杠路径）。
 *
 * 背景：gyp 的 MSBuild (msvs) 生成器不展开 sources 里的通配符，会把 "deps/zlib/*.c"
 * 原样写进 vcxproj，MSBuild 批量展开后把多个源文件塞进同一条 cl 命令，导致
 * /Fo 带通配符报 D8036。这里在 configure 阶段就把通配符展开成显式文件列表。
 *
 * 调用方式（binding.gyp 内，gyp 的 <!@ 以 native/ 为 cwd 执行）：
 *   "sources": [ "src/picsee_raw.cc", "<!@(node ./list-raw-sources.js)" ]
 *
 * 可离线运行：只依赖 fs/path，不联网；输出已排序，保证跨平台构建产物可复现。
 */
'use strict'

const fs = require('fs')
const path = require('path')

// 脚本位于 native/，vendored 源码目录都以它为基准
const NATIVE = __dirname

// [相对 native/ 的目录, 扩展名]；扩展名决定编译语言（.c 与 .cpp 分开列）
const SOURCE_ROOTS = [
  ['deps/zlib', '.c'],
  ['deps/libjpeg-turbo/src', '.c'],
  ['deps/LibRaw/src', '.cpp'],
  ['deps/LibRaw/src/decoders', '.cpp'],
  ['deps/LibRaw/src/decompressors', '.cpp'],
  ['deps/LibRaw/src/demosaic', '.cpp'],
  ['deps/LibRaw/src/integration', '.cpp'],
  ['deps/LibRaw/src/metadata', '.cpp'],
  ['deps/LibRaw/src/postprocessing', '.cpp'],
  ['deps/LibRaw/src/preprocessing', '.cpp'],
  ['deps/LibRaw/src/tables', '.cpp'],
  ['deps/LibRaw/src/utils', '.cpp'],
  ['deps/LibRaw/src/write', '.cpp'],
  ['deps/LibRaw/src/x3f', '.cpp'],
]

// libjpeg-turbo 里这几个文件不是独立编译单元，而是被对应模块 #include
//（如 jdcolor.c / jdmerge.c / jdhuff.c），单独编译会报 LOCAL 等宏未定义；
// example.c / minigzip.c 是 zlib 的演示程序，不属于库本体
const EXCLUDE = new Set([
  'jdcol565.c', 'jdcolext.c', 'jdmrg565.c', 'jdmrgext.c', 'jstdhuff.c',
  'example.c', 'minigzip.c',
])

// LibRaw 的 *_ph.cpp 是"占位/精简"替代实现（函数体返回 LIBRAW_NOT_IMPLEMENTED），
// 与真实实现（如 dcraw_process.cpp / raw2image.cpp / file_write.cpp）互斥，
// 二者同时编译会产生相同符号导致 LNK2005 重复定义。我们要完整解码，必须排除它们
// 而保留真实实现。目前仅有 postprocessing_ph.cpp / preprocessing_ph.cpp / write_ph.cpp
const EXCLUDE_SUFFIX = '_ph.cpp'

const files = []
for (const [relDir, ext] of SOURCE_ROOTS) {
  const absDir = path.join(NATIVE, relDir)
  if (!fs.existsSync(absDir)) {
    throw new Error(`源码目录不存在: ${absDir}`)
  }
  for (const name of fs.readdirSync(absDir)) {
    if (name.endsWith(ext) && !EXCLUDE.has(name) && !name.endsWith(EXCLUDE_SUFFIX)) {
      files.push(path.posix.join(relDir.split(path.sep).join('/'), name))
    }
  }
}

files.sort()
if (files.length === 0) {
  throw new Error('未匹配到任何源码文件')
}
process.stdout.write(files.join('\n') + '\n')
