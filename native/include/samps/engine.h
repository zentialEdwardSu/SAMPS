#pragma once
#include <array>
#include <atomic>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <string>
#include <stdexcept>
#include <vector>
#include <nlohmann/json.hpp>

namespace samps {
using Json = nlohmann::json;
struct Error : std::runtime_error {
    std::string code;
    Error(std::string c, std::string message) : std::runtime_error(message), code(std::move(c)) {}
};
// Maps document pixels into the model input. YOLOE letterboxes (scale + offset);
// SAM 3 stretches to a square, so left/top are 0 and resized* equal the input size.
struct Geometry {
    int width = 0, height = 0, resizedWidth = 0, resizedHeight = 0, left = 0, top = 0;
    float scale = 1;
};
struct Instance {
    int id = 0, left = 0, top = 0, width = 0, height = 0;
    float confidence = 0, overlap = 0;
    int parts = 1;          // instances merged into this result ("current object" mode)
    bool refined = false;   // reshaped by the interactive head from add/exclude strokes
    bool detailed = false;  // edges re-predicted from a high-resolution crop
    float cleanupScale = 1; // mask cell area relative to a full-image mask cell (smaller after the detail pass)
    std::array<float, 4> box{};
    std::string label;
    std::vector<uint8_t> mask;  // cropped, row-major; 0/255, soft 0..255 edges after smoothing
    // Weak model evidence (logit above SupportLogit) over the same crop, 0/1. Lets gap closing
    // add only pixels the model nearly predicted. Empty means "same as mask"; cleared after smoothing.
    std::vector<uint8_t> support;
};
struct Tensor {
    std::vector<int64_t> shape;
    std::vector<float> data;
};
struct Session {
    uint64_t id = 0;
    Geometry geometry;
    std::vector<Tensor> features;  // cached image-encoder outputs, model specific
    std::vector<uint8_t> image;    // document RGBA (detail pass crops, edge-aware smoothing guide)
};
// The prompt buffer holds the "add" alpha plane, followed by an "exclude" plane when hasNegative is set.
// detail: in "current" mode, re-run the interactive head on a crop around the object for finer edges.
// smooth (0..1): contour smoothing and edge softness. expand (0..1): how far gaps are filled from
// weak model evidence. 0.5 is the default; both 0 returns the model's own mask.
struct SmoothParams { float smooth = .5f, expand = .5f; };
struct SegmentOptions {
    float confidence = .25f; bool currentOnly = true; int maxInstances = 100; bool hasNegative = false; bool detail = true;
    SmoothParams smoothing;
};

// lowVram: release the image encoder's GPU memory after every encode (each new image reopens
// it, a few seconds slower). optimization: overrides the bundle's DirectML graph optimization
// level ("disable", "basic", "extended", "all"); empty keeps the bundle's.
// inputSize: load the bundle's `variants.<N>` graphs (a smaller-input export sharing the same
// weights) instead of its native size; 0 keeps the native size.
struct LoadOptions { bool lowVram = false; std::string optimization; int inputSize = 0; };

namespace detail { class Model; }

class Engine {
public:
    Engine();
    ~Engine();
    // device: -2 auto (largest dedicated-memory DirectML adapter), -1 CPU, otherwise a DXGI adapter index.
    Json initialize(const std::filesystem::path& modelDirectory, int device = -2, bool allowUnvalidated = false,
                    const LoadOptions& load = {});
    std::shared_ptr<Session> prepareImage(const uint8_t* rgba, size_t length, int width, int height,
                                         const std::atomic_bool* cancelled = nullptr);
    std::vector<Instance> segment(const Session&, const uint8_t* prompt, size_t length,
                                  const SegmentOptions&, const std::atomic_bool* cancelled = nullptr);
    // Re-runs only the post-processing of the last segment() result with new smoothing; no inference.
    std::vector<Instance> resmooth(const Session&, uint64_t resultId, const SmoothParams&, const std::atomic_bool* cancelled = nullptr);
    // Identifies the last segment() result, for resmooth().
    uint64_t resultId() const { return resultId_; }
    // Destroys the ONNX Runtime sessions and every cached result, returning their GPU memory
    // (DirectML keeps its allocation arena until the session is destroyed). Sessions from
    // prepareImage() must be released by the caller. initialize() loads the model again.
    void unload();
    bool loaded() const { return static_cast<bool>(model_); }
    Json info() const { return info_; }
    Json promptDiagnostics() const { return promptDiagnostics_; }
    // Model input for the loaded bundle (CHW float). Requires initialize().
    std::vector<float> preprocess(const uint8_t* rgba, size_t length, int width, int height, Geometry& geometry) const;
    // YOLOE 80×80 visual-prompt grid for a letterbox geometry. Independent of the loaded model.
    std::vector<float> preparePrompt(const Geometry&, const uint8_t*, size_t length) const;
private:
    std::unique_ptr<detail::Model> model_;
    Json info_;
    mutable Json promptDiagnostics_;
    uint64_t nextSession_ = 1;
    int device_ = -1;
    bool gpuOnly_ = false;  // manifest "requiresGpu": never open or fall back to the CPU provider
    bool lowVram_ = false;
    // The last result before smoothing, with its prompt planes, so resmooth() can redo the finish.
    std::vector<Instance> raw_;
    std::vector<uint8_t> rawAdd_, rawExclude_;
    uint64_t rawSession_ = 0, resultId_ = 0;
    void fallBackToCpu(const Error& failure);
    std::vector<Instance> finish(const Session&, const SmoothParams&, const std::atomic_bool* cancelled);
};
Json describe(const Instance&);
void writeTensor(const std::filesystem::path&, const std::vector<float>&);
}
