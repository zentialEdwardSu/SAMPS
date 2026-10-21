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
    std::vector<uint8_t> mask;  // cropped, row-major, values 0/255
};
struct Tensor {
    std::vector<int64_t> shape;
    std::vector<float> data;
};
struct Session {
    uint64_t id = 0;
    Geometry geometry;
    std::vector<Tensor> features;  // cached image-encoder outputs, model specific
    std::vector<uint8_t> image;    // document RGBA, kept only by models with a detail pass
};
// The prompt buffer holds the "add" alpha plane, followed by an "exclude" plane when hasNegative is set.
// detail: in "current" mode, re-run the interactive head on a crop around the object for finer edges.
struct SegmentOptions {
    float confidence = .25f; bool currentOnly = true; int maxInstances = 100; bool hasNegative = false; bool detail = true;
};

namespace detail { class Model; }

class Engine {
public:
    Engine();
    ~Engine();
    // device: -2 auto (largest dedicated-memory DirectML adapter), -1 CPU, otherwise a DXGI adapter index.
    Json initialize(const std::filesystem::path& modelDirectory, int device = -2, bool allowUnvalidated = false);
    std::shared_ptr<Session> prepareImage(const uint8_t* rgba, size_t length, int width, int height,
                                         const std::atomic_bool* cancelled = nullptr);
    std::vector<Instance> segment(const Session&, const uint8_t* prompt, size_t length,
                                  const SegmentOptions&, const std::atomic_bool* cancelled = nullptr);
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
    void fallBackToCpu(const std::string& reason);
};
Json describe(const Instance&);
void writeTensor(const std::filesystem::path&, const std::vector<float>&);
}
