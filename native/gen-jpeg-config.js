/*
 * 由 libjpeg-turbo 官方模板（src/*.h.in）生成构建所需的三个头文件：
 *   src/jconfig.h     - libjpeg API/ABI 版本与特性开关
 *   src/jconfigint.h  - 编译期内部配置（inline / TLS / 符号可见性等）
 *   src/jversion.h    - 版本标识字符串（jerror.c 使用）
 *
 * 之所以不直接用 CMake：本仓库用 node-gyp 构建 N-API 插件，CMake 会引入额外
 * 依赖。这里把上游 configure_file() 的固定取值写死，脚本幂等，可重复执行。
 *
 * 配置口径（与 Electron 22 / Node 16 的构建目标一致）：
 *   - libjpeg API 版本 62（即 6b），8bit 采样
 *   - 不启用 SIMD（无需 NASM，也不需要 simd/ 目录）
 *   - 开启算术编码与算术解码、内存 source/destination
 *   - 仅使用解码侧源文件
 */

'use strict';

const fs = require('fs');
const path = require('path');

// 脚本位于 native/，vendored libjpeg-turbo 以它为基准
const JPEG_SRC = path.join(__dirname, 'deps', 'libjpeg-turbo', 'src');

const IS_WINDOWS = process.platform === 'win32';
const IS_64BIT = process.arch === 'x64' || process.arch === 'arm64';

// 与 CMake 上游语义一致：@VAR@ 直接替换，#cmakedefine VAR 按真假展开
// 注意：同名占位符在不同模板里的引号写法不同（如 jconfig.h 的 VERSION 不带引号），
// 因此按目标文件分别取值。
const SUBSTITUTIONS = {
  'jconfig.h': {
    JPEG_LIB_VERSION: '62',
    VERSION: '"3.2.0"',
    LIBJPEG_TURBO_VERSION_NUMBER: '3002000',
  },
  'jconfigint.h': {
    BUILD: '20260101',
    HIDDEN: IS_WINDOWS ? '' : '__attribute__((visibility("hidden")))',
    INLINE: IS_WINDOWS ? '__forceinline' : '__inline__ __attribute__((always_inline))',
    THREAD_LOCAL: IS_WINDOWS ? '__declspec(thread)' : '__thread',
    CMAKE_PROJECT_NAME: 'libjpeg-turbo',
    VERSION: '3.2.0',
    SIZE_T: IS_64BIT ? '8' : '4',
    // 无 SIMD 时仍需要一个数值，避免 "#if SIMD_ARCHITECTURE == ..." 把未定义标识符当 0
    // 而与 NONE(-1) 混淆（见 simd/jsimdconst.h 的取值表）
    SIMD_ARCHITECTURE: '-1',
  },
  'jversion.h': {
    COPYRIGHT_YEAR: '1991-2026',
  },
};

// #cmakedefine 的真假：值为 true 时展开为 #define，否则展开为注释掉的 #undef
const CMAKEDEFINE_FLAGS = {
  C_ARITH_CODING_SUPPORTED: true,
  D_ARITH_CODING_SUPPORTED: true,
  WITH_SIMD: false,
  RIGHT_SHIFT_IS_UNSIGNED: false,
  HAVE_BUILTIN_CTZL: !IS_WINDOWS && IS_64BIT,
  HAVE_INTRIN_H: IS_WINDOWS,
  WITH_PROFILE: false,
};

const TARGETS = ['jconfig.h', 'jconfigint.h', 'jversion.h'];

function render(template, name) {
  const values = SUBSTITUTIONS[name];
  if (!values) {
    throw new Error(`${name}: 未定义占位符取值表`);
  }

  let out = template;

  // #cmakedefine VAR [值]
  out = out.replace(/^([ \t]*)#cmakedefine[ \t]+(\w+)([ \t]+.*)?$/gm, (line, indent, key, rest) => {
    if (!(key in CMAKEDEFINE_FLAGS)) {
      throw new Error(`${name}: 未配置的 #cmakedefine ${key}`);
    }
    if (CMAKEDEFINE_FLAGS[key]) {
      return `${indent}#define ${key}${rest || ''}`;
    }
    return `${indent}/* #undef ${key} */`;
  });

  // @VAR@
  out = out.replace(/@(\w+)@/g, (match, key) => {
    if (!(key in values)) {
      throw new Error(`${name}: 未配置的占位符 @${key}@`);
    }
    return values[key];
  });

  return out;
}

function main() {
  if (!fs.existsSync(JPEG_SRC)) {
    throw new Error(`找不到 libjpeg-turbo 源码目录：${JPEG_SRC}`);
  }

  for (const file of TARGETS) {
    const tplPath = path.join(JPEG_SRC, `${file}.in`);
    const outPath = path.join(JPEG_SRC, file);
    if (!fs.existsSync(tplPath)) {
      throw new Error(`缺少模板文件：${tplPath}`);
    }
    const rendered = render(fs.readFileSync(tplPath, 'utf8'), file);
    // 幂等写：内容未变就不落盘，保持 mtime 不变。
    // 否则每次 configure 都会刷新头文件时间戳，MSBuild 的增量判断
    // 会把所有 include jconfig.h 的 libjpeg 源文件当成“需要重编”，
    // 导致 build 之后再 run 又触发整棵 libjpeg 重编。
    if (fs.existsSync(outPath) && fs.readFileSync(outPath, 'utf8') === rendered) {
      console.log(`[gen-jpeg-config] ${file} 未变化，跳过写入`);
      continue;
    }
    fs.writeFileSync(outPath, rendered);
    console.log(`[gen-jpeg-config] ${path.relative(process.cwd(), outPath)}`);
  }
}

main();