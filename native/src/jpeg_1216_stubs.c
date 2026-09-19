/*
 * libjpeg-turbo 3.x 支持运行时 8/12/16 位精度选择：jdmaster.c / jdtrans.c 会
 * 按 cinfo->data_precision 分派，其中 12/16 位路径调用 j12init_* / j16init_*。
 * 这些符号在树内没有定义 —— 官方构建是靠把整套 jd*.c 分别按 12/16 位再编译两遍
 * 得到的。本项目只做 8 位 JPEG 解码（LibRaw 的 embedded/lossy RAW 用 8 位），
 * 12/16 位是永远走不到的分支，因此这里提供同名空实现以满足链接。
 *
 * 若将来需要 12/16 位支持，应改为按 libjpeg-turbo 官方方式对 jd*.c 做多精度编译，
 * 而不是继续扩充这些 stub。
 */

#include <stdio.h>   /* jpeglib.h 的某些原型使用了 FILE* */
#include "jpeglib.h"

/* ---- 解码侧（j_d…, jdmaster.c/jdtrans.c 引用）---- */

void j12init_d_main_controller(j_decompress_ptr cinfo, int need_full_buffer) {
  (void)cinfo; (void)need_full_buffer;
}
void j16init_d_main_controller(j_decompress_ptr cinfo, int need_full_buffer) {
  (void)cinfo; (void)need_full_buffer;
}
void j12init_d_coef_controller(j_decompress_ptr cinfo, int need_full_buffer) {
  (void)cinfo; (void)need_full_buffer;
}
void j12init_d_post_controller(j_decompress_ptr cinfo, boolean need_full_buffer) {
  (void)cinfo; (void)need_full_buffer;
}
void j16init_d_post_controller(j_decompress_ptr cinfo, boolean need_full_buffer) {
  (void)cinfo; (void)need_full_buffer;
}
void j12init_d_diff_controller(j_decompress_ptr cinfo, int need_full_buffer) {
  (void)cinfo; (void)need_full_buffer;
}
void j16init_d_diff_controller(j_decompress_ptr cinfo, int need_full_buffer) {
  (void)cinfo; (void)need_full_buffer;
}
void j12init_inverse_dct(j_decompress_ptr cinfo) { (void)cinfo; }
void j12init_upsampler(j_decompress_ptr cinfo) { (void)cinfo; }
void j16init_upsampler(j_decompress_ptr cinfo) { (void)cinfo; }
void j12init_color_deconverter(j_decompress_ptr cinfo) { (void)cinfo; }
void j16init_color_deconverter(j_decompress_ptr cinfo) { (void)cinfo; }
void j12init_1pass_quantizer(j_decompress_ptr cinfo) { (void)cinfo; }
void j12init_2pass_quantizer(j_decompress_ptr cinfo) { (void)cinfo; }
void j12init_merged_upsampler(j_decompress_ptr cinfo) { (void)cinfo; }
void j12init_lossless_decompressor(j_decompress_ptr cinfo) { (void)cinfo; }
void j16init_lossless_decompressor(j_decompress_ptr cinfo) { (void)cinfo; }

/* ---- 编码侧（jc….c 引用）；本项目不编码，一并置空以防万一 ---- */

void j12init_c_main_controller(j_compress_ptr cinfo, int need_full_buffer) {
  (void)cinfo; (void)need_full_buffer;
}
void j16init_c_main_controller(j_compress_ptr cinfo, int need_full_buffer) {
  (void)cinfo; (void)need_full_buffer;
}
void j12init_c_prep_controller(j_compress_ptr cinfo, int need_full_buffer) {
  (void)cinfo; (void)need_full_buffer;
}
void j16init_c_prep_controller(j_compress_ptr cinfo, int need_full_buffer) {
  (void)cinfo; (void)need_full_buffer;
}
void j12init_c_coef_controller(j_compress_ptr cinfo, int need_full_buffer) {
  (void)cinfo; (void)need_full_buffer;
}
void j12init_c_diff_controller(j_compress_ptr cinfo, int need_full_buffer) {
  (void)cinfo; (void)need_full_buffer;
}
void j16init_c_diff_controller(j_compress_ptr cinfo, int need_full_buffer) {
  (void)cinfo; (void)need_full_buffer;
}
void j12init_color_converter(j_compress_ptr cinfo) { (void)cinfo; }
void j16init_color_converter(j_compress_ptr cinfo) { (void)cinfo; }
void j12init_downsampler(j_compress_ptr cinfo) { (void)cinfo; }
void j16init_downsampler(j_compress_ptr cinfo) { (void)cinfo; }
void j12init_forward_dct(j_compress_ptr cinfo) { (void)cinfo; }
void j12init_lossless_compressor(j_compress_ptr cinfo) { (void)cinfo; }
void j16init_lossless_compressor(j_compress_ptr cinfo) { (void)cinfo; }