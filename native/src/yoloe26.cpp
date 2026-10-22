// YOLOE-26 visual-prompt segmentation on ONNX Runtime.
//
// image.onnx produces the six head tensors once per image; prompt.onnx runs SAVPE's prompt
// convolutions per scribble. Masked-softmax pooling, the contrastive dot product and mask
// assembly stay here so neither graph depends on the prompt (see tools/model_split.py).
#include "internal.h"
#include <algorithm>
#include <cmath>
#include <limits>

namespace samps::detail {
namespace {
constexpr int Size = 640, Grid = 80, Anchors = 8400, Embed = 512, Channels = 32;

std::vector<float> embedding(const Tensor& semantic, const Tensor& logits, const std::vector<float>& mask) {
    std::vector<float> result(Embed, 0.f);
    std::vector<float> weights(Grid * Grid);
    for (int group = 0; group < 16; ++group) {
        const float* scores = logits.data.data() + static_cast<size_t>(group) * Grid * Grid;
        float maximum = -std::numeric_limits<float>::infinity();
        for (int i = 0; i < Grid * Grid; ++i) if (mask[i] > 0) maximum = std::max(maximum, scores[i]);
        float sum = 0;
        for (int i = 0; i < Grid * Grid; ++i) sum += weights[i] = mask[i] > 0 ? std::exp(scores[i] - maximum) : 0.f;
        if (!(sum > 0) || !std::isfinite(sum)) throw Error("NUMERIC_ERROR", "Invalid visual prompt weights");
        for (int c = 0; c < Channels; ++c) {
            const float* feature = semantic.data.data() + static_cast<size_t>(group * Channels + c) * Grid * Grid;
            float value = 0;
            for (int i = 0; i < Grid * Grid; ++i) value += weights[i] * feature[i];
            result[group * Channels + c] = value / sum;
        }
    }
    double norm = 0;
    for (float value : result) norm += static_cast<double>(value) * value;
    norm = std::max(std::sqrt(norm), 1e-12);
    for (float& value : result) value = static_cast<float>(value / norm);
    return result;
}

void expectShape(const Tensor& tensor, std::initializer_list<int64_t> shape, const char* name) {
    if (tensor.shape != std::vector<int64_t>(shape)) throw Error("MODEL_VERSION", std::string("Unexpected YOLOE output shape: ") + name);
}

class Yoloe final : public Model {
public:
    Yoloe(std::filesystem::path directory, Json manifest)
        : directory_(std::move(directory)), manifest_(std::move(manifest)),
          resample_(resampleMode(manifest_, "bilinear")) {
        if (manifest_.value("inputSize", 0) != Size || manifest_.value("embeddingSize", 0) != Embed ||
            manifest_.value("maskChannels", 0) != Channels || manifest_.value("promptSize", 0) != Grid)
            throw Error("MODEL_VERSION", "Unsupported YOLOE bundle");
        classBias_ = manifest_.at("classBias").get<std::array<float, 3>>();
    }
    void open(int device) override {
        image_ = openSession(graphPath(directory_, manifest_, "image"), device, manifest_);
        prompt_ = openSession(graphPath(directory_, manifest_, "prompt"), device, manifest_);
    }
    // Prototypes are 160×160 over the 640 letterbox: one cell is 4 model pixels.
    double maskCell(const Geometry& g) const override { return 4.0 / g.scale; }
    Json describeModel() const override {
        return {{"modelName", manifest_.value("modelName", "YOLOE-26")}, {"modelScale", manifest_.value("modelScale", "x")},
                {"architecture", "yoloe26"}, {"promptKind", "visual"}, {"resample", resampleName(resample_)},
                {"promptSampling", "max-coverage-v1"}};
    }
    std::vector<float> preprocess(const uint8_t* rgba, size_t length, int width, int height, Geometry& g) const override {
        const size_t count = pixels(width, height);
        if (!rgba || length != count * 4) throw Error("BUFFER_SIZE", "Expected document-sized RGBA buffer");
        g.width = width; g.height = height;
        g.scale = std::min(Size / static_cast<float>(width), Size / static_cast<float>(height));
        g.resizedWidth = std::max(1, static_cast<int>(std::nearbyint(width * g.scale)));
        g.resizedHeight = std::max(1, static_cast<int>(std::nearbyint(height * g.scale)));
        g.left = (Size - g.resizedWidth) / 2; g.top = (Size - g.resizedHeight) / 2;
        std::vector<float> input(3 * Size * Size, 114.f);
        resampleComposite(rgba, width, height, g.resizedWidth, g.resizedHeight, resample_, input.data(), Size,
                          static_cast<size_t>(Size) * Size, g.left, g.top);
        for (float& value : input) value /= 255.f;
        return input;
    }
    std::vector<Tensor> encode(std::vector<float>& input) override {
        std::vector<Ort::Value> inputs;
        inputs.push_back(tensor(input.data(), input.size(), {1, 3, Size, Size}));
        auto outputs = run(*image_, {"image"}, inputs,
                           {"boxes", "regions", "coefficients", "prototypes", "semantic", "activation"});
        expectShape(outputs[0], {1, 4, Anchors}, "boxes");
        expectShape(outputs[1], {1, Embed, Anchors}, "regions");
        expectShape(outputs[2], {1, Channels, Anchors}, "coefficients");
        expectShape(outputs[3], {1, Channels, 160, 160}, "prototypes");
        expectShape(outputs[4], {1, Embed, Grid, Grid}, "semantic");
        expectShape(outputs[5], {1, 16, Grid, Grid}, "activation");
        return outputs;
    }
    // YOLOE's visual prompt has no negative input; exclude strokes are applied to the masks by Engine.
    std::vector<Instance> segment(const Session& session, const uint8_t* alpha, const uint8_t*, size_t length,
                                  const SegmentOptions& options, Json& diagnostics, const std::atomic_bool* cancel) override {
        const auto& g = session.geometry;
        auto mask = yoloePrompt(g, alpha, length, diagnostics);
        auto activation = session.features[5].data;  // ORT input buffers must be mutable
        std::vector<Ort::Value> inputs;
        inputs.push_back(tensor(activation.data(), activation.size(), {1, 16, Grid, Grid}));
        inputs.push_back(tensor(mask.data(), mask.size(), {1, 1, Grid, Grid}));
        diagnostics["modelInputAccepted"] = true;
        auto logits = run(*prompt_, {"activation", "mask"}, inputs, {"logits"}, cancel);
        diagnostics["promptGraphExecuted"] = true;
        auto pe = embedding(session.features[4], logits[0], mask);
        diagnostics["embeddingUsed"] = true;

        const float* boxes = session.features[0].data.data();
        const float* regions = session.features[1].data.data();
        const float* coeffs = session.features[2].data.data();
        const Tensor& proto = session.features[3];
        const int pw = static_cast<int>(proto.shape[3]), ph = static_cast<int>(proto.shape[2]);
        std::vector<std::pair<float, int>> candidates;
        float maximumConfidence = 0.f;
        for (int anchor = 0; anchor < Anchors; ++anchor) {
            float score = classBias_[anchor < 6400 ? 0 : anchor < 8000 ? 1 : 2];
            for (int c = 0; c < Embed; ++c) score += regions[static_cast<size_t>(c) * Anchors + anchor] * pe[c];
            score = 1.f / (1.f + std::exp(-score));
            maximumConfidence = std::max(maximumConfidence, score);
            if (score >= options.confidence) candidates.emplace_back(score, anchor);
        }
        std::sort(candidates.begin(), candidates.end(), [](auto a, auto b) { return a.first != b.first ? a.first > b.first : a.second < b.second; });
        diagnostics["maximumConfidence"] = maximumConfidence;
        diagnostics["confidenceThreshold"] = options.confidence;
        diagnostics["candidatesAboveThreshold"] = candidates.size();
        if (candidates.size() > static_cast<size_t>(options.maxInstances)) candidates.resize(options.maxInstances);

        std::vector<Instance> result;
        size_t promptCount = 0, resultBytes = 0;
        for (size_t i = 0; i < length; ++i) promptCount += alpha[i] > 0;
        std::vector<float> low(static_cast<size_t>(pw) * ph);
        std::vector<uint8_t> modelMask(Size * Size);
        for (auto [confidence, anchor] : candidates) {
            checkCancel(cancel);
            const int size = anchor < 6400 ? 80 : anchor < 8000 ? 40 : 20;
            const int start = size == 80 ? 0 : size == 40 ? 6400 : 8000, stride = Size / size;
            const int cell = anchor - start;
            const float cx = (cell % size + .5f) * stride, cy = (cell / size + .5f) * stride;
            std::array<float, 4> b{cx - boxes[anchor] * stride, cy - boxes[Anchors + anchor] * stride,
                                   cx + boxes[2 * Anchors + anchor] * stride, cy + boxes[3 * Anchors + anchor] * stride};
            // Upstream clips boxes before process_mask.
            for (float& value : b) value = std::clamp(value, 0.f, static_cast<float>(Size));
            Instance instance; instance.id = anchor; instance.confidence = confidence;
            instance.box = {std::clamp((b[0] - g.left) / g.scale, 0.f, static_cast<float>(g.width)),
                            std::clamp((b[1] - g.top) / g.scale, 0.f, static_cast<float>(g.height)),
                            std::clamp((b[2] - g.left) / g.scale, 0.f, static_cast<float>(g.width)),
                            std::clamp((b[3] - g.top) / g.scale, 0.f, static_cast<float>(g.height))};
            instance.left = static_cast<int>(std::floor(instance.box[0])); instance.top = static_cast<int>(std::floor(instance.box[1]));
            instance.width = static_cast<int>(std::ceil(instance.box[2])) - instance.left;
            instance.height = static_cast<int>(std::ceil(instance.box[3])) - instance.top;
            if (instance.width <= 0 || instance.height <= 0) continue;
            std::fill(low.begin(), low.end(), 0.f);
            for (int c = 0; c < Channels; ++c) {
                const float factor = coeffs[static_cast<size_t>(c) * Anchors + anchor];
                const float* channel = proto.data.data() + static_cast<size_t>(c) * pw * ph;
                for (size_t i = 0; i < low.size(); ++i) low[i] += factor * channel[i];
            }
            // Match process_mask: half-pixel bilinear upsample, threshold, then bbox crop.
            std::fill(modelMask.begin(), modelMask.end(), 0);
            for (int y = std::max(0, static_cast<int>(std::ceil(b[1]))); y < std::min(Size, static_cast<int>(std::ceil(b[3]))); ++y)
                for (int x = std::max(0, static_cast<int>(std::ceil(b[0]))); x < std::min(Size, static_cast<int>(std::ceil(b[2]))); ++x)
                    if (const float logit = bilinearSample(low.data(), pw, ph, (x + .5f) * pw / Size - .5f, (y + .5f) * ph / Size - .5f);
                        logit > SupportLogit)
                        modelMask[y * Size + x] = logit > 0 ? 255 : 1;  // 1 = weak support for gap closing
            const size_t maskBytes = static_cast<size_t>(instance.width) * instance.height;
            if (maskBytes > 400000000 - resultBytes) throw Error("RESULT_TOO_LARGE", "Masks exceed 400 MB; increase confidence");
            instance.mask.resize(maskBytes);
            instance.support.resize(maskBytes);
            size_t intersection = 0, nonzero = 0;
            for (int y = 0; y < instance.height; ++y) for (int x = 0; x < instance.width; ++x) {
                const int dx = x + instance.left, dy = y + instance.top;
                const int sx = std::min(Size - 1, g.left + dx * g.resizedWidth / g.width);
                const int sy = std::min(Size - 1, g.top + dy * g.resizedHeight / g.height);
                const uint8_t value = modelMask[sy * Size + sx];
                const bool on = value == 255;
                instance.mask[static_cast<size_t>(y) * instance.width + x] = on ? 255 : 0;
                instance.support[static_cast<size_t>(y) * instance.width + x] = value ? 1 : 0;
                nonzero += on;
                intersection += on && alpha[static_cast<size_t>(dy) * g.width + dx] > 0;
            }
            if (!nonzero) continue;
            instance.overlap = static_cast<float>(intersection) / std::max<size_t>(1, promptCount);
            resultBytes += maskBytes;
            result.push_back(std::move(instance));
        }
        return result;
    }
private:
    std::filesystem::path directory_;
    Json manifest_;
    Resample resample_;
    std::array<float, 3> classBias_{};
    std::unique_ptr<Ort::Session> image_, prompt_;
};
}

std::vector<float> yoloePrompt(const Geometry& g, const uint8_t* prompt, size_t length, Json& diagnostics) {
    if (!prompt || length != pixels(g.width, g.height)) throw Error("BUFFER_SIZE", "Expected document-sized prompt alpha");
    std::vector<float> out(Grid * Grid, 0.f);
    size_t legacyCells = 0, activeCells = 0;
    // Retain the original single-point sampler's count for comparison in the live diagnostics.
    for (int y = 0; y < Grid; ++y) for (int x = 0; x < Grid; ++x) {
        const int px = x * 8 - g.left, py = y * 8 - g.top;
        if (px < 0 || py < 0 || px >= g.resizedWidth || py >= g.resizedHeight) continue;
        const int sx = std::min(g.width - 1, px * g.width / g.resizedWidth);
        const int sy = std::min(g.height - 1, py * g.height / g.resizedHeight);
        if (prompt[static_cast<size_t>(sy) * g.width + sx] > 0) ++legacyCells;
    }
    // Mark every feature cell intersecting a painted source pixel's footprint.
    // Point sampling can miss an entire stroke when reducing a large canvas to 80x80.
    // Integer ratios also cover upscaled source pixels without rounding away edges.
    const int step = Size / Grid;
    const int64_t denominatorX = static_cast<int64_t>(g.width) * step;
    const int64_t denominatorY = static_cast<int64_t>(g.height) * step;
    for (int y = 0; y < g.height; ++y) for (int x = 0; x < g.width; ++x) {
        if (!prompt[static_cast<size_t>(y) * g.width + x]) continue;
        const int64_t left = static_cast<int64_t>(g.left) * g.width + static_cast<int64_t>(x) * g.resizedWidth;
        const int64_t top = static_cast<int64_t>(g.top) * g.height + static_cast<int64_t>(y) * g.resizedHeight;
        const int x0 = std::clamp(static_cast<int>(left / denominatorX), 0, Grid - 1);
        const int x1 = std::clamp(static_cast<int>((left + g.resizedWidth - 1) / denominatorX), 0, Grid - 1);
        const int y0 = std::clamp(static_cast<int>(top / denominatorY), 0, Grid - 1);
        const int y1 = std::clamp(static_cast<int>((top + g.resizedHeight - 1) / denominatorY), 0, Grid - 1);
        for (int gy = y0; gy <= y1; ++gy) for (int gx = x0; gx <= x1; ++gx) out[gy * Grid + gx] = 1.f;
    }
    const auto stats = alphaStats(prompt, g.width, g.height);
    std::string grid(Grid * Grid, '0');
    for (int i = 0; i < Grid * Grid; ++i) if (out[i] > 0) { grid[i] = '1'; ++activeCells; }
    diagnostics = Json::object();
    recordAlpha(stats, length, diagnostics);
    diagnostics.update({{"gridWidth", Grid}, {"gridHeight", Grid}, {"gridActiveCells", activeCells},
                        {"legacyPointSampleCells", legacyCells}, {"sampling", "max-coverage-v1"}, {"grid", grid},
                        {"modelInputAccepted", false}});
    if (!stats.painted || !activeCells) throw Error("EMPTY_PROMPT", "No painted pixels reached the visual prompt input");
    return out;
}

std::unique_ptr<Model> makeYoloe(const std::filesystem::path& directory, const Json& manifest) {
    return std::make_unique<Yoloe>(directory, manifest);
}
}
