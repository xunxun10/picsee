// 输出 node-addon-api 的 include 目录（绝对路径、正斜杠），供 binding.gyp 的 <!@ 展开。
// 用脚本文件而非内联 node -p 命令，避免 gyp 字符串经 sh/cmd 转义后正则被破坏。
const path = require('path');

const includeDir = path.resolve(require('node-addon-api').include_dir);
process.stdout.write(includeDir.replace(/\\/g, '/'));
