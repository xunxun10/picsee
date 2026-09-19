{
  # 自研 N-API 插件：直接调用 vendored LibRaw 的 C API 完成 RAW 解码。
  # 依赖（全部随仓库内置，离线可编译）：
  #   deps/LibRaw          LibRaw 0.22.2 官方源码
  #   deps/zlib            zlib 1.3.1 官方源码（LibRaw 解 deflate 压缩 DNG）
  #   deps/libjpeg-turbo   libjpeg-turbo 3.2.0 官方源码（仅解码侧，LibRaw 解 JPEG 有损压缩 RAW）
  # 生成步骤见 package.json 的 build:native（先跑 scripts/gen-jpeg-config.js）
  "targets": [
    {
      "target_name": "picsee_raw",
      "sources": [
        "src/picsee_raw.cc",
        # libjpeg-turbo 3.x 运行时 8/12/16 位精度选择需要 j12init_*/j16init_* 链接符号，
        # 本项目只做 8 位解码，用空实现 stub 补齐（见文件内注释）
        "src/jpeg_1216_stubs.c",

        # gyp 的 msvs 生成器不展开通配符，源文件由脚本显式列出（见 native/list-raw-sources.js）
        "<!@(node ./list-raw-sources.js)"
      ],
      "include_dirs": [
        # node-addon-api 的 include 目录：直接展开其相对路径会被 gyp 的 vcxproj 生成器
        # 把反斜杠分隔符吃掉，因此这里用拼好的绝对路径（正斜杠）输出
        "<!@(node -p \"require('path').resolve(require('node-addon-api').include_dir).replace(/\\\\/g, '/')\")",
        "src",
        "deps/LibRaw",
        "deps/LibRaw/libraw",
        "deps/LibRaw/internal",
        "deps/zlib",
        "deps/libjpeg-turbo/src"
      ],
      "defines": [
        "NAPI_VERSION=8",
        # LibRaw 可选依赖开关；不定义 USE_LCMS/USE_LCMS2，LibRaw 会自动置 NO_LCMS
        "USE_ZLIB",
        "USE_JPEG",
        # Windows 上静态链接 LibRaw：不定义 LIBRAW_NODLL 时头文件会把 API 声明为
        # dllimport，编译 libraw_c_api.cpp 会报 C2491（不允许定义 dllimport 函数）
        "LIBRAW_NODLL",
        # zlib 符号前缀隔离：zlib 与 LibRaw 编译单元都要带，避免与 Node/Electron
        # 内置 zlib 的导出符号在链接期冲突（Windows 上表现为 LNK2005）
        "Z_PREFIX",
        "_CRT_SECURE_NO_WARNINGS",
        "_CRT_NONSTDC_NO_DEPRECATE"
      ],
      "cflags_cc": ["-std=c++17", "-fexceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "cflags!": ["-fno-exceptions"],
      "xcode_settings": {
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "CLANG_CXX_LIBRARY": "libc++",
        "MACOSX_DEPLOYMENT_TARGET": "10.15"
      },
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1,
          # /utf-8：源文件为 UTF-8（含中文错误消息），默认代码页 936 会误解析出换行符
          "AdditionalOptions": ["/std:c++17", "/utf-8"]
        }
      },
      # Electron 4+ 在 Windows 上必需，否则加载时报 "Module did not self-register"
      "win_delay_load_hook": "true"
    }
  ]
}