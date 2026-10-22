// Synthetic checks for smoothMask: gap closing, fragment removal, stroke-kept accessories,
// soft edges that follow the image, and exclusion after smoothing. No model needed.
#include "internal.h"
#include <cmath>
#include <algorithm>
#include <iostream>

namespace {
using namespace samps;
void require(bool ok, const char* message) { if (!ok) throw std::runtime_error(message); }

constexpr int W = 240, H = 240, Cx = 110, Cy = 120, R = 60;
bool inDisc(int x, int y) { return (x - Cx) * (x - Cx) + (y - Cy) * (y - Cy) <= R * R; }
// A 30-pixel slot cut into the right rim, 30 px deep: wider than the unconditional closing
// (2 × 12 px) but within the supported one (2 × 32 px), like a bite out of a closed outline.
bool inNotch(int x, int y) { return x > 140 && y > 105 && y < 135; }

// Dark disc on white; the mask is the disc minus a wedge (a "gap"), plus extra pieces.
struct Fixture {
    Session session;
    Instance item;
    std::vector<uint8_t> add = std::vector<uint8_t>(static_cast<size_t>(W) * H, 0);
    Fixture(bool supportGap) {
        session.geometry = {W, H, 1008, 1008, 0, 0, 1.f};
        session.image.resize(static_cast<size_t>(W) * H * 4);
        for (int y = 0; y < H; ++y) for (int x = 0; x < W; ++x) {
            uint8_t* p = &session.image[(static_cast<size_t>(y) * W + x) * 4];
            // Without weak support the notch is a real gap: background in the image too.
            const bool gap = !supportGap && inNotch(x, y);
            const uint8_t v = inDisc(x, y) && !gap ? 40 : 230;
            p[0] = p[1] = p[2] = v; p[3] = 255;
        }
        item.left = 0; item.top = 0; item.width = W; item.height = H;
        item.mask.assign(static_cast<size_t>(W) * H, 0);
        item.support.assign(item.mask.size(), 0);
        for (int y = 0; y < H; ++y) for (int x = 0; x < W; ++x) {
            const size_t i = static_cast<size_t>(y) * W + x;
            // Blocky edge: the disc sampled on an 8-pixel grid, like an upsampled low-res mask.
            const bool blocky = inDisc(x / 8 * 8 + 4, y / 8 * 8 + 4);
            const bool notch = inNotch(x, y);
            item.mask[i] = blocky && !notch ? 255 : 0;
            item.support[i] = (blocky && !notch) || (notch && supportGap && inDisc(x, y)) ? 1 : 0;
        }
        // Far fragment (upper right) and a stroked accessory (left).
        for (int y = 10; y < 22; ++y) for (int x = 200; x < 214; ++x) item.mask[static_cast<size_t>(y) * W + x] = 255;
        for (int y = 200; y < 214; ++y) for (int x = 10; x < 24; ++x) {
            item.mask[static_cast<size_t>(y) * W + x] = 255;
            add[static_cast<size_t>(y) * W + x] = 255;
        }
        for (int y = 115; y < 125; ++y) for (int x = 100; x < 120; ++x) add[static_cast<size_t>(y) * W + x] = 255;
    }
    uint8_t at(int x, int y) const {
        const int ix = x - item.left, iy = y - item.top;
        if (ix < 0 || iy < 0 || ix >= item.width || iy >= item.height) return 0;
        return item.mask[static_cast<size_t>(iy) * item.width + ix];
    }
};
}

int main() try {
    {
        Fixture f(true);
        detail::SmoothStats stats;
        detail::smoothMask(f.item, f.session, f.add.data(), 8.0, {}, stats);
        require(f.item.support.empty(), "support should be cleared");
        require(f.at(155, 120) == 255, "supported notch was not closed");
        require(f.at(206, 16) == 0, "far fragment was not removed");
        require(f.at(16, 206) > 128, "stroked accessory was removed");
        require(f.at(Cx, Cy) == 255 && f.at(5, 5) == 0, "interior/exterior changed");
        require(stats.fragments == 1, "expected exactly one fragment");
        // Edges follow the disc: pixels just inside are on, just outside are off, and some are soft.
        size_t soft = 0, wrong = 0;
        for (int a = 0; a < 360; a += 5) {
            if (a <= 20 || a >= 340) continue;  // the rim slot is checked separately
            const double t = a * 3.14159265 / 180;
            const int ix = static_cast<int>(std::lround(Cx + (R - 3) * std::cos(t))), iy = static_cast<int>(std::lround(Cy + (R - 3) * std::sin(t)));
            const int ox = static_cast<int>(std::lround(Cx + (R + 3) * std::cos(t))), oy = static_cast<int>(std::lround(Cy + (R + 3) * std::sin(t)));
            wrong += f.at(ix, iy) < 128 || f.at(ox, oy) > 128;
            for (int d = -1; d <= 1; ++d) {
                const uint8_t v = f.at(static_cast<int>(std::lround(Cx + (R + d) * std::cos(t))), static_cast<int>(std::lround(Cy + (R + d) * std::sin(t))));
                soft += v > 0 && v < 255;
            }
        }
        require(wrong <= 2, "edge does not follow the image");
        require(soft > 20, "edge is not anti-aliased");
        std::cout << "closed " << stats.closed << " (support " << stats.supported << "), soft " << soft << ", wrong " << wrong << '\n';
    }
    {
        // Without weak support, a 30-pixel notch (> 3 cells) must stay open: real gaps survive.
        Fixture f(false);
        detail::SmoothStats stats;
        detail::smoothMask(f.item, f.session, f.add.data(), 8.0, {}, stats);
        require(f.at(155, 120) < 128, "unsupported wide gap was closed");
    }
    {
        // Exclusion after smoothing wins.
        Fixture f(true);
        detail::SmoothStats stats;
        detail::smoothMask(f.item, f.session, f.add.data(), 8.0, {}, stats);
        std::vector<uint8_t> exclude(static_cast<size_t>(W) * H, 0);
        for (int y = 100; y < 110; ++y) for (int x = 100; x < 110; ++x) exclude[static_cast<size_t>(y) * W + x] = 255;
        size_t cleared = 0;
        detail::clearExcluded(f.item, exclude.data(), W, cleared);
        require(cleared == 100 && f.at(105, 105) == 0, "exclusion after smoothing failed");
    }
    {
        // Both sliders at 0: the model's own mask, hard edges, no gap filling.
        Fixture f(true);
        const auto before = f.item.mask;
        detail::SmoothStats stats;
        detail::smoothMask(f.item, f.session, f.add.data(), 8.0, {0.f, 0.f}, stats);
        require(f.item.mask == before && f.item.width == W, "zero smoothing changed the mask");
    }
    {
        // Expand 0, smooth on: no gap filling, but soft edges.
        Fixture f(true);
        detail::SmoothStats stats;
        detail::smoothMask(f.item, f.session, f.add.data(), 8.0, {.5f, 0.f}, stats);
        require(f.at(155, 120) < 128, "expand 0 still filled the notch");
        require(stats.closed == 0, "expand 0 closed gaps");
        // Smooth 0, expand on: gaps filled, hard edges.
        Fixture g(true);
        detail::smoothMask(g.item, g.session, g.add.data(), 8.0, {0.f, .5f}, stats);
        require(g.at(145, 155) == 255, "smooth 0 lost gap filling");
        require(std::all_of(g.item.mask.begin(), g.item.mask.end(), [](uint8_t v) { return v == 0 || v == 255; }), "smooth 0 left soft edges");
    }
    {
        // ONNX Runtime / DirectML failure messages map to codes the panel acts on.
        using detail::failureCode;
        require(std::string(failureCode("D3D12 CreateCommittedResource failed: 0x8007000E", "X")) == "GPU_MEMORY", "E_OUTOFMEMORY");
        require(std::string(failureCode("bad allocation", "X")) == "GPU_MEMORY", "bad allocation");
        require(std::string(failureCode("\xe5\x86\x85\xe5\xad\x98\xe8\xb5\x84\xe6\xba\x90\xe4\xb8\x8d\xe8\xb6\xb3", "X")) == "GPU_MEMORY", "localized OOM");
        require(std::string(failureCode("Status Message: 887A0005 The GPU device instance has been suspended", "X")) == "GPU_LOST", "device removed");
        require(std::string(failureCode("Invalid input name: image", "INFERENCE_FAILED")) == "INFERENCE_FAILED", "other errors keep fallback");
    }
    std::cout << "postprocess: passed\n";
    return 0;
} catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; }
