#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成应用图标 icon.ico。

用法:
    python make_ico.py                           # res/icon.png -> res/icon.ico (默认)
    python make_ico.py -i src.png -o out.ico     # 指定输入输出
    python make_ico.py -s 16,32,48,256           # 自定义尺寸列表

依赖: Pillow
    pip install Pillow
"""
import argparse
import os
import struct


def make_ico(src, dst, sizes, pad_ratio=0.08):
    """将 PNG 转为多尺寸 ICO。pad_ratio 表示四周留白比例(0=不留)。"""
    from PIL import Image

    img = Image.open(src).convert('RGBA')
    w, h = img.size
    size = max(w, h)

    # 若 PNG 未留白，按 pad_ratio 预留一圈空白，避免小尺寸图标贴边
    pad = int(size * pad_ratio)
    canvas = size + 2 * pad
    full = Image.new('RGBA', (canvas, canvas), (0, 0, 0, 0))
    full.paste(img, (pad, pad))

    frames = []
    for s in sizes:
        frames.append(full.resize((s, s), Image.LANCZOS))

    full.save(dst, format='ICO', sizes=[(f.width, f.height) for f in frames])

    # 校验输出
    data = open(dst, 'rb').read()
    count = struct.unpack('<H', data[4:6])[0]
    frame_sizes = sorted({(f.width, f.height) for f in frames})
    return count, frame_sizes


def main():
    ap = argparse.ArgumentParser(description='PNG 转多尺寸 ICO')
    ap.add_argument('-i', '--input', default=os.path.join('res', 'icon.png'))
    ap.add_argument('-o', '--output', default=os.path.join('res', 'icon.ico'))
    ap.add_argument('-s', '--sizes', default='16,24,32,48,64,128,256',
                    help='逗号分隔的尺寸列表，默认 16,24,32,48,64,128,256')
    ap.add_argument('-p', '--pad', type=float, default=0.0,
                    help='四周留白比例，默认 0(图标本身已居中留白)')
    args = ap.parse_args()

    sizes = sorted({int(s) for s in args.sizes.split(',')})
    count, frame_sizes = make_ico(args.input, args.output, sizes, pad_ratio=args.pad)
    out_size = os.path.getsize(args.output)
    print(f'生成成功: {args.output}')
    print(f'  包含 {count} 个尺寸: {[s for _, s in frame_sizes]}')
    print(f'  大小: {out_size} bytes')


if __name__ == '__main__':
    main()