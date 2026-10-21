#pragma once
// Private to samps_core. ONNX Runtime is loaded at run time (see runtime.cpp), so the
// C++ API must be initialized manually rather than through an import library.
#include "samps/engine.h"
#define ORT_API_MANUAL_INIT
#include <onnxruntime_cxx_api.h>
#include <initializer_list>

namespace samps::detail {
void checkCancel(const std::atomic_bool* flag);
size_t pixels(int width, int height);

// runtime.cpp
Ort::Env& environment();
std::string runtimeVersion();
Json adapters();
std::unique_ptr<Ort::Session> openSession(const std::filesystem::path& path, int device, const Json& manifest);
const OrtMemoryInfo* cpuMemory();
template <class T> Ort::Value tensor(T* data, size_t count, std::initializer_list<int64_t> shape) {
    const std::vector<int64_t> dims(shape);
    return Ort::Value::CreateTensor<T>(cpuMemory(), data, count, dims.data(), dims.size());
}
std::vector<Tensor> run(Ort::Session& session, const std::vector<const char*>& inputNames,
                        std::vector<Ort::Value>& inputs, const std::vector<const char*>& outputNames,
                        const std::atomic_bool* cancelled = nullptr);

// Transfer-check statistics shared by every prompt encoder. JS compares these with
// the bytes it sent (see NativeEngine.segment) before any result is trusted.
struct AlphaStats {
    size_t painted = 0;
    uint32_t checksum = 2166136261u;
    int minX = 0, minY = 0, maxX = -1, maxY = -1;
};
AlphaStats alphaStats(const uint8_t* alpha, int width, int height);
void recordAlpha(const AlphaStats&, size_t length, Json& diagnostics);

// resample.cpp
enum class Resample { Bilinear, Area };
Resample resampleMode(const Json& manifest, const char* fallback);
const char* resampleName(Resample);
// Composites RGBA over white and resizes it into three float planes (0..255) at (left, top).
void resampleComposite(const uint8_t* rgba, int width, int height, int outWidth, int outHeight, Resample mode,
                       float* planes, int stride, size_t planeSize, int left, int top);
float bilinearSample(const float* data, int width, int height, float x, float y);

class Model {
public:
    virtual ~Model() = default;
    virtual void open(int device) = 0;
    virtual std::vector<float> preprocess(const uint8_t* rgba, size_t length, int width, int height, Geometry&) const = 0;
    virtual std::vector<Tensor> encode(std::vector<float>& input) = 0;
    // alpha: "add" strokes; negative: "exclude" strokes or null. Both are document-sized planes of `length` bytes.
    virtual std::vector<Instance> segment(const Session&, const uint8_t* alpha, const uint8_t* negative, size_t length,
                                          const SegmentOptions&, Json& diagnostics, const std::atomic_bool* cancelled) = 0;
    virtual Json describeModel() const = 0;
    // Holes and islands smaller than this many document pixels are removed from every result
    // (SAM 3's fill_hole_area, in model mask cells, scaled to the document). 0 disables cleanup.
    virtual double cleanupArea(const Geometry&) const { return 0; }
    // Whether prepareImage should keep the document RGBA in the session (needed by detail()).
    virtual bool retainsImage() const { return false; }
    // Re-predicts the current object's edges from a crop encoded at full model resolution.
    // Returns false (leaving `current` unchanged) when unsupported or not worthwhile.
    virtual bool detail(const Session&, Instance& current, const uint8_t* add, const uint8_t* exclude,
                        Json& diagnostics, const std::atomic_bool* cancelled) {
        (void)current; (void)add; (void)exclude; (void)diagnostics; (void)cancelled;
        return false;
    }
    // "Current object" refinement with add/exclude strokes after merging. Returns false when the
    // model has no interactive head; `current` is left unchanged in that case.
    virtual bool refine(const Session&, Instance& current, const uint8_t* add, const uint8_t* exclude,
                        Json& diagnostics, const std::atomic_bool* cancelled) {
        (void)current; (void)add; (void)exclude; (void)diagnostics; (void)cancelled;
        return false;
    }
};
std::unique_ptr<Model> makeYoloe(const std::filesystem::path& directory, const Json& manifest);
std::unique_ptr<Model> makeSam3(const std::filesystem::path& directory, const Json& manifest);
std::vector<float> yoloePrompt(const Geometry&, const uint8_t* alpha, size_t length, Json& diagnostics);
// "Current object" mode: merges every instance the add strokes cover (a person and their bag, hat,
// jewellery) into one result, and records result counts.
void finishInstances(std::vector<Instance>& instances, const SegmentOptions&, Json& diagnostics);
Instance mergeInstances(std::vector<Instance>& parts);
// Fills enclosed holes and removes islands smaller than `area` pixels (the largest island is
// always kept), then re-crops the mask. Returns {holes filled, islands removed}.
std::pair<size_t, size_t> cleanMask(Instance&, size_t area);
// Fraction of add-stroke pixels an instance must cover to be merged into the current object.
constexpr float MergeOverlap = .05f;
std::filesystem::path graphPath(const std::filesystem::path& directory, const Json& manifest, const char* graph);
}
