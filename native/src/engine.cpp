// Model-independent engine: bundle verification, device selection with CPU fallback,
// image sessions, prompt transfer diagnostics and "current object" selection.
#include "internal.h"
#include <algorithm>
#include <fstream>
#ifdef _WIN32
#include <windows.h>
#include <bcrypt.h>
#include <iomanip>
#include <sstream>
#endif

namespace samps {
namespace detail {
void checkCancel(const std::atomic_bool* flag) {
    if (flag && flag->load()) throw Error("CANCELLED", "Operation cancelled");
}
size_t pixels(int width, int height) {
    if (width < 1 || height < 1 || width > 30000 || height > 30000 ||
        static_cast<uint64_t>(width) * height > 100000000)
        throw Error("IMAGE_SIZE", "Image dimensions exceed the 100 megapixel limit");
    return static_cast<size_t>(width) * height;
}
AlphaStats alphaStats(const uint8_t* alpha, int width, int height) {
    AlphaStats s;
    s.minX = width; s.minY = height;
    for (int y = 0; y < height; ++y) for (int x = 0; x < width; ++x) {
        const uint8_t value = alpha[static_cast<size_t>(y) * width + x];
        s.checksum = (s.checksum ^ value) * 16777619u;
        if (!value) continue;
        ++s.painted;
        s.minX = std::min(s.minX, x); s.minY = std::min(s.minY, y);
        s.maxX = std::max(s.maxX, x); s.maxY = std::max(s.maxY, y);
    }
    return s;
}
void recordAlpha(const AlphaStats& s, size_t length, Json& d) {
    d["sourceBytes"] = length;
    d["sourcePaintedPixels"] = s.painted;
    d["alphaChecksum"] = s.checksum;
    d["sourceBounds"] = s.painted ? Json::array({s.minX, s.minY, s.maxX + 1, s.maxY + 1}) : Json::array();
}
Instance mergeInstances(std::vector<Instance>& parts) {
    if (parts.size() == 1) return std::move(parts.front());
    int x0 = parts[0].left, y0 = parts[0].top, x1 = x0 + parts[0].width, y1 = y0 + parts[0].height;
    float confidence = 0, overlap = 0;
    for (const auto& p : parts) {
        x0 = std::min(x0, p.left); y0 = std::min(y0, p.top);
        x1 = std::max(x1, p.left + p.width); y1 = std::max(y1, p.top + p.height);
        confidence = std::max(confidence, p.confidence);
        overlap += p.overlap;
    }
    Instance merged;
    merged.id = parts[0].id; merged.left = x0; merged.top = y0; merged.width = x1 - x0; merged.height = y1 - y0;
    merged.confidence = confidence; merged.overlap = std::min(1.f, overlap);
    merged.parts = static_cast<int>(parts.size());
    merged.box = {static_cast<float>(x0), static_cast<float>(y0), static_cast<float>(x1), static_cast<float>(y1)};
    merged.mask.assign(static_cast<size_t>(merged.width) * merged.height, 0);
    const bool support = std::any_of(parts.begin(), parts.end(), [](const auto& p) { return !p.support.empty(); });
    if (support) merged.support.assign(merged.mask.size(), 0);
    for (const auto& p : parts)
        for (int y = 0; y < p.height; ++y) {
            const size_t row = static_cast<size_t>(y) * p.width;
            const size_t target = static_cast<size_t>(y + p.top - y0) * merged.width + (p.left - x0);
            for (int x = 0; x < p.width; ++x) {
                merged.mask[target + x] |= p.mask[row + x];
                if (support) merged.support[target + x] |= supportAt(p, row + x) ? 1 : 0;
            }
        }
    return merged;
}

std::pair<size_t, size_t> cleanMask(Instance& item, size_t area) {
    if (!area || item.mask.empty()) return {0, 0};
    const int w = item.width, h = item.height;
    const size_t n = item.mask.size();
    std::vector<int32_t> label(n);
    std::vector<size_t> stack;
    struct Part { size_t size = 0; bool border = false; };
    // Labels connected components of foreground (8-connected) or background (4-connected) pixels.
    auto components = [&](bool foreground) {
        std::fill(label.begin(), label.end(), -1);
        std::vector<Part> parts;
        for (size_t start = 0; start < n; ++start) {
            if (label[start] >= 0 || (item.mask[start] > 0) != foreground) continue;
            const int32_t id = static_cast<int32_t>(parts.size());
            Part part;
            label[start] = id; stack.assign(1, start);
            while (!stack.empty()) {
                const size_t i = stack.back(); stack.pop_back();
                ++part.size;
                const int x = static_cast<int>(i % w), y = static_cast<int>(i / w);
                if (x == 0 || y == 0 || x == w - 1 || y == h - 1) part.border = true;
                for (int dy = -1; dy <= 1; ++dy) for (int dx = -1; dx <= 1; ++dx) {
                    if ((!dx && !dy) || (!foreground && dx && dy)) continue;
                    const int nx = x + dx, ny = y + dy;
                    if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                    const size_t j = static_cast<size_t>(ny) * w + nx;
                    if (label[j] < 0 && (item.mask[j] > 0) == foreground) { label[j] = id; stack.push_back(j); }
                }
            }
            parts.push_back(part);
        }
        return parts;
    };
    // Holes: background regions enclosed by the mask (not reaching the crop border, which is the mask's bbox).
    auto background = components(false);
    std::vector<uint8_t> fill(background.size(), 0);
    size_t holes = 0;
    for (size_t k = 0; k < background.size(); ++k)
        if (!background[k].border && background[k].size < area) { fill[k] = 1; ++holes; }
    for (size_t i = 0; i < n; ++i)
        if (!item.mask[i] && fill[label[i]]) { item.mask[i] = 255; if (!item.support.empty()) item.support[i] = 1; }
    // Islands: small foreground pieces apart from the largest one.
    auto foreground = components(true);
    size_t largest = 0;
    for (size_t k = 1; k < foreground.size(); ++k) if (foreground[k].size > foreground[largest].size) largest = k;
    std::vector<uint8_t> drop(foreground.size(), 0);
    size_t islands = 0;
    for (size_t k = 0; k < foreground.size(); ++k)
        if (k != largest && foreground[k].size < area) { drop[k] = 1; ++islands; }
    for (size_t i = 0; i < n; ++i)
        if (item.mask[i] && drop[label[i]]) { item.mask[i] = 0; if (!item.support.empty()) item.support[i] = 0; }
    trim(item);
    return {holes, islands};
}

void trim(Instance& item) {
    const int w = item.width, h = item.height;
    int x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (int y = 0; y < h; ++y) for (int x = 0; x < w; ++x) {
        const size_t i = static_cast<size_t>(y) * w + x;
        if (item.mask[i] || (!item.support.empty() && item.support[i])) {
            x0 = std::min(x0, x); y0 = std::min(y0, y); x1 = std::max(x1, x); y1 = std::max(y1, y);
        }
    }
    if (x1 >= 0 && (x0 > 0 || y0 > 0 || x1 < w - 1 || y1 < h - 1)) recrop(item, x0, y0, x1 + 1, y1 + 1);
}

void clearExcluded(Instance& item, const uint8_t* negative, int documentWidth, size_t& cleared) {
    for (int y = 0; y < item.height; ++y)
        for (int x = 0; x < item.width; ++x) {
            const size_t i = static_cast<size_t>(y) * item.width + x;
            if (!negative[static_cast<size_t>(y + item.top) * documentWidth + x + item.left]) continue;
            if (!item.support.empty()) item.support[i] = 0;
            if (item.mask[i]) { item.mask[i] = 0; ++cleared; }
        }
}

void finishInstances(std::vector<Instance>& result, const SegmentOptions& options, Json& diagnostics) {
    diagnostics["instancesBeforeCurrentFilter"] = result.size();
    if (options.currentOnly) {
        // Everything the add strokes meaningfully cover is part of the current object: a person
        // detected separately from their backpack, hat or jewellery is returned as one result.
        std::vector<Instance> covered;
        for (auto& item : result) if (item.overlap >= MergeOverlap) covered.push_back(std::move(item));
        if (covered.empty()) {
            // A thin stroke may only graze its object; keep the best-covered instance.
            auto best = std::max_element(result.begin(), result.end(), [](const auto& a, const auto& b) {
                return a.overlap != b.overlap ? a.overlap < b.overlap : a.confidence < b.confidence;
            });
            if (best != result.end() && best->overlap > 0) covered.push_back(std::move(*best));
        }
        diagnostics["mergedParts"] = covered.size();
        result.clear();
        if (!covered.empty()) result.push_back(mergeInstances(covered));
    }
    diagnostics["instancesReturned"] = result.size();
}
std::filesystem::path graphPath(const std::filesystem::path& directory, const Json& manifest, const char* graph) {
    const auto name = manifest.at("graphs").at(graph).get<std::string>();
    const auto path = std::filesystem::u8path(name);
    // Graph names come from model.json; keep them inside the bundle.
    if (path.has_parent_path() || path.is_absolute()) throw Error("MODEL_VERSION", "Graph paths must be bundle-relative");
    return directory / path;
}
}

namespace {
using namespace detail;

std::string fileHash(const std::filesystem::path& path) {
#ifdef _WIN32
    BCRYPT_ALG_HANDLE algorithm = nullptr; BCRYPT_HASH_HANDLE hash = nullptr;
    auto finish = [&] { if (hash) BCryptDestroyHash(hash); if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0); };
    try {
        if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0 ||
            BCryptCreateHash(algorithm, &hash, nullptr, 0, nullptr, 0, 0) < 0) throw Error("HASH_ERROR", "Cannot initialize SHA256");
        std::ifstream file(path, std::ios::binary);
        if (!file) throw Error("MODEL_MISSING", path.u8string());
        std::vector<char> buffer(1 << 20);
        while (file) {
            file.read(buffer.data(), buffer.size());
            if (file.gcount() && BCryptHashData(hash, reinterpret_cast<PUCHAR>(buffer.data()), static_cast<ULONG>(file.gcount()), 0) < 0)
                throw Error("HASH_ERROR", "Cannot hash model");
        }
        std::array<unsigned char, 32> digest{};
        if (BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0) < 0) throw Error("HASH_ERROR", "Cannot finish SHA256");
        std::ostringstream text;
        for (auto value : digest) text << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(value);
        finish(); return text.str();
    } catch (...) { finish(); throw; }
#else
    throw Error("UNSUPPORTED_PLATFORM", "This build requires Windows x64");
#endif
}

// Picks the DirectML adapter with the most dedicated memory, skipping software adapters.
int chooseDevice(const Json& adapters, int requested) {
    if (requested == -1) return -1;
    if (requested >= 0) {
        for (const auto& a : adapters) if (a.at("id") == requested) return requested;
        throw Error("DEVICE_MISSING", "Requested GPU adapter is unavailable");
    }
    int best = -1; uint64_t memory = 0;
    for (const auto& a : adapters) {
        if (a.value("software", false)) continue;
        const auto dedicated = a.value("dedicatedMemoryMB", uint64_t{0});
        if (dedicated > memory) { memory = dedicated; best = a.at("id"); }
    }
    return best;
}

std::string deviceName(const Json& adapters, int device) {
    for (const auto& a : adapters) if (a.at("id") == device) return a.value("name", "GPU");
    return "CPU";
}
}

Engine::Engine() = default;
Engine::~Engine() = default;

Json Engine::initialize(const std::filesystem::path& directory, int device, bool allowUnvalidated, const LoadOptions& load) {
    std::ifstream file(directory / "model.json");
    if (!file) throw Error("MODEL_MISSING", "Missing model.json");
    Json manifest;
    file >> manifest;
    // Input sizes this bundle offers: its native size plus validated variants.
    Json sizes = Json::array({manifest.value("inputSize", 0)});
    if (manifest.contains("variants"))
        for (const auto& [key, variant] : manifest.at("variants").items())
            if (allowUnvalidated || variant.value("validation", Json::object()).value("passed", false))
                sizes.push_back(variant.value("inputSize", 0));
    if (load.inputSize && load.inputSize != manifest.value("inputSize", 0)) {
        const auto key = std::to_string(load.inputSize);
        if (!manifest.contains("variants") || !manifest.at("variants").contains(key))
            throw Error("MODEL_VERSION", "This bundle has no " + key + " px variant");
        const Json& variant = manifest.at("variants").at(key);
        if (!allowUnvalidated && !variant.value("validation", Json::object()).value("passed", false))
            throw Error("MODEL_UNVALIDATED", "The " + key + " px variant has not passed validation");
        // A variant replaces the size-dependent fields; weights, hashes and settings stay the bundle's.
        for (const char* field : {"inputSize", "maskSize", "refineMaskSize", "graphs", "validation"})
            if (variant.contains(field)) manifest[field] = variant.at(field);
    }
    const std::string bundleOptimization = manifest.value("dmlOptimization", std::string("all"));
    if (!load.optimization.empty()) {
        static const std::array<const char*, 4> levels{"disable", "basic", "extended", "all"};
        if (std::find(levels.begin(), levels.end(), load.optimization) == levels.end())
            throw Error("INVALID_OPTIONS", "Unknown graph optimization level: " + load.optimization);
        manifest["dmlOptimization"] = load.optimization;
    }
    if (manifest.value("runtime", "") != "onnxruntime") throw Error("MODEL_VERSION", "Bundle is not an ONNX Runtime export");
    if (!allowUnvalidated && !manifest.at("validation").value("passed", false))
        throw Error("MODEL_UNVALIDATED", "Model parity gate has not passed; run the bundle's validation tool");
    for (const auto& [name, expected] : manifest.at("files").items()) {
        const auto path = std::filesystem::u8path(name);
        if (path.has_parent_path() || path.is_absolute()) throw Error("MODEL_VERSION", "Bundle file paths must be relative");
        if (fileHash(directory / path) != expected.get<std::string>())
            throw Error("MODEL_HASH", "Model checksum mismatch: " + name);
    }
    for (const char* graph : {"image", "prompt"})
        if (!manifest.at("files").contains(manifest.at("graphs").at(graph).get<std::string>()))
            throw Error("MODEL_HASH", std::string("Graph is not covered by the bundle hashes: ") + graph);
    const auto architecture = manifest.value("architecture", "");
    std::unique_ptr<detail::Model> model;
    if (architecture == "yoloe26-visual-split-onnx-v1") model = makeYoloe(directory, manifest);
    else if (architecture == "sam3.1-exemplar") model = makeSam3(directory, manifest);
    else throw Error("MODEL_VERSION", "Unsupported model architecture: " + architecture);

    const Json devices = adapters();
    const bool gpuOnly = manifest.value("requiresGpu", false);
    device = chooseDevice(devices, device);
    if (gpuOnly && device < 0)
        throw Error("GPU_REQUIRED", manifest.value("modelName", std::string("This model")) + " requires a DirectML GPU");
    std::string fallbackReason;
    try { model->open(device); } catch (const Error& error) {
        if (device < 0 || gpuOnly) throw;
        fallbackReason = error.what(); device = -1;
        model->open(device);
    }
    model_ = std::move(model);
    device_ = device;
    gpuOnly_ = gpuOnly;
    lowVram_ = load.lowVram;
    info_ = model_->describeModel();
    info_.update({{"device", device}, {"deviceName", deviceName(devices, device)}, {"devices", devices},
                  {"backend", device >= 0 ? "DirectML" : "CPU"}, {"precision", manifest.value("precision", "fp32")},
                  {"requiresGpu", gpuOnly}, {"lowVram", lowVram_}, {"inputSizes", sizes},
                  {"optimization", manifest.value("dmlOptimization", std::string("all"))},
                  {"bundleOptimization", bundleOptimization},
                  {"validationPassed", manifest.at("validation").value("passed", false)},
                  {"runtimeVersion", runtimeVersion()}});
    if (!fallbackReason.empty()) info_["fallbackReason"] = fallbackReason;
    return info_;
}

void Engine::unload() {
    model_.reset();
    raw_.clear(); raw_.shrink_to_fit();
    rawAdd_.clear(); rawAdd_.shrink_to_fit();
    rawExclude_.clear(); rawExclude_.shrink_to_fit();
    rawSession_ = 0;
    ++resultId_;  // invalidates any resmooth() of the old result
    promptDiagnostics_ = Json::object();
}

void Engine::fallBackToCpu(const Error& failure) {
    const std::string reason = failure.what();
    if (gpuOnly_) {
        // Keep out-of-memory / device-lost codes so the panel can suggest a lighter model.
        if (gpuFailure(failure.code)) throw Error(failure.code, reason);
        throw Error("GPU_REQUIRED", "GPU inference failed and this model does not run on the CPU: " + reason);
    }
    model_->open(-1);
    device_ = -1;
    info_["device"] = -1; info_["deviceName"] = "CPU"; info_["backend"] = "CPU"; info_["fallbackReason"] = reason;
}

std::vector<float> Engine::preprocess(const uint8_t* rgba, size_t length, int width, int height, Geometry& geometry) const {
    if (!model_) throw Error("NOT_INITIALIZED", "Initialize the model first");
    return model_->preprocess(rgba, length, width, height, geometry);
}

std::vector<float> Engine::preparePrompt(const Geometry& geometry, const uint8_t* alpha, size_t length) const {
    return yoloePrompt(geometry, alpha, length, promptDiagnostics_);
}

std::shared_ptr<Session> Engine::prepareImage(const uint8_t* rgba, size_t length, int width, int height, const std::atomic_bool* cancel) {
    if (!model_) throw Error("NOT_INITIALIZED", "Initialize the model first");
    checkCancel(cancel);
    auto session = std::make_shared<Session>();
    auto input = model_->preprocess(rgba, length, width, height, session->geometry);
    checkCancel(cancel);
    try { session->features = model_->encode(input); } catch (const Error& error) {
        // A failed pass can leave the encoder's GPU arena allocated; return it first.
        if (gpuFailure(error.code)) model_->releaseEncoder();
        if (device_ < 0 || error.code == "CANCELLED") throw;
        fallBackToCpu(error);
        session->features = model_->encode(input);
    }
    // Low-VRAM mode: drop the encoder's GPU arena now; the next image (or detail pass) reopens it.
    if (lowVram_) model_->releaseEncoder();
    checkCancel(cancel);
    session->image.assign(rgba, rgba + length);
    session->id = nextSession_++;
    return session;
}

std::vector<Instance> Engine::segment(const Session& session, const uint8_t* alpha, size_t length,
                                      const SegmentOptions& options, const std::atomic_bool* cancel) {
    promptDiagnostics_ = Json::object();
    if (!model_) throw Error("NOT_INITIALIZED", "Initialize the model first");
    if (!(options.confidence >= 0 && options.confidence <= 1) || options.maxInstances < 1 || options.maxInstances > 300)
        throw Error("INVALID_OPTIONS", "Invalid confidence or instance limit");
    checkCancel(cancel);
    // The buffer is the add plane, optionally followed by an exclude plane of the same size.
    const size_t plane = pixels(session.geometry.width, session.geometry.height);
    if (!alpha || length != plane * (options.hasNegative ? 2 : 1))
        throw Error("BUFFER_SIZE", "Expected document-sized prompt alpha");
    const uint8_t* negative = options.hasNegative ? alpha + plane : nullptr;
    std::vector<Instance> result;
    try { result = model_->segment(session, alpha, negative, plane, options, promptDiagnostics_, cancel); }
    catch (const Error& error) {
        if (device_ < 0 || (error.code != "INFERENCE_FAILED" && !gpuFailure(error.code))) throw;
        fallBackToCpu(error);
        result = model_->segment(session, alpha, negative, plane, options, promptDiagnostics_, cancel);
    }
    finishInstances(result, options, promptDiagnostics_);
    // Reshape the current object with the interactive head: pull in add strokes the detector
    // missed (accessories) and push out regions painted with the exclude brush.
    if (options.currentOnly && !result.empty()) {
        try { promptDiagnostics_["refined"] = model_->refine(session, result.front(), alpha, negative, promptDiagnostics_, cancel); }
        catch (const Error& error) {
            if (error.code == "CANCELLED" || error.code == "GPU_LOST") throw;
            promptDiagnostics_["refineError"] = error.what();  // keep the detector result
            if (error.code == "GPU_MEMORY") promptDiagnostics_["refineOutOfMemory"] = true;
        }
        if (options.detail) {
            try { promptDiagnostics_["detailed"] = model_->detail(session, result.front(), alpha, negative, promptDiagnostics_, cancel); }
            catch (const Error& error) {
                if (lowVram_ || gpuFailure(error.code)) model_->releaseEncoder();
                if (error.code == "CANCELLED" || error.code == "GPU_LOST") throw;
                promptDiagnostics_["detailError"] = error.what();  // keep the full-image result
                if (error.code == "GPU_MEMORY") promptDiagnostics_["detailOutOfMemory"] = true;
            }
            if (lowVram_) model_->releaseEncoder();  // the detail pass re-encodes a crop
        }
    }
    // Exclude strokes always win: clear any mask pixel painted with the exclude brush, before
    // cleanup (so excluded regions are not refilled as holes) and again after smoothing.
    size_t cleared = 0;
    if (negative) for (auto& item : result) clearExcluded(item, negative, session.geometry.width, cleared);
    // Remove pinholes and stray specks left by upsampling 288×288 logits and by merging parts.
    if (const double area = model_->cleanupArea(session.geometry); area >= 1) {
        size_t holes = 0, islands = 0;
        for (auto& item : result) {
            auto [h, i] = cleanMask(item, static_cast<size_t>(std::max(1.0, area * item.cleanupScale)));
            holes += h; islands += i;
        }
        promptDiagnostics_["cleanupArea"] = area;
        promptDiagnostics_["holesFilled"] = holes;
        promptDiagnostics_["islandsRemoved"] = islands;
    }
    if (negative) promptDiagnostics_["excludedPixelsCleared"] = cleared;
    checkCancel(cancel);
    // Keep the unsmoothed result so the panel's smoothing sliders can redo only the finish.
    raw_ = std::move(result);
    rawAdd_.assign(alpha, alpha + plane);
    if (negative) rawExclude_.assign(negative, negative + plane); else rawExclude_.clear();
    rawSession_ = session.id;
    ++resultId_;
    return finish(session, options.smoothing, cancel);
}

std::vector<Instance> Engine::resmooth(const Session& session, uint64_t resultId, const SmoothParams& params,
                                       const std::atomic_bool* cancel) {
    if (!model_) throw Error("NOT_INITIALIZED", "Initialize the model first");
    if (resultId != resultId_ || rawSession_ != session.id) throw Error("STALE_RESULT", "Recognize again before adjusting the edges");
    return finish(session, params, cancel);
}

// Close gaps, drop stray fragments and soften the edges along the image, on a copy of raw_.
std::vector<Instance> Engine::finish(const Session& session, const SmoothParams& params, const std::atomic_bool* cancel) {
    std::vector<Instance> result = raw_;
    const uint8_t* negative = rawExclude_.empty() ? nullptr : rawExclude_.data();
    const double cell = model_->maskCell(session.geometry);
    promptDiagnostics_["smoothing"] = {{"smooth", params.smooth}, {"expand", params.expand}};
    size_t maskPixels = 0, supportPixels = 0;
    for (const auto& item : result)
        for (size_t i = 0; i < item.mask.size(); ++i) { maskPixels += item.mask[i] > 0; supportPixels += supportAt(item, i); }
    promptDiagnostics_["rawMaskPixels"] = maskPixels;
    promptDiagnostics_["rawSupportPixels"] = supportPixels;
    promptDiagnostics_["maskCell"] = cell;
    if (cell > 0 && !session.image.empty()) {
        SmoothStats stats;
        for (auto& item : result) {
            smoothMask(item, session, rawAdd_.data(), cell * std::sqrt(item.cleanupScale), params, stats);
            checkCancel(cancel);
        }
        promptDiagnostics_["fragmentsRemoved"] = stats.fragments;
        promptDiagnostics_["gapPixelsClosed"] = stats.closed;
        promptDiagnostics_["gapPixelsFromSupport"] = stats.supported;
        promptDiagnostics_["closeRadius"] = stats.closeRadius;
        promptDiagnostics_["edgeRadius"] = stats.edgeRadius;
        // Exclude strokes win over gap filling too.
        size_t cleared = 0;
        if (negative) for (auto& item : result) clearExcluded(item, negative, session.geometry.width, cleared);
    }
    for (auto& item : result) item.support.clear();
    result.erase(std::remove_if(result.begin(), result.end(), [](const auto& x) { return x.mask.empty() ||
        std::none_of(x.mask.begin(), x.mask.end(), [](uint8_t v) { return v != 0; }); }), result.end());
    checkCancel(cancel);
    return result;
}

Json describe(const Instance& x) {
    Json value{{"id", x.id}, {"confidence", x.confidence}, {"overlap", x.overlap}, {"box", x.box},
               {"left", x.left}, {"top", x.top}, {"width", x.width}, {"height", x.height}};
    if (!x.label.empty()) value["label"] = x.label;
    if (x.parts > 1) value["parts"] = x.parts;
    if (x.refined) value["refined"] = true;
    if (x.detailed) value["detailed"] = true;
    return value;
}

void writeTensor(const std::filesystem::path& path, const std::vector<float>& data) {
    std::ofstream file(path, std::ios::binary);
    file.write(reinterpret_cast<const char*>(data.data()), static_cast<std::streamsize>(data.size() * sizeof(float)));
    if (!file) throw Error("FILE_WRITE", "Cannot write tensor");
}
}
