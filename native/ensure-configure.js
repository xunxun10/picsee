'use strict'
/*
 * build:native 的编排入口：仅在 configure 的输入变化时才重新 configure，
 * 否则直接增量 build，避免每次 dev run/build 都刷新 .vcxproj 导致 MSVC 全量重编。
 *
 * 分层说明：
 *   - configure 管的输入 = binding.gyp + list-raw-sources.js 的输出（编译单元清单）
 *   - .cpp/.cc 的"内容"改动归 build 层，由 MSVC 增量编译处理，不触发 configure；
 *     但"增删源文件"会改变 list-raw-sources.js 输出 -> 指纹变化 -> 自动重新 configure
 *
 * 指纹来源与 configure 生成产物一致：
 *   binding.gyp 文件内容 + list-raw-sources.js 本次输出（决定 .vcxproj 的 sources）
 * 首次（无 config.gypi）或指纹不匹配时重新 configure 并刷新指纹。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawnSync } = require('child_process')

const NATIVE = __dirname
const PROJ = path.dirname(NATIVE)
const NODE_GYP = path.join(PROJ, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js')
const BUILD = path.join(NATIVE, 'build')
const CONFIG_GPYI = path.join(BUILD, 'config.gypi')
const FP_FILE = path.join(BUILD, '.configure-fingerprint')

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex')

// 编译单元清单：node-gyp configure 用它生成 .vcxproj 的 source 列表
function sourcesFingerprint() {
  const r = spawnSync(process.execPath, [path.join(NATIVE, 'list-raw-sources.js')], {
    cwd: NATIVE, encoding: 'utf8',
  })
  if (r.status !== 0) throw new Error('list-raw-sources.js 运行失败: ' + (r.stderr || r.stdout))
  return md5(r.stdout)
}

function currentFingerprint() {
  const binding = fs.readFileSync(path.join(NATIVE, 'binding.gyp'), 'utf8')
  return md5(binding + '\n' + sourcesFingerprint())
}

function needsConfigure() {
  if (!fs.existsSync(CONFIG_GPYI)) return true
  if (!fs.existsSync(FP_FILE)) return true
  return fs.readFileSync(FP_FILE, 'utf8').trim() !== currentFingerprint()
}

function runStep(args) {
  const r = spawnSync(process.execPath, [NODE_GYP, ...args], { cwd: PROJ, stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status && r.status > 0 ? r.status : 1)
}

if (needsConfigure()) {
  runStep(['configure', '-C', 'native'])
  fs.mkdirSync(path.dirname(FP_FILE), { recursive: true })
  fs.writeFileSync(FP_FILE, currentFingerprint())
  console.log('[ensure-configure] 已重新 configure（配置输入变化）')
} else {
  console.log('[ensure-configure] 无需 configure，直接增量 build')
}

runStep(['build', '-C', 'native'])