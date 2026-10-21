// Image resampling shared by every model's preprocessing.
//
// "bilinear" reproduces the original ncnn from_pixels_resize behaviour (2-tap, aliases on
// large downscales). "area" averages every source pixel covered by an output pixel, which
// is what a 24 MP RAW reduced to 640 or 1008 pixels needs; tools/pipeline_eval.py measures
// the difference. The mode is a per-bundle manifest setting ("resample").
#include "internal.h"
#include <algorithm>
#include <cmath>

namespace samps::detail {
namespace {
inline float composite(const uint8_t* rgba, size_t i, int c) {
    const unsigned a = rgba[i * 4 + 3];
    return (rgba[i * 4 + c] * a + 255.f * (255 - a)) / 255.f;
}

// Per output column: first source column and fractional weights of the covered span.
struct Span { int first = 0; std::vector<float> weights; };
std::vector<Span> areaSpans(int source, int target) {
    std::vector<Span> spans(target);
    const double ratio = static_cast<double>(source) / target;
    for (int o = 0; o < target; ++o) {
        const double begin = o * ratio, end = std::min<double>(source, (o + 1) * ratio);
        Span& span = spans[o];
        span.first = static_cast<int>(std::floor(begin));
        const int last = std::min(source - 1, static_cast<int>(std::ceil(end)) - 1);
        double total = 0;
        for (int s = span.first; s <= last; ++s) {
            const double w = std::min<double>(s + 1, end) - std::max<double>(s, begin);
            span.weights.push_back(static_cast<float>(w));
            total += w;
        }
        for (float& w : span.weights) w = static_cast<float>(w / total);
    }
    return spans;
}
}

Resample resampleMode(const Json& manifest, const char* fallback) {
    const auto name = manifest.value("resample", std::string(fallback));
    if (name == "bilinear") return Resample::Bilinear;
    if (name == "area") return Resample::Area;
    throw Error("MODEL_VERSION", "Unknown resample mode: " + name);
}
const char* resampleName(Resample mode) { return mode == Resample::Area ? "area" : "bilinear"; }

float bilinearSample(const float* data, int w, int h, float x, float y) {
    x = std::clamp(x, 0.f, static_cast<float>(w - 1));
    y = std::clamp(y, 0.f, static_cast<float>(h - 1));
    const int x0 = static_cast<int>(x), y0 = static_cast<int>(y);
    const int x1 = std::min(x0 + 1, w - 1), y1 = std::min(y0 + 1, h - 1);
    const float dx = x - x0, dy = y - y0;
    return (data[y0 * w + x0] * (1 - dx) + data[y0 * w + x1] * dx) * (1 - dy)
         + (data[y1 * w + x0] * (1 - dx) + data[y1 * w + x1] * dx) * dy;
}

void resampleComposite(const uint8_t* rgba, int width, int height, int outWidth, int outHeight, Resample mode,
                       float* planes, int stride, size_t planeSize, int left, int top) {
    if (mode == Resample::Bilinear || (outWidth >= width && outHeight >= height)) {
        // Half-pixel centres, matching cv2.INTER_LINEAR and ncnn's resize.
        const float sx = static_cast<float>(width) / outWidth, sy = static_cast<float>(height) / outHeight;
        for (int y = 0; y < outHeight; ++y) {
            const float fy = std::clamp((y + .5f) * sy - .5f, 0.f, static_cast<float>(height - 1));
            const int y0 = static_cast<int>(fy), y1 = std::min(y0 + 1, height - 1);
            const float dy = fy - y0;
            for (int x = 0; x < outWidth; ++x) {
                const float fx = std::clamp((x + .5f) * sx - .5f, 0.f, static_cast<float>(width - 1));
                const int x0 = static_cast<int>(fx), x1 = std::min(x0 + 1, width - 1);
                const float dx = fx - x0;
                const size_t a = static_cast<size_t>(y0) * width + x0, b = static_cast<size_t>(y0) * width + x1;
                const size_t c = static_cast<size_t>(y1) * width + x0, d = static_cast<size_t>(y1) * width + x1;
                for (int ch = 0; ch < 3; ++ch) {
                    const float value = (composite(rgba, a, ch) * (1 - dx) + composite(rgba, b, ch) * dx) * (1 - dy)
                                      + (composite(rgba, c, ch) * (1 - dx) + composite(rgba, d, ch) * dx) * dy;
                    planes[ch * planeSize + static_cast<size_t>(y + top) * stride + x + left] = value;
                }
            }
        }
        return;
    }
    // Separable box filter: rows first into a float buffer, then columns.
    const auto columns = areaSpans(width, outWidth), rows = areaSpans(height, outHeight);
    std::vector<float> horizontal(static_cast<size_t>(height) * outWidth * 3);
    for (int y = 0; y < height; ++y)
        for (int x = 0; x < outWidth; ++x) {
            float sum[3] = {0, 0, 0};
            const Span& span = columns[x];
            for (size_t k = 0; k < span.weights.size(); ++k) {
                const size_t i = static_cast<size_t>(y) * width + span.first + k;
                for (int ch = 0; ch < 3; ++ch) sum[ch] += composite(rgba, i, ch) * span.weights[k];
            }
            for (int ch = 0; ch < 3; ++ch) horizontal[(static_cast<size_t>(y) * outWidth + x) * 3 + ch] = sum[ch];
        }
    for (int y = 0; y < outHeight; ++y) {
        const Span& span = rows[y];
        for (int x = 0; x < outWidth; ++x) {
            float sum[3] = {0, 0, 0};
            for (size_t k = 0; k < span.weights.size(); ++k) {
                const float* source = &horizontal[(static_cast<size_t>(span.first + k) * outWidth + x) * 3];
                for (int ch = 0; ch < 3; ++ch) sum[ch] += source[ch] * span.weights[k];
            }
            for (int ch = 0; ch < 3; ++ch) planes[ch * planeSize + static_cast<size_t>(y + top) * stride + x + left] = sum[ch];
        }
    }
}
}
