# PicSee 图片浏览器

基于 Electron 的轻量看图软件，支持 Windows 与 Linux x86/ARM64。

提供选图比对功能，支持 CR2 等 RAW 图片预览，支持旋转保存、格式转换、批量压缩等功能。

对操作体验进行了特别优化，特别是大图、长图的使用体验。

## 功能特性

- **四种浏览模式**（右键菜单或状态栏切换，`Alt+B/N/M/X`）
  - 相框模式：等比完整显示
  - 原图模式：按照原图大小进行展示，可拖动、缩放、平移
  - 漫画模式：多图纵向连排，滚轮/方向键整屏翻页
  - 筛选模式：两张图并排对比，单击同步放大进行比对
- **浏览操作**：`←`/`→` 翻页、`Ctrl+滚轮`或工具栏缩放
- **旋转**：左旋/右旋（`Ctrl+←`/`Ctrl+→`），支持旋转后保存
- **多格式浏览**：常规图片 bmp、png、jpg/jfif、gif、webp、avif、svg、ico、tiff，RAW 见下
- **RAW 支持**：支持CR2等图片预览
- **标注与截屏**：支持标记、截屏
- **文件操作**：删除、复制、移动、打开所在文件夹
- **格式与压缩**：格式转换（JPG/BMP/PNG/GIF/TIFF/WebP），支持单张 / 整个文件夹压缩
- **其他**：GIF 播放/暂停、全屏

## 支持的图片格式

| 类别  | 格式                              |
| --- | ------------------------------- |
| 常规  | bmp、png、jpg、jpeg、jfif、gif、webp、avif、svg、ico、tiff、tif |
| RAW | crw、cr2、nef、raf、arw、rw2、dng、orf |

## 快捷键

| 快捷键            | 功能           | 快捷键                 | 功能                   |
| -------------- | ------------ | ------------------- | -------------------- |
| `Ctrl+O`       | 打开图片         | `Ctrl+C`            | 复制到 `_copied` 并放入剪贴板 |
| `Ctrl+X`       | 移动到 `_moved` | `Ctrl+P`            | 标记当前图片               |
| `Ctrl+A`       | 格式转换         | `Ctrl+S`            | 旋转后保存                |
| `Ctrl+F`       | 全屏           | `Ctrl+D` / `Delete` | 删除                   |
| `Ctrl+Shift+D` | 截屏           | `Ctrl+←` / `Ctrl+→` | 左旋 / 右旋              |
| `空格`           | GIF 播放/暂停    | `Alt+B`             | 相框模式                 |
| `Alt+N`        | 原图模式         | `Alt+M`             | 漫画模式                 |
| `Alt+X`        | 筛选模式         | `←` / `→`           | 上一张 / 下一张            |

## 开发

要求 Node.js + npm。

```bash
npm install         # 安装依赖
npm run build:native  # 编译 RAW 解码插件（产出 native/build/Release/picsee_raw.node）
npm start           # 本地运行（已内联 build:native，直接跑也可以）
```

`build:native` 的编译前置条件：

| 平台          | 前置条件                                                  |
| ----------- | ----------------------------------------------------- |
| Windows x64 | Visual Studio Build Tools 2022（含“使用 C++ 的桌面开发”工作负载）+ Python 3 |
| Linux x86_64 / ARM64 | `build-essential`（gcc/g++、make）+ Python 3 |

RAW 解码插件的源码全部内置在仓库 `native/deps/` 下（LibRaw / zlib / libjpeg-turbo），
编译过程不联网、不下载预编译二进制。若插件缺失或编译失败，应用仍可运行，
但 RAW 会退化为“内嵌预览兜底”出图。

## 构建打包

| 平台           | 命令                  | 产物目录                        |
| ------------ | ------------------- | --------------------------- |
| Windows x64  | `npm run dist`      | `dist/win-unpacked`         |
| Linux x86_64 | `npm run linux.x86` | `dist/linux-unpacked`       |
| Linux ARM64  | `npm run arm`       | `dist/linux-arm64-unpacked` |

三个打包脚本都会先执行 `npm run build:native`，原生插件必须在目标平台（同架构）上构建，
例如 `linux-arm64` 需在 arm64 机器上构建。插件会被 `asarUnpack` 解包到
`resources/app.asar.unpacked/native/build/Release/`，运行时从该路径加载。

打包前需先关闭正在运行的 picsee。版本号、变更记录、打包、增量更新等运维操作可使用 `dev.sh`，详见 `./dev.sh help`。

## 项目结构

```
picsee/
├── main.js                    # 主进程：窗口、文件列表、RAW 解码调度、IPC
├── preload.js                 # 预加载脚本
├── renderer.js                # 渲染进程：模式渲染、交互、菜单、快捷键
├── index.html                 # 主界面
├── styles.css                 # 样式
├── util/                      # EXIF 解析、RAW 线程池/旋转、JPEG 重编码、插件加载
├── rawcache-worker.js         # RAW 解码 worker
├── native/                    # RAW 解码 N-API 插件
│   ├── binding.gyp            # node-gyp 构建脚本
│   ├── gen-jpeg-config.js     # 由官方模板生成 libjpeg 配置头
│   ├── list-raw-sources.js    # 显式展开 vendored 源码清单供 gyp 编译
│   ├── src/picsee_raw.cc      # 插件源码：直连 LibRaw C API
│   └── deps/                  # 内置官方源码（LibRaw / zlib / libjpeg-turbo）
├── res/                       # 图标与默认图片
└── change_log.txt             # 变更日志
```

## 依赖组件

| 组件                                                       | 版本     | 用途                                              |
| -------------------------------------------------------- | ------ | ----------------------------------------------- |
| [Electron](https://www.electronjs.org/)                  | 22.x   | 跨平台桌面运行时                                        |
| [LibRaw](https://www.libraw.org/)                        | 0.22.2 | RAW 解码（源码内置于 `native/deps/LibRaw`，经自研 N-API 插件调用） |
| [libjpeg-turbo](https://libjpeg-turbo.org/)              | 3.2.0  | LibRaw 解 JPEG 有损压缩 RAW（源码内置于 `native/deps/libjpeg-turbo`） |
| [zlib](https://zlib.net/)                                | 1.3.1  | LibRaw 解 deflate 压缩 DNG（源码内置于 `native/deps/zlib`） |
| [sharp](https://sharp.pixelplumbing.com/)                | 0.32.6 | RAW 缓存 JPG 的缩放与编码                                |

## 第三方许可

| 组件            | 许可协议                                                                      |
| ------------- | ------------------------------------------------------------------------- |
| LibRaw        | LGPL-2.1 或 CDDL-1.0 二选一（本项目采用 CDDL-1.0，以允许静态链接，源码随仓库提供）                  |
| libjpeg-turbo | IJG / BSD-3-Clause / zlib（详见 `native/deps/libjpeg-turbo/LICENSE.md`）       |
| zlib          | zlib License（详见 `native/deps/zlib/LICENSE`）                               |
| sharp         | Apache-2.0                                                                |

## 许可证

MIT：<https://github.com/xunxun10/picsee/blob/main/LICENSE>
