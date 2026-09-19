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

        "deps/zlib/*.c",

        "deps/libjpeg-turbo/src/*.c",

        "deps/LibRaw/src/*.cpp",
        "deps/LibRaw/src/decoders/*.cpp",
        "deps/LibRaw/src/decompressors/*.cpp",
        "deps/LibRaw/src/demosaic/*.cpp",
        "deps/LibRaw/src/integration/*.cpp",
        "deps/LibRaw/src/metadata/*.cpp",
        "deps/LibRaw/src/postprocessing/*.cpp",
        "deps/LibRaw/src/preprocessing/*.cpp",
        "deps/LibRaw/src/tables/*.cpp",
        "deps/LibRaw/src/utils/*.cpp",
        "deps/LibRaw/src/write/*.cpp",
        "deps/LibRaw/src/x3f/*.cpp"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include_dir\")",
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
          "AdditionalOptions": ["/std:c++17"]
        }
      },
      # Electron 4+ 在 Windows 上必需，否则加载时报 "Module did not self-register"
      "win_delay_load_hook": "true"
    }
  ]
}