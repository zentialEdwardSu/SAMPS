// Development probe for mask post-processing with a real model bundle:
//   samps_edges <model-dir> <image.rgba> <strokes.alpha> <width> <height> <out-dir> [smooth,expand ...]
// Runs one recognition, then writes the merged mask for each slider setting as <out-dir>/s<smooth>_e<expand>.mask
// (width × height bytes) and prints the diagnostics.
#include "samps/engine.h"
#include <fstream>
#include <iostream>
#include <sstream>
#include <chrono>
#include <cstdlib>
#include <thread>
#include <cstdio>
#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <dxgi1_6.h>
#include <wrl/client.h>
#endif

namespace {
#ifdef _WIN32
// This process's video memory on the DXGI adapter `index`: {dedicated, shared} MB.
std::pair<double, double> videoMemory(int index) {
    Microsoft::WRL::ComPtr<IDXGIFactory1> factory;
    Microsoft::WRL::ComPtr<IDXGIAdapter1> adapter;
    Microsoft::WRL::ComPtr<IDXGIAdapter3> adapter3;
    if (index < 0 || FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory))) || FAILED(factory->EnumAdapters1(index, &adapter)) ||
        FAILED(adapter.As(&adapter3))) return {0, 0};
    DXGI_QUERY_VIDEO_MEMORY_INFO local{}, shared{};
    adapter3->QueryVideoMemoryInfo(0, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, &local);
    adapter3->QueryVideoMemoryInfo(0, DXGI_MEMORY_SEGMENT_GROUP_NON_LOCAL, &shared);
    return {local.CurrentUsage / 1048576.0, shared.CurrentUsage / 1048576.0};
}
#else
std::pair<double, double> videoMemory(int) { return {0, 0}; }
#endif
std::vector<uint8_t> bytes(const std::filesystem::path& path) {
    std::ifstream f(path, std::ios::binary);
    if (!f) throw std::runtime_error("Missing " + path.u8string());
    return {std::istreambuf_iterator<char>(f), {}};
}
}

int main(int argc, char** argv) try {
    if (argc < 7) throw std::runtime_error("Expected model-dir image.rgba strokes.alpha width height out-dir [smooth,expand ...]");
    const int w = std::stoi(argv[4]), h = std::stoi(argv[5]);
    const auto rgba = bytes(std::filesystem::u8path(argv[2])), alpha = bytes(std::filesystem::u8path(argv[3]));
    const auto out = std::filesystem::u8path(argv[6]);
    std::vector<samps::SmoothParams> settings;
    for (int i = 7; i < argc; ++i) {
        std::stringstream text(argv[i]); samps::SmoothParams p; char comma;
        text >> p.smooth >> comma >> p.expand;
        settings.push_back(p);
    }
    if (settings.empty()) settings = {{0, 0}, {.5f, .5f}, {1, 1}};
    // SAMPS_HOLD_SECONDS pauses after each stage so GPU memory counters can be sampled.
    const char* holdText = std::getenv("SAMPS_HOLD_SECONDS");
    const int hold = holdText ? std::atoi(holdText) : 0;
    int device = -1;
    auto stage = [&](const char* name) {
        if (hold > 0) std::this_thread::sleep_for(std::chrono::seconds(hold));
        const auto [dedicated, shared] = videoMemory(device);
        std::printf("STAGE %-18s dedicated %7.0f MB  shared %6.0f MB\n", name, dedicated, shared);
        std::fflush(stdout);
    };
    samps::Engine engine;
    // SAMPS_OPT overrides the graph optimization level; SAMPS_LOW_VRAM=1 enables low-VRAM mode.
    samps::LoadOptions load;
    if (const char* opt = std::getenv("SAMPS_OPT")) load.optimization = opt;
    if (const char* low = std::getenv("SAMPS_LOW_VRAM")) load.lowVram = std::string(low) == "1";
    // SAMPS_SIZE picks a smaller-input variant of the bundle (e.g. 672, 840).
    if (const char* size = std::getenv("SAMPS_SIZE")) load.inputSize = std::atoi(size);
    const auto loadStart = std::chrono::steady_clock::now();
    auto info = engine.initialize(std::filesystem::u8path(argv[1]), -2, true, load);
    std::printf("load %.0f ms, optimization %s, lowVram %d\n",
        std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - loadStart).count(),
        info.value("optimization", std::string()).c_str(), int(load.lowVram));
    device = info.value("device", -1);
    std::cout << "device " << info.value("deviceName", "") << '\n';
    stage("loaded");
    const auto encodeStart = std::chrono::steady_clock::now();
    auto session = engine.prepareImage(rgba.data(), rgba.size(), w, h);
    std::printf("encode %.0f ms\n", std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - encodeStart).count());
    stage("encoded");
    samps::SegmentOptions options;
    for (size_t k = 0; k < settings.size(); ++k) {
        const auto& p = settings[k];
        auto result = k == 0 ? (options.smoothing = p, engine.segment(*session, alpha.data(), alpha.size(), options))
                             : engine.resmooth(*session, engine.resultId(), p);
        std::vector<uint8_t> merged(static_cast<size_t>(w) * h, 0);
        size_t area = 0;
        for (const auto& item : result)
            for (int y = 0; y < item.height; ++y) for (int x = 0; x < item.width; ++x) {
                uint8_t& target = merged[static_cast<size_t>(y + item.top) * w + x + item.left];
                target = std::max(target, item.mask[static_cast<size_t>(y) * item.width + x]);
            }
        for (uint8_t v : merged) area += v >= 128;
        std::ostringstream name; name << "s" << p.smooth << "_e" << p.expand << ".mask";
        std::ofstream(out / name.str(), std::ios::binary).write(reinterpret_cast<const char*>(merged.data()), merged.size());
        auto d = engine.promptDiagnostics();
        std::cout << name.str() << " instances " << result.size() << " area " << area
                  << " rawMask " << d.value("rawMaskPixels", 0) << " rawSupport " << d.value("rawSupportPixels", 0)
                  << " cell " << d.value("maskCell", 0.0) << " close " << d.value("closeRadius", 0.0)
                  << " edge " << d.value("edgeRadius", 0.0) << " gap " << d.value("gapPixelsClosed", 0)
                  << " fromSupport " << d.value("gapPixelsFromSupport", 0) << " fragments " << d.value("fragmentsRemoved", 0)
                  << " refined " << d.value("refined", false) << " detailed " << d.value("detailed", false) << '\n';
    }
    stage("segmented");
    // A second image: in low-VRAM mode this includes reopening the encoder session.
    const auto secondStart = std::chrono::steady_clock::now();
    auto second = engine.prepareImage(rgba.data(), rgba.size(), w, h);
    std::printf("second encode %.0f ms\n", std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - secondStart).count());
    stage("second-encoded");
    second.reset();
    session.reset();
    stage("session-released");
    engine.unload();
    stage("unloaded");
    return 0;
} catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; }
