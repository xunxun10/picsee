#!/bin/bash
# picsee 开发/运维脚本（由 snippet-note 的 dev.sh 迁移适配而来）

S_DIR=$(dirname $(readlink -m $0))
PKG="$S_DIR/package.json"
# 打包：所有平台统一按最大 199MB 分片
SPLIT_SIZE="199m"

function Info(){
    echo -e "\033[32m`date '+%Y-%m-%d %H:%M:%S'` Info: $1\033[0m";
}

function Error(){
    echo -e "\033[31m`date '+%Y-%m-%d %H:%M:%S'` Error: $1\033[0m";
}

function CheckOption(){
    if [ $? -ne 0 ]; then
        Error "$1";
        exit 1;
    fi
}

function _elapsed() {
    local t_start=$1
    local elapsed=$(($(date +%s) - t_start))
    Info "耗时: ${elapsed}s"
}

function show_help() {
    echo "Usage: ./dev.sh <command> [options]"
    echo ""
    echo "Commands:"
    echo "  new       小版本 +1（如 0.5.2 -> 0.5.3），末位递增"
    echo "  new major 大版本 +1（如 0.5.2 -> 0.6.0），中间位递增、末位归零"
    echo "  chg       将尚未记录的 git 提交追加到 change_log.txt（记录上次执行时间，人工调整后不会重复追加）"
    echo "  run       本地运行应用（electron .）进行调试（先确保 native 插件架构正确）"
    echo "  build     运行当前平台的构建命令（build:native + electron-builder）"
    echo "  pack      构建并打包为 zip 或分片压缩包"
    echo "  incr      生成增量更新包（基于 dist.files.md5 对比）"
    echo "  incr label  仅生成 dist.files.md5 标签文件"
    echo "  clean     清理 dist 目录下的构建产物"
    echo "  push      将本地多个 commit squash 后推送到远程"
    echo "  sync      将本地文件/目录 scp 到远程主机（用法: ./dev.sh sync <[user@]host[:端口]:目录> [本地路径]；不传本地路径则同步 git 变更文件含新增，端口默认 2222）"
    echo "  help      显示此帮助信息"
}

# ===== 平台检测 =====
function _detect_platform() {
    local arch=$(uname -m)
    local os=$(uname -s)

    if [[ "$os" == CYGWIN* || "$os" == MINGW* || "$os" == MSYS* || "$os" == Windows_NT ]]; then
        if [[ "$arch" == "x86_64" || "$arch" == "amd64" ]]; then
            PLATFORM="win"
            BUILD_CMD="npm run dist"
            BUILD_DIR="win-unpacked"
            OUTPUT_NAME="picsee-win32-x64"
            ARCH_TAG="win32-x64"
            LABEL_FILE="dist.files.md5.win.txt"
            ZA="$S_DIR/node_modules/7zip-bin/win/x64/7za.exe"
        else
            Error "不支持的 Windows 架构: $arch"
            exit 1
        fi
    elif [ "$os" == "Linux" ]; then
        if [[ "$arch" == "x86_64" || "$arch" == "amd64" ]]; then
            PLATFORM="linux.x86"
            BUILD_CMD="npm run linux.x86"
            BUILD_DIR="linux-unpacked"
            OUTPUT_NAME="picsee-linux-x86"
            ARCH_TAG="linux-x86"
            LABEL_FILE="dist.files.md5.linux-x86.txt"
            ZA="$S_DIR/node_modules/7zip-bin/linux/x64/7za"
        elif [[ "$arch" == "aarch64" || "$arch" == "arm64" || "$arch" == "armv8"* ]]; then
            PLATFORM="arm"
            BUILD_CMD="npm run arm"
            BUILD_DIR="linux-arm64-unpacked"
            OUTPUT_NAME="picsee-linux-arm64"
            ARCH_TAG="linux-arm64"
            LABEL_FILE="dist.files.md5.txt"
            ZA="$S_DIR/node_modules/7zip-bin/linux/arm64/7za"
        else
            Error "不支持的 Linux 架构: $arch"
            exit 1
        fi
    else
        Error "不支持的操作系统: $os"
        exit 1
    fi
}

# ===== 版本号递增 =====
function incr_version() {
    local t_start=$(date +%s)
    local ver=$(grep '"version"' "$PKG" | head -1 | awk -F '"' '{print $4}')
    if [ -z "$ver" ]; then
        Error "无法读取版本号"
        exit 1
    fi

    local major=$(echo "$ver" | cut -d. -f1)
    local minor=$(echo "$ver" | cut -d. -f2)
    local patch=$(echo "$ver" | cut -d. -f3)

    if [ "$1" == "major" ]; then
        local new_minor=$((minor + 1))
        local new_ver="$major.$new_minor.0"
        Info "升级大版本（中间位）"
    else
        local new_patch=$((patch + 1))
        local new_ver="$major.$minor.$new_patch"
        Info "升级小版本（末位）"
    fi

    sed -i "s/\"version\": \"$ver\"/\"version\": \"$new_ver\"/" "$PKG"
    Info "版本号: $ver -> $new_ver"

    # 在 change_log.txt 末尾追加空行和新版本信息
    local changelog="$S_DIR/change_log.txt"
    echo "" >> "$changelog"
    echo "$new_ver" >> "$changelog"
    Info "已更新 $changelog"
    _elapsed $t_start
}

# ===== 运行 =====
function run(){
    Info "开始本地运行应用（electron .）..."
    _detect_platform
    _ensure_native_arch
    cd "$S_DIR" && npm start
    CheckOption "npm start 执行失败"
}

# ===== 构建 =====
# 记录 native 插件的架构指纹：config.gypi 里没有现成 arch 字段，
# 用 .node 产物后缀判断上次构建的架构（x64.node / arm64.node）
NATIVE_ARCH_MARKER="$S_DIR/native/build/.node-arch"

# 在 build/pack 前调用：确保 native/build 与当前平台架构一致，
# 跨架构复用会静默产出陈旧/错误的 .node，必须清掉重编
function _ensure_native_arch() {
    local want
    case "$PLATFORM" in
        win|linux.x86) want="x64" ;;
        arm)           want="arm64" ;;
    esac

    local prev=""
    if [ -f "$NATIVE_ARCH_MARKER" ]; then
        prev=$(cat "$NATIVE_ARCH_MARKER")
    elif [ -d "$S_DIR/native/build" ]; then
        # 无标记文件的旧目录：检查是否残留 .node 产物
        if ls "$S_DIR/native/build/Release/"*.node >/dev/null 2>&1; then
            prev="unknown"
        fi
    fi

    if [ "$prev" != "$want" ]; then
        if [ -n "$prev" ]; then
            Info "native 插件架构不匹配（$prev -> $want），清理 native/build 重新编译"
        else
            Info "首次构建 native 插件（$want）"
        fi
        rm -rf "$S_DIR/native/build"
        mkdir -p "$S_DIR/native/build"
        echo "$want" > "$NATIVE_ARCH_MARKER"
    fi
}

function build(){
    local t_start=$(date +%s)
    _detect_platform
    _ensure_native_arch

    Info "开始执行 $BUILD_CMD ..."
    cd "$S_DIR" && $BUILD_CMD
    CheckOption "$BUILD_CMD 执行失败"

    _elapsed $t_start
}

# ===== 打包（构建 + 压缩） =====

# 用 7za 按分片大小压缩并做单分卷兜底重命名。
# $1=zip 名（不含扩展），$2=待压缩目录，$3=分片大小（如 199m）。成功返回 0，失败返回 1。
function _zip_pack(){
    local zname=$1
    local srcdir=$2
    local split_size=$3

    "$ZA" a -tzip -bso0 -bsp0 "$zname.zip" "$srcdir" -v${split_size}
    if [ $? -ne 0 ]; then
        Error "压缩 $zname.zip 失败"
        return 1
    fi

    # 兜底：仅一个分卷时重命名为普通 .zip
    if [ -f "$zname.zip.001" ] && [ ! -f "$zname.zip.002" ]; then
        mv "$zname.zip.001" "$zname.zip"
        Info "仅一个分卷，已重命名为 $zname.zip"
    fi
    return 0
}

function pack(){
    local t_start=$(date +%s)
    _detect_platform
    local version=$(grep '"version"' "$PKG" | awk -F '"' '{print $4}')

    # 清理旧包（兼容 zip 与 7za 两种分卷命名）
    rm -f "$S_DIR/dist/$OUTPUT_NAME"*.zip "$S_DIR/dist/$OUTPUT_NAME"*.zip.[0-9][0-9][0-9] "$S_DIR/dist/$OUTPUT_NAME"*.z[0-9][0-9]

    # 构建
    Info "开始执行 $BUILD_CMD ..."
    cd "$S_DIR" && _ensure_native_arch && $BUILD_CMD
    CheckOption "$BUILD_CMD 执行失败"

    # 打包：按 $SPLIT_SIZE 分片
    local split_size="$SPLIT_SIZE"
    local src_dir="$S_DIR/dist/$BUILD_DIR"
    if [ ! -d "$src_dir" ]; then
        Error "构建产物目录 $src_dir 不存在"
        exit 1
    fi

    # 7za 由 electron-builder 依赖（7zip-bin）提供，所有平台统一使用，避免依赖系统 zip 命令
    if [ ! -f "$ZA" ]; then
        Error "未找到 7za（$ZA），请先执行 npm install"
        exit 1
    fi

    cd "$S_DIR/dist"

    if [ "$PLATFORM" == "arm" ]; then
        # ARM64: 分片 zip 压缩
        Info "开始将 $BUILD_DIR 打包为 $OUTPUT_NAME-$version.zip（按 ${split_size} 分片）..."
        mv "$BUILD_DIR" "$OUTPUT_NAME" &&
            _zip_pack "$OUTPUT_NAME-$version" "$OUTPUT_NAME" "$split_size" &&
            mv "$OUTPUT_NAME" "$BUILD_DIR" &&
            Info "已打包为 $OUTPUT_NAME-$version.zip 及分片文件"
        CheckOption "打包 $OUTPUT_NAME 失败"

        # linux-arm64 同时生成增量包
        incr;
        CheckOption "生成增量包失败";
    else
        # Windows/Linux x86: 分片 zip 压缩
        Info "开始将 $BUILD_DIR 打包为 $OUTPUT_NAME-$version.zip（按 ${split_size} 分片）..."
        cp -rfa "$BUILD_DIR" "$OUTPUT_NAME" &&
            _zip_pack "$OUTPUT_NAME-$version" "$OUTPUT_NAME" "$split_size" &&
            rm -rf "$OUTPUT_NAME" &&
            Info "已打包为 $OUTPUT_NAME-$version.zip 及分片文件"
        CheckOption "打包 $OUTPUT_NAME 失败"
    fi

    cd "$S_DIR"
    _elapsed $t_start
}

# ===== 增量更新 =====
function incr(){
    _detect_platform

    local t_start=$(date +%s)
    local label_flag=$1
    local version=$(grep '"version"' "$PKG" | awk -F '"' '{print $4}')

    local dist_dir="$S_DIR/dist/$BUILD_DIR"
    if [ ! -d "$dist_dir" ]; then
        Error "构建产物目录 $dist_dir 不存在，请先执行 build 或 pack"
        exit 1
    fi

    cd $S_DIR;
    # 仅生成标签文件
    if [ -n "$label_flag" ]; then
        find "./dist/$BUILD_DIR/" -type f | xargs md5sum | sort > "$LABEL_FILE"
        Info "已生成标签文件: $LABEL_FILE"
        _elapsed $t_start
        return 0
    fi

    # 增量对比
    local new_md5=$(find "./dist/$BUILD_DIR/" -type f | xargs md5sum | sort)
    if [ ! -f "$LABEL_FILE" ]; then
        Error "标签文件 $LABEL_FILE 不存在，请先用 'incr label' 生成"
        exit 1
    fi
    local old_md5=$(cat "$LABEL_FILE" | sort)

    if [ "$new_md5" == "$old_md5" ]; then
        Info "文件未变化"
        _elapsed $t_start
        return 0
    fi

    local incr_dir="./dist/incr"
    local diff_files=$(diff <(echo "$new_md5") <(echo "$old_md5") | grep "^< " | sed -r 's#.*\s\*?./dist#./dist#g')
    Info "文件有变化:\n$diff_files"

    local incr_tar_name="picsee.$version.${ARCH_TAG}.incr.tar.gz.zip"

    # 清理所有历史增量包及解包目录（用通配符，兼容版本号/架构变化导致的残留）
    rm -rf "$incr_dir" dist/picsee.*.incr.tar.gz.zip && mkdir -p "$incr_dir"
    CheckOption "创建增量目录失败"

    for file in $diff_files; do
        local abs_file=$(readlink -m "$file")
        local rel_path=${abs_file#$dist_dir/}
        local rel_dir=$(dirname "$rel_path")
        mkdir -p "$incr_dir/$rel_dir"
        CheckOption "创建增量目录失败"
        cp "$abs_file" "$incr_dir/$rel_path"
        CheckOption "复制文件失败"
    done

    Info "压缩增量文件到 $incr_tar_name"
    ( cd "$incr_dir" && tar -zcvf "../$incr_tar_name" * )
    CheckOption "压缩增量包失败"

    # 更新标签文件（md5 信息暂存到 dist 下）
    echo "$new_md5" > "dist/$LABEL_FILE"
    _elapsed $t_start
}

# ===== 清理 =====
function clean(){
    _detect_platform
    Info "开始清理 $S_DIR/dist 目录"
    rm -rf "$S_DIR/dist/$BUILD_DIR" "$S_DIR/dist/incr"
    rm -rf "$S_DIR/dist/$OUTPUT_NAME"*.zip "$S_DIR/dist/$OUTPUT_NAME"*.zip.[0-9][0-9][0-9]
    Info "清理完成"
}

# ===== Squash 并推送 =====
function push(){
    local t_start=$(date +%s)

    local branch=$(git rev-parse --abbrev-ref HEAD)
    Info "当前分支: $branch"

    git fetch origin "$branch"
    CheckOption "git fetch 失败"

    local ahead=$(git rev-list --count @{u}..HEAD 2>/dev/null)
    if [ $? -ne 0 ]; then
        Error "没有上游分支，请先设置 upstream"
        exit 1
    fi

    if [ "$ahead" -eq 0 ]; then
        Info "没有需要推送的提交"
        _elapsed $t_start
        return
    fi

    if [ "$ahead" -eq 1 ]; then
        Info "仅 1 个提交，直接推送..."
        git push origin "$branch"
        CheckOption "git push 失败"
        Info "推送成功"
        _elapsed $t_start
        return
    fi

    local messages=$(git log --reverse --format="- %s" @{u}..HEAD | awk '!seen[$0]++')

    echo ""
    echo "以下 $ahead 个提交将被 squash 为 1 个提交："
    echo "$messages"
    echo ""
    read -p "是否继续? (y/N): " confirm
    if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
        Info "已取消"
        _elapsed $t_start
        return
    fi

    Info "本地领先远程 ${ahead} 个提交，开始 squash..."

    git reset --soft HEAD~$ahead
    CheckOption "git reset 失败"

    local msg=$(echo "$messages"; echo "")
    git commit -e -m "$msg"
    CheckOption "git commit 失败"

    Info "Squash 完成，开始推送..."
    git push --force-with-lease origin "$branch"
    CheckOption "git push 失败"

    Info "推送成功"
    _elapsed $t_start
}

# ===== scp 同步到远程主机 =====
function sync(){
    local t_start=$(date +%s)
    local remote=$1
    local local_path=$2

    if [ -z "$remote" ]; then
        Error "远程主机信息为必传项。用法: ./dev.sh sync <[user@]host[:端口]:目录> [本地路径]（不传本地路径则同步 git 变更文件，含新增）"
        exit 1
    fi

    # 解析远程目标：[user@]host[:端口]:目录，端口默认 2222
    if [[ "$remote" =~ ^([^@:]+@)?([^:@]+)(:[0-9]+)?:(.+)$ ]]; then
        local user_prefix="${BASH_REMATCH[1]}"
        local host="${BASH_REMATCH[2]}"
        local port_spec="${BASH_REMATCH[3]}"
        local remote_dir="${BASH_REMATCH[4]}"
    else
        Error "远程目标格式错误（应为 [user@]host[:端口]:目录）: $remote"
        exit 1
    fi
    local port="${port_spec#:}"
    port="${port:-2222}"
    local scp_host="${user_prefix}${host}"

    # 未指定本地路径：同步 git 变更文件（修改 + 新增/未跟踪），已删除文件仅提示不传输
    if [ -z "$local_path" ]; then
        Info "未指定本地路径，同步 git 变更文件..."
        local files=()
        while IFS= read -r -d '' f; do
            # git ls-files --modified 会把已删除文件也算进去，工作树不存在的跳过
            if [ -e "$S_DIR/$f" ]; then
                files+=("$f")
            fi
        done < <(cd "$S_DIR" && git ls-files --modified --others --exclude-standard -z)

        if [ ${#files[@]} -eq 0 ]; then
            Info "没有 git 变更文件"
        else
            local del_count
            del_count=$(cd "$S_DIR" && git ls-files --deleted | wc -l)
            if [ "$del_count" -gt 0 ]; then
                Info "检测到 ${del_count} 个已删除文件（跳过，不在远程删除）"
            fi
            for f in "${files[@]}"; do
                # 不建目录，直接 scp：目标路径带上相对子目录（远程目录需已存在），~ 由远程 shell 展开
                Info "执行: scp -P $port -r \"$S_DIR/$f\" \"$scp_host:$remote_dir/$f\""
                scp -P "$port" -r "$S_DIR/$f" "$scp_host:$remote_dir/$f"
                CheckOption "scp 失败: $f"
            done
            Info "已同步 ${#files[@]} 个文件"
        fi
    else
        # 本地路径支持相对 S_DIR 的写法（如 dist/xxx.zip）
        local src="$local_path"
        if [ ! -e "$src" ] && [ -e "$S_DIR/$local_path" ]; then
            src="$S_DIR/$local_path"
        fi
        if [ ! -e "$src" ]; then
            Error "本地路径不存在: $local_path"
            exit 1
        fi

        Info "执行: scp -P $port -r \"$src\" \"$scp_host:$remote_dir\""
        scp -P "$port" -r "$src" "$scp_host:$remote_dir"
        CheckOption "scp 失败"
    fi

    Info "同步完成"
    _elapsed $t_start
}

# ===== 更新 changelog =====
function chg(){
    local t_start=$(date +%s)
    local t_stamp=$(date '+%Y-%m-%d %H:%M:%S')
    local changelog="$S_DIR/change_log.txt"

    # 检查上游分支（用于对比本地未推送的提交）
    local upstream
    upstream=$(cd "$S_DIR" && git rev-parse --abbrev-ref @{u} 2>/dev/null)
    if [ -z "$upstream" ]; then
        Error "没有上游分支，请先设置 upstream"
        exit 1
    fi
    Info "对比上游: $upstream"

    # 上次执行 chg 的时间（记录在change_log.txt首行标记中，人工调整后旧记录不会被重复追加）
    local last_time
    last_time=$(head -1 "$changelog" | sed -n 's/^<!-- chg: \([0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\} [0-9]\{2\}:[0-9]\{2\}:[0-9]\{2\}\) -->$/\1/p')

    # 获取范围内的提交记录（排除 merge 提交）：优先从上次执行时间开始；无记录时对比上游
    local new_entries
    if [ -n "$last_time" ]; then
        Info "从上次执行时间 $last_time 开始获取提交"
        new_entries=$(cd "$S_DIR" && git log --format="- %s" --no-merges --reverse --since="$last_time")
    else
        new_entries=$(cd "$S_DIR" && git log --format="- %s" --no-merges --reverse "@{u}..HEAD")
    fi

    if [ -z "$new_entries" ]; then
        Info "没有未推送的 git 提交记录"
        _elapsed $t_start
        return
    fi

    Info "发现新的提交记录："
    echo "$new_entries"

    # 将本次执行时间更新到change_log.txt首行标记（这些提交已纳入处理范围，人工调整后不再重复展示）
    if head -1 "$changelog" | grep -q '^<!-- chg: '; then
        sed -i "1c <!-- chg: $t_stamp -->" "$changelog"
    else
        sed -i "1i <!-- chg: $t_stamp -->" "$changelog"
    fi
    Info "已记录本次执行时间: $t_stamp"

    # 过滤掉已存在于 change_log.txt 中的条目，再插入到最新变更后
    local filtered=""
    while IFS= read -r entry; do
        if ! grep -qF -- "$entry" "$changelog" 2>/dev/null; then
            filtered="${filtered}${entry}"$'\n'
        fi
    done <<< "$new_entries"
    filtered=${filtered%$'\n'}

    if [ -z "$filtered" ]; then
        Info "所有条目均已存在，无需追加"
        _elapsed $t_start
        return
    fi

    Info "新增不重复的条目："
    echo "$filtered"

    # 追加到文件末尾：文件末尾无换行时补一个，避免新条目前出现多余空行
    if [ -s "$changelog" ] && [ -n "$(tail -c 1 "$changelog")" ]; then
        echo "" >> "$changelog"
    fi
    echo "$filtered" >> "$changelog"

    local count=$(echo "$filtered" | wc -l)
    Info "已追加 ${count} 条记录到 change_log.txt"
    _elapsed $t_start
}

# ===== 主入口 =====
case "$1" in
    new)
        incr_version "$2"
        ;;
    chg)
        chg
        ;;
    run)
        run
        ;;
    build)
        build
        ;;
    pack)
        pack
        ;;
    incr)
        incr "$2"
        ;;
    clean)
        clean
        ;;
    push)
        push
        ;;
    sync)
        sync "$2" "$3"
        ;;
    help|--help|-h)
        show_help
        ;;
    *)
        show_help
        exit 1
        ;;
esac