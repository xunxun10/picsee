# PicSee 图片浏览器

基于 Electron 的轻量看图软件，支持 Windows 与 Linux x86/ARM64。

提供选图比对功能，支持 CR2 等 RAW 图片预览，支持旋转保存、格式转换、批量压缩等功能。

对操作体验进行了特别优化，特别是大图、长图的使用体验。

> 由于无法确认`lightdrift-libraw`安全性，暂时取消release 版本发布

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
npm install     # 安装依赖
npm start       # 本地运行
```

## 构建打包

| 平台           | 命令                  | 产物目录                        |
| ------------ | ------------------- | --------------------------- |
| Windows x64  | `npm run dist`      | `dist/win-unpacked`         |
| Linux x86_64 | `npm run linux.x86` | `dist/linux-unpacked`       |
| Linux ARM64  | `npm run arm`       | `dist/linux-arm64-unpacked` |

打包前需先关闭正在运行的 picsee。版本号、变更记录、打包、增量更新等运维操作可使用 `dev.sh`，详见 `./dev.sh help`。

## 项目结构

```
picsee/
├── main.js              # 主进程：窗口、文件列表、RAW 解码调度、IPC
├── preload.js           # 预加载脚本
├── renderer.js          # 渲染进程：模式渲染、交互、菜单、快捷键
├── index.html           # 主界面
├── styles.css           # 样式
├── util/                # EXIF 解析、RAW 线程池/旋转、JPEG 重编码
├── rawcache-worker.js   # RAW 解码 worker
├── res/                 # 图标与默认图片
└── change_log.txt       # 变更日志
```

## 依赖组件

| 组件                                                                   | 版本   | 用途                                                    |
| -------------------------------------------------------------------- | ---- | ----------------------------------------------------- |
| [Electron](https://www.electronjs.org/)                              | 22.x | 跨平台桌面运行时                                              |
| [lightdrift-libraw](https://www.npmjs.com/package/lightdrift-libraw) | 1.x  | [LibRaw](https://www.libraw.org/) 的 Node 绑定，用于 RAW 解码 |

## 许可证

MIT：<https://github.com/xunxun10/picsee/blob/main/LICENSE>
