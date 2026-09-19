/*
 * picsee_raw - 直连 LibRaw 的 N-API 插件
 *
 * 提供三个同步导出：
 *   decode(filePath, { halfSize }) -> { data, width, height, colors, flip, librawVersion }
 *   metadata(filePath, { unpack }) -> { make, model, isoSpeed, shutter, aperture, focalLength, timestamp, flip }
 *   version()                      -> LibRaw 版本字符串
 *
 * 设计要点：
 *   - 只调用 LibRaw 的 C API（libraw_c_api.cpp），不依赖 lightdrift-libraw 之类的第三方封装
 *   - 除 half_size 外全部沿用 LibRaw 默认参数；尤其是默认 user_flip = -1，
 *     即由 LibRaw 按相机 EXIF 朝向把像素摆正（90°/270° 时宽高互换），
 *     与 util/raw-rotate.js 记录的既有朝向约定一致
 *   - metadata() 只做 identify，不解像素（unpack=true 时才解包补读 EXIF），供界面展示拍摄参数
 *   - 失败一律抛异常，由调用方捕获后降级（worker 走内嵌预览兜底，exif 展示则留空）
 *   - NAPI_VERSION=8：同一份 .node 既能被 Node 直接加载自测，也能被 Electron 22 加载
 */

#include <napi.h>

#include <cstddef>
#include <string>

#include "libraw/libraw.h"

namespace {

std::string DescribeError(int code) {
  const char *message = libraw_strerror(code);
  return message != nullptr ? std::string(message) : std::string("未知错误");
}

// LibRaw 的定长 char 数组不保证一定带结束符，按上限截断后构造 std::string
std::string BoundedString(const char *value, size_t maxLength) {
  size_t length = 0;
  while (length < maxLength && value[length] != '\0') {
    ++length;
  }
  return std::string(value, length);
}

// 读取可选布尔参数，类型不符或缺省时返回 false
bool BoolOption(const Napi::CallbackInfo &info, const char *name) {
  if (info.Length() > 1 && info[1].IsObject()) {
    Napi::Object options = info[1].As<Napi::Object>();
    if (options.Has(name) && options.Get(name).IsBoolean()) {
      return options.Get(name).As<Napi::Boolean>().Value();
    }
  }
  return false;
}

Napi::Error MakeError(Napi::Env env, const char *stage, int code) {
  return Napi::Error::New(env, std::string("LibRaw ") + stage + " 失败(" + std::to_string(code) + "): " +
                                   DescribeError(code));
}

// 按平台打开文件：Windows 走宽字符接口，避免非 ASCII（中文等）路径打不开
int OpenFile(libraw_data_t *raw, const std::string &utf8Path, const Napi::Value &value) {
#ifdef _WIN32
  static_assert(sizeof(wchar_t) == 2, "Windows 下 wchar_t 应为 UTF-16");
  const std::u16string utf16Path = value.As<Napi::String>().Utf16Value();
  return libraw_open_wfile(raw, reinterpret_cast<const wchar_t *>(utf16Path.c_str()));
#else
  (void)value;
  return libraw_open_file(raw, utf8Path.c_str());
#endif
}

Napi::Value Decode(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsString()) {
    throw Napi::TypeError::New(env, "decode(filePath, options): filePath 必须为字符串");
  }

  const std::string utf8Path = info[0].As<Napi::String>().Utf8Value();
  const bool halfSize = BoolOption(info, "halfSize");

  libraw_data_t *raw = libraw_init(0);
  if (raw == nullptr) {
    throw Napi::Error::New(env, "libraw_init 失败");
  }

  libraw_processed_image_t *image = nullptr;

  try {
    int code = OpenFile(raw, utf8Path, info[0]);
    if (code != LIBRAW_SUCCESS) {
      throw MakeError(env, "打开文件", code);
    }

    code = libraw_unpack(raw);
    if (code != LIBRAW_SUCCESS) {
      throw MakeError(env, "解包", code);
    }

    raw->params.half_size = halfSize ? 1 : 0;

    code = libraw_dcraw_process(raw);
    if (code != LIBRAW_SUCCESS) {
      throw MakeError(env, "处理", code);
    }

    int memError = LIBRAW_SUCCESS;
    image = libraw_dcraw_make_mem_image(raw, &memError);
    if (image == nullptr || memError != LIBRAW_SUCCESS) {
      throw MakeError(env, "生成内存图", memError);
    }
    if (image->type != LIBRAW_IMAGE_BITMAP) {
      throw Napi::Error::New(env, "LibRaw 返回的不是位图数据");
    }
    if (image->bits != 8) {
      throw Napi::Error::New(env, "LibRaw 返回的位深不是 8bit");
    }

    const size_t pixelBytes = static_cast<size_t>(image->width) * image->height * image->colors;
    if (image->data_size < pixelBytes) {
      throw Napi::Error::New(env, "LibRaw 返回的像素数据长度不足");
    }

    Napi::Object result = Napi::Object::New(env);
    result.Set("data", Napi::Buffer<uint8_t>::Copy(env, image->data, pixelBytes));
    result.Set("width", Napi::Number::New(env, static_cast<double>(image->width)));
    result.Set("height", Napi::Number::New(env, static_cast<double>(image->height)));
    result.Set("colors", Napi::Number::New(env, static_cast<double>(image->colors)));
    result.Set("flip", Napi::Number::New(env, static_cast<double>(raw->sizes.flip)));
    result.Set("librawVersion", Napi::String::New(env, libraw_version()));

    libraw_dcraw_clear_mem(image);
    image = nullptr;
    libraw_recycle(raw);
    libraw_close(raw);

    return result;
  } catch (...) {
    if (image != nullptr) {
      libraw_dcraw_clear_mem(image);
    }
    libraw_recycle(raw);
    libraw_close(raw);
    throw;
  }
}

Napi::Value ReadMetadata(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsString()) {
    throw Napi::TypeError::New(env, "metadata(filePath, options): filePath 必须为字符串");
  }

  const std::string utf8Path = info[0].As<Napi::String>().Utf8Value();
  // 默认只做 identify（读元数据，不解像素）；unpack=true 供“identify 没读到 EXIF”时补读
  const bool needUnpack = BoolOption(info, "unpack");

  libraw_data_t *raw = libraw_init(0);
  if (raw == nullptr) {
    throw Napi::Error::New(env, "libraw_init 失败");
  }

  try {
    int code = OpenFile(raw, utf8Path, info[0]);
    if (code != LIBRAW_SUCCESS) {
      throw MakeError(env, "打开文件", code);
    }

    if (needUnpack) {
      code = libraw_unpack(raw);
      if (code != LIBRAW_SUCCESS) {
        throw MakeError(env, "解包", code);
      }
    }

    Napi::Object result = Napi::Object::New(env);
    result.Set("make", Napi::String::New(env, BoundedString(raw->idata.make, sizeof(raw->idata.make))));
    result.Set("model", Napi::String::New(env, BoundedString(raw->idata.model, sizeof(raw->idata.model))));
    result.Set("isoSpeed", Napi::Number::New(env, static_cast<double>(raw->other.iso_speed)));
    result.Set("shutter", Napi::Number::New(env, static_cast<double>(raw->other.shutter)));
    result.Set("aperture", Napi::Number::New(env, static_cast<double>(raw->other.aperture)));
    result.Set("focalLength", Napi::Number::New(env, static_cast<double>(raw->other.focal_len)));
    result.Set("timestamp", Napi::Number::New(env, static_cast<double>(raw->other.timestamp)));
    result.Set("flip", Napi::Number::New(env, static_cast<double>(raw->sizes.flip)));

    libraw_recycle(raw);
    libraw_close(raw);

    return result;
  } catch (...) {
    libraw_recycle(raw);
    libraw_close(raw);
    throw;
  }
}

Napi::Value Version(const Napi::CallbackInfo &info) {
  return Napi::String::New(info.Env(), libraw_version());
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("decode", Napi::Function::New(env, Decode));
  exports.Set("metadata", Napi::Function::New(env, ReadMetadata));
  exports.Set("version", Napi::Function::New(env, Version));
  return exports;
}

}  // namespace

NODE_API_MODULE(picsee_raw, Init)