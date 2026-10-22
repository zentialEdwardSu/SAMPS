// Mask post-processing: fragment removal, gap closing, contour smoothing and edge-aware softening.
//
// Model masks are 288×288 (SAM 3) or 160×160 (YOLOE) logits upsampled to the document, so their
// edges step in mask cells, thin necks break into gaps and stray detections leave fragments.
// smoothMask works in document pixels on a padded crop around one instance.
#include "internal.h"
#include <algorithm>
#include <cmath>
#include <limits>

namespace samps::detail {
namespace {
constexpr float Far = 1e20f;

// Squared Euclidean distance transform (Felzenszwalb & Huttenlocher) to the nearest pixel where
// `inside(i)` holds. Pixels with no such pixel get Far.
template <class Inside>
std::vector<float> distance2(int w, int h, Inside inside) {
    std::vector<float> d(static_cast<size_t>(w) * h);
    for (size_t i = 0; i < d.size(); ++i) d[i] = inside(i) ? 0.f : Far;
    const int n = std::max(w, h);
    std::vector<float> f(n), out(n);
    std::vector<double> z(n + 1);
    std::vector<int> v(n);
    auto pass = [&](int length) {
        int k = 0; v[0] = 0; z[0] = -1e300; z[1] = 1e300;
        auto meet = [&](int q, int p) {
            return ((f[q] + static_cast<double>(q) * q) - (f[p] + static_cast<double>(p) * p)) / (2.0 * (q - p));
        };
        for (int q = 1; q < length; ++q) {
            double s = meet(q, v[k]);
            while (s <= z[k]) { --k; s = meet(q, v[k]); }
            ++k; v[k] = q; z[k] = s; z[k + 1] = 1e300;
        }
        k = 0;
        for (int q = 0; q < length; ++q) {
            while (z[k + 1] < q) ++k;
            const double dq = q - v[k];
            out[q] = static_cast<float>(std::min<double>(Far, dq * dq + f[v[k]]));
        }
    };
    for (int x = 0; x < w; ++x) {
        for (int y = 0; y < h; ++y) f[y] = d[static_cast<size_t>(y) * w + x];
        pass(h);
        for (int y = 0; y < h; ++y) d[static_cast<size_t>(y) * w + x] = out[y];
    }
    for (int y = 0; y < h; ++y) {
        float* row = &d[static_cast<size_t>(y) * w];
        std::copy_n(row, w, f.begin());
        pass(w);
        std::copy_n(out.begin(), w, row);
    }
    return d;
}

// Morphological closing with a disc of radius r: dilate, then erode the dilation.
std::vector<uint8_t> close(const std::vector<float>& toForeground, int w, int h, double r) {
    const float r2 = static_cast<float>(r * r);
    const auto toOutside = distance2(w, h, [&](size_t i) { return toForeground[i] > r2; });
    std::vector<uint8_t> closed(toOutside.size());
    for (size_t i = 0; i < closed.size(); ++i) closed[i] = toOutside[i] > r2;
    return closed;
}

// Mean over a (2r+1)² window, clamped at the borders (counts only pixels inside the image).
std::vector<float> boxMean(const std::vector<float>& in, int w, int h, int r) {
    std::vector<float> horizontal(in.size()), out(in.size());
    for (int y = 0; y < h; ++y) {
        const float* row = &in[static_cast<size_t>(y) * w];
        double sum = 0; int count = 0;
        for (int x = 0; x < std::min(w, r); ++x) { sum += row[x]; ++count; }
        for (int x = 0; x < w; ++x) {
            if (x + r < w) { sum += row[x + r]; ++count; }
            if (x - r - 1 >= 0) { sum -= row[x - r - 1]; --count; }
            horizontal[static_cast<size_t>(y) * w + x] = static_cast<float>(sum / count);
        }
    }
    for (int x = 0; x < w; ++x) {
        double sum = 0; int count = 0;
        for (int y = 0; y < std::min(h, r); ++y) { sum += horizontal[static_cast<size_t>(y) * w + x]; ++count; }
        for (int y = 0; y < h; ++y) {
            if (y + r < h) { sum += horizontal[static_cast<size_t>(y + r) * w + x]; ++count; }
            if (y - r - 1 >= 0) { sum -= horizontal[static_cast<size_t>(y - r - 1) * w + x]; --count; }
            out[static_cast<size_t>(y) * w + x] = static_cast<float>(sum / count);
        }
    }
    return out;
}
}

void recrop(Instance& item, int x0, int y0, int x1, int y1) {
    const int nw = x1 - x0, nh = y1 - y0;
    auto crop = [&](const std::vector<uint8_t>& from) {
        std::vector<uint8_t> to(static_cast<size_t>(std::max(0, nw)) * std::max(0, nh), 0);
        for (int y = std::max(0, y0); y < std::min(item.height, y1); ++y)
            for (int x = std::max(0, x0); x < std::min(item.width, x1); ++x)
                to[static_cast<size_t>(y - y0) * nw + (x - x0)] = from[static_cast<size_t>(y) * item.width + x];
        return to;
    };
    item.mask = crop(item.mask);
    if (!item.support.empty()) item.support = crop(item.support);
    item.left += x0; item.top += y0; item.width = nw; item.height = nh;
    item.box = {static_cast<float>(item.left), static_cast<float>(item.top),
                static_cast<float>(item.left + nw), static_cast<float>(item.top + nh)};
}

void smoothMask(Instance& item, const Session& session, const uint8_t* add, double cell, const SmoothParams& params,
                SmoothStats& stats) {
    const auto& g = session.geometry;
    const double expand = std::clamp<double>(params.expand, 0, 1), smooth = std::clamp<double>(params.smooth, 0, 1);
    if (item.mask.empty() || !(cell > 0) || (expand <= 0 && smooth <= 0)) return;
    // Radii in document pixels. The sliders act quadratically so 0..0.5 gives fine control and
    // 0.5..1 reaches well beyond the default: at 0.5, gaps up to ~3 mask cells always close and
    // weakly predicted gaps up to ~8 cells fill; at 1, four times that.
    const double e2 = 4 * expand * expand, s2 = 4 * smooth * smooth;  // 1 at the default
    const double alwaysClose = 1.5 * e2 * cell, supportedClose = 4 * e2 * cell;
    const int smoothRadius = static_cast<int>(std::lround(.5 * s2 * cell));
    const int edgeRadius = smooth > 0 ? std::clamp(static_cast<int>(std::lround(s2 * cell)), 2, 64) : 0;
    // Fragments are judged at a fixed distance, independent of the sliders.
    const double fragmentDistance = std::max(2.0, 4.0 * cell);
    stats.closeRadius = std::max(stats.closeRadius, supportedClose);
    stats.edgeRadius = std::max(stats.edgeRadius, static_cast<double>(edgeRadius));

    // Pad the crop so dilation and filtering have room, clamped to the document.
    const int pad = static_cast<int>(std::ceil(std::max(supportedClose, fragmentDistance))) + 2 * smoothRadius + edgeRadius + 2;
    const int ex0 = std::max(0, item.left - pad) - item.left, ey0 = std::max(0, item.top - pad) - item.top;
    const int ex1 = std::min(g.width, item.left + item.width + pad) - item.left;
    const int ey1 = std::min(g.height, item.top + item.height + pad) - item.top;
    recrop(item, ex0, ey0, ex1, ey1);
    const int w = item.width, h = item.height;
    const size_t n = static_cast<size_t>(w) * h;
    auto addAt = [&](size_t i) {
        return add && add[static_cast<size_t>(i / w + item.top) * g.width + (i % w) + item.left] > 0;
    };

    // 1. Fragments: 8-connected pieces apart from the largest that no add stroke touches, are
    //    small next to it, and lie beyond the closing radius.
    std::vector<int32_t> label(n, -1);
    std::vector<size_t> sizes, stack;
    std::vector<uint8_t> touched;
    for (size_t start = 0; start < n; ++start) {
        if (label[start] >= 0 || !item.mask[start]) continue;
        const int32_t id = static_cast<int32_t>(sizes.size());
        size_t size = 0; bool touches = false;
        label[start] = id; stack.assign(1, start);
        while (!stack.empty()) {
            const size_t i = stack.back(); stack.pop_back();
            ++size; touches = touches || addAt(i);
            const int x = static_cast<int>(i % w), y = static_cast<int>(i / w);
            for (int dy = -1; dy <= 1; ++dy) for (int dx = -1; dx <= 1; ++dx) {
                const int nx = x + dx, ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                const size_t j = static_cast<size_t>(ny) * w + nx;
                if (label[j] < 0 && item.mask[j]) { label[j] = id; stack.push_back(j); }
            }
        }
        sizes.push_back(size); touched.push_back(touches);
    }
    if (sizes.empty()) return;
    const size_t largest = static_cast<size_t>(std::max_element(sizes.begin(), sizes.end()) - sizes.begin());
    if (sizes.size() > 1) {
        const auto toLargest = distance2(w, h, [&](size_t i) { return label[i] == static_cast<int32_t>(largest); });
        std::vector<float> nearest(sizes.size(), Far);
        for (size_t i = 0; i < n; ++i) if (label[i] >= 0) nearest[label[i]] = std::min(nearest[label[i]], toLargest[i]);
        std::vector<uint8_t> drop(sizes.size(), 0);
        const float far2 = static_cast<float>(fragmentDistance * fragmentDistance);
        for (size_t k = 0; k < sizes.size(); ++k)
            if (k != largest && !touched[k] && sizes[k] * 100 < sizes[largest] * 15 && nearest[k] > far2) { drop[k] = 1; ++stats.fragments; }
        for (size_t i = 0; i < n; ++i)
            if (label[i] >= 0 && drop[label[i]]) { item.mask[i] = 0; if (!item.support.empty()) item.support[i] = 0; }
    }

    // 2. Fill gaps: narrow ones by closing outright, wider ones (bites out of the rim, broken
    //    necks) only through weakly predicted pixels. Both are limited to what a closing fills:
    //    a closing never moves a convex outline outward, so the model's weak halo along the edge
    //    is never added, only gaps and concavities.
    const auto toMask = distance2(w, h, [&](size_t i) { return item.mask[i] > 0; });
    const auto closedSmall = close(toMask, w, h, alwaysClose);
    // Weak model evidence is not trusted on its own: it spreads into neighbouring objects (a face
    // next to a collar). It only lets the wider closing go further where the model nearly agreed.
    const auto closedLarge = close(toMask, w, h, supportedClose);
    std::vector<float> binary(n);
    for (size_t i = 0; i < n; ++i) {
        const bool on = item.mask[i] > 0;
        const bool viaSmall = closedSmall[i] > 0;
        const bool viaSupport = supportedClose > 0 && closedLarge[i] > 0 && supportAt(item, i);
        if (!on && (viaSmall || viaSupport)) { ++stats.closed; stats.supported += !viaSmall; }
        binary[i] = on || viaSmall || viaSupport ? 1.f : 0.f;
    }

    // The gap-filled mask before smoothing: the guided filter may restore what smoothing shaved
    // off, but never reach past it into a neighbouring object.
    const std::vector<float> filled = binary;
    // Upsampled logits miss the true edge by up to half a mask cell; the guide may reach that far out.
    const float reachOut2 = static_cast<float>(std::pow(.5 * cell, 2));
    const auto toFilled = distance2(w, h, [&](size_t i) { return filled[i] > 0; });
    // 3. Smooth the contour: two box blurs re-thresholded at one half remove cell-sized steps.
    if (smoothRadius > 0) {
        auto blurred = boxMean(boxMean(binary, w, h, smoothRadius), w, h, smoothRadius);
        for (size_t i = 0; i < n; ++i) binary[i] = blurred[i] >= .5f ? 1.f : 0.f;
    }
    if (edgeRadius == 0) {  // smoothing off: hard edges
        for (size_t i = 0; i < n; ++i) item.mask[i] = binary[i] > 0 ? 255 : 0;
        item.support.clear();
        trim(item);
        return;
    }

    // 4. Soft edges that follow the image: a fast guided filter (He & Sun 2015) with the document
    //    luma as the guide, computed at 1/s resolution and applied only in a band around the edge.
    const int s = std::max(1, edgeRadius / 3), lw = (w + s - 1) / s, lh = (h + s - 1) / s;
    const int lr = std::max(1, edgeRadius / s);
    std::vector<float> lowI(static_cast<size_t>(lw) * lh), lowP(lowI.size()), count(lowI.size());
    auto luma = [&](int x, int y) {
        const uint8_t* p = &session.image[(static_cast<size_t>(y + item.top) * g.width + x + item.left) * 4];
        const float a = p[3] / 255.f;  // composite over white, as the model input does
        return ((.299f * p[0] + .587f * p[1] + .114f * p[2]) * a + 255.f * (1 - a)) / 255.f;
    };
    for (int y = 0; y < h; ++y) for (int x = 0; x < w; ++x) {
        const size_t j = static_cast<size_t>(y / s) * lw + x / s;
        lowI[j] += luma(x, y); lowP[j] += binary[static_cast<size_t>(y) * w + x]; count[j] += 1;
    }
    std::vector<float> lowII(lowI.size()), lowIP(lowI.size());
    for (size_t j = 0; j < lowI.size(); ++j) {
        lowI[j] /= count[j]; lowP[j] /= count[j];
        lowII[j] = lowI[j] * lowI[j]; lowIP[j] = lowI[j] * lowP[j];
    }
    const auto mI = boxMean(lowI, lw, lh, lr), mP = boxMean(lowP, lw, lh, lr);
    const auto mII = boxMean(lowII, lw, lh, lr), mIP = boxMean(lowIP, lw, lh, lr);
    constexpr float Eps = 1e-3f;
    std::vector<float> a(lowI.size()), b(lowI.size()), contrast(lowI.size());
    for (size_t j = 0; j < a.size(); ++j) {
        const float variance = std::max(0.f, mII[j] - mI[j] * mI[j]);
        a[j] = (mIP[j] - mI[j] * mP[j]) / (variance + Eps);
        b[j] = mP[j] - a[j] * mI[j];
        // Where the image is flat the filter degrades to a box blur that erodes thin parts;
        // trust it only as far as the guide has an edge to follow.
        contrast[j] = variance / (variance + 4 * Eps);
    }
    const auto mA = boxMean(a, lw, lh, lr), mB = boxMean(b, lw, lh, lr), mC = boxMean(contrast, lw, lh, lr);
    // Band: pixels whose edgeRadius window holds both foreground and background.
    const auto band = boxMean(binary, w, h, edgeRadius);
    // One-pixel anti-aliasing for flat regions.
    const auto aliased = boxMean(binary, w, h, 1);
    int x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (int y = 0; y < h; ++y) {
        const float fy = std::clamp((y + .5f) / s - .5f, 0.f, lh - 1.f);
        for (int x = 0; x < w; ++x) {
            const size_t i = static_cast<size_t>(y) * w + x;
            float value = binary[i];
            if (band[i] > 0 && band[i] < 1) {
                const float fx = std::clamp((x + .5f) / s - .5f, 0.f, lw - 1.f);
                const float q = bilinearSample(mA.data(), lw, lh, fx, fy) * luma(x, y) + bilinearSample(mB.data(), lw, lh, fx, fy);
                // Slight contrast keeps the edge crisp while anti-aliased.
                const float guided = std::clamp((q - .5f) * 1.5f + .5f, 0.f, 1.f);
                const float k = bilinearSample(mC.data(), lw, lh, fx, fy);
                value = k * guided + (1 - k) * aliased[i];
                // Outside the gap-filled mask the guide may only anti-alias: a similar-looking
                // neighbour (a face beside a collar) would otherwise be absorbed.
                if (toFilled[i] > reachOut2) value = std::min(value, aliased[i]);
            }
            const uint8_t out = static_cast<uint8_t>(std::lround(value * 255));
            item.mask[i] = out;
            if (out) { x0 = std::min(x0, x); y0 = std::min(y0, y); x1 = std::max(x1, x); y1 = std::max(y1, y); }
        }
    }
    item.support.clear();
    if (x1 < 0) { item.mask.clear(); item.width = item.height = 0; return; }
    recrop(item, x0, y0, x1 + 1, y1 + 1);
}
}
