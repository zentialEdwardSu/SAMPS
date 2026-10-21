// SAM 3.1 exemplar segmentation on ONNX Runtime (vision + geometry prompts only).
//
// image_encoder.onnx runs once per image (stretched to 1008×1008, normalized to [-1, 1]).
// prompt_decoder.onnx takes up to maxPrompts exemplar boxes: each connected scribble
// becomes one positive box. SAM 3 then returns every instance of that concept; "current"
// mode keeps the one that best covers the scribble (see finishInstances).
#include "internal.h"
#include <algorithm>
#include <cmath>
#include <numeric>

namespace samps::detail {
namespace {
constexpr int Size = 1008;

struct Box { float x0, y0, x1, y1; };

// 8-connected components of the painted alpha, as pixel bounding boxes, largest first.
std::vector<std::pair<size_t, Box>> components(const uint8_t* alpha, int width, int height) {
    std::vector<int> label(static_cast<size_t>(width) * height, -1);
    std::vector<std::pair<size_t, Box>> found;
    std::vector<int> stack;
    for (int y = 0; y < height; ++y) for (int x = 0; x < width; ++x) {
        const size_t start = static_cast<size_t>(y) * width + x;
        if (!alpha[start] || label[start] >= 0) continue;
        const int id = static_cast<int>(found.size());
        Box box{static_cast<float>(x), static_cast<float>(y), x + 1.f, y + 1.f};
        size_t area = 0;
        label[start] = id; stack.assign(1, static_cast<int>(start));
        while (!stack.empty()) {
            const size_t i = static_cast<size_t>(stack.back()); stack.pop_back();
            const int px = static_cast<int>(i % width), py = static_cast<int>(i / width);
            ++area;
            box.x0 = std::min(box.x0, static_cast<float>(px)); box.y0 = std::min(box.y0, static_cast<float>(py));
            box.x1 = std::max(box.x1, px + 1.f); box.y1 = std::max(box.y1, py + 1.f);
            for (int ny = std::max(0, py - 1); ny <= std::min(height - 1, py + 1); ++ny)
                for (int nx = std::max(0, px - 1); nx <= std::min(width - 1, px + 1); ++nx) {
                    const size_t j = static_cast<size_t>(ny) * width + nx;
                    if (alpha[j] && label[j] < 0) { label[j] = id; stack.push_back(static_cast<int>(j)); }
                }
        }
        found.push_back({area, box});
    }
    std::sort(found.begin(), found.end(), [](const auto& a, const auto& b) { return a.first > b.first; });
    return found;
}

float iou(const std::array<float, 4>& a, const std::array<float, 4>& b) {
    const float w = std::max(0.f, std::min(a[2], b[2]) - std::max(a[0], b[0]));
    const float h = std::max(0.f, std::min(a[3], b[3]) - std::max(a[1], b[1]));
    const float inter = w * h;
    const float uni = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
    return uni > 0 ? inter / uni : 0.f;
}

class Sam3 final : public Model {
public:
    Sam3(std::filesystem::path directory, Json manifest)
        : directory_(std::move(directory)), manifest_(std::move(manifest)), resample_(resampleMode(manifest_, "bilinear")) {
        if (manifest_.value("inputSize", 0) != Size || manifest_.value("resize", std::string()) != "stretch")
            throw Error("MODEL_VERSION", "Unsupported SAM 3 bundle");
        maxPrompts_ = manifest_.value("maxPrompts", 0);
        queries_ = manifest_.value("queries", 0);
        maskSize_ = manifest_.value("maskSize", 0);
        if (maxPrompts_ < 1 || queries_ < 1 || maskSize_ < 1) throw Error("MODEL_VERSION", "Incomplete SAM 3 manifest");
        nmsIou_ = manifest_.value("nmsIou", .7f);
        hasRefine_ = manifest_.at("graphs").contains("refine");
        refinePoints_ = manifest_.value("refinePoints", 20);
    }
    void open(int device) override {
        image_ = openSession(graphPath(directory_, manifest_, "image"), device, manifest_);
        prompt_ = openSession(graphPath(directory_, manifest_, "prompt"), device, manifest_);
        if (hasRefine_) refine_ = openSession(graphPath(directory_, manifest_, "refine"), device, manifest_);
    }
    // SAM 3's own post-processing fills holes up to fill_hole_area (16 cells of the 288×288
    // mask); the ONNX graphs stop before it, so apply the same area at document scale.
    double cleanupArea(const Geometry& g) const override {
        const double cells = manifest_.value("fillHoleArea", 16.0);
        return cells * (static_cast<double>(g.width) / maskSize_) * (static_cast<double>(g.height) / maskSize_);
    }
    bool retainsImage() const override { return hasRefine_; }

    // Detail pass: crop a square around the current object (plus margin) from the full-resolution
    // document, encode the crop at 1008×1008, and let the interactive head re-predict the mask from
    // a box, points sampled inside the current mask, the add/exclude strokes, and the current mask
    // as a dense prompt. On a 24 MP RAW a person often spans <30% of the frame, so the crop gives
    // the mask 3–10× more pixels across thin structures (straps, lanyards, hair).
    bool detail(const Session& session, Instance& current, const uint8_t* add, const uint8_t* exclude,
                Json& diagnostics, const std::atomic_bool* cancel) override {
        if (!refine_ || session.image.empty() || current.mask.empty()) return false;
        const auto& g = session.geometry;
        // Square crop, 15% margin, at least one model input wide, clamped to the document.
        const float margin = .15f * std::max(current.width, current.height);
        float side = std::max(current.width, current.height) + 2 * margin;
        side = std::min<float>(std::max<float>(side, Size), static_cast<float>(std::max(g.width, g.height)));
        const float cx = current.left + current.width / 2.f, cy = current.top + current.height / 2.f;
        int cw = std::min(g.width, static_cast<int>(std::ceil(side))), ch = std::min(g.height, static_cast<int>(std::ceil(side)));
        int left = std::clamp(static_cast<int>(std::floor(cx - cw / 2.f)), 0, g.width - cw);
        int top = std::clamp(static_cast<int>(std::floor(cy - ch / 2.f)), 0, g.height - ch);
        const double gain = std::max(static_cast<double>(g.width) / cw, static_cast<double>(g.height) / ch);
        diagnostics["detailCrop"] = Json::array({left, top, cw, ch});
        diagnostics["detailGain"] = gain;
        if (gain < 1.5) return false;  // the object already fills the frame; nothing to gain

        // Encode the crop.
        std::vector<uint8_t> crop(static_cast<size_t>(cw) * ch * 4);
        for (int y = 0; y < ch; ++y)
            std::copy_n(&session.image[(static_cast<size_t>(y + top) * g.width + left) * 4], static_cast<size_t>(cw) * 4,
                        &crop[static_cast<size_t>(y) * cw * 4]);
        Geometry cg;
        auto input = preprocess(crop.data(), crop.size(), cw, ch, cg);
        checkCancel(cancel);
        std::vector<Ort::Value> imageInputs;
        imageInputs.push_back(tensor(input.data(), input.size(), {1, 3, Size, Size}));
        auto feats = run(*image_, {"image"}, imageInputs, {"iembed", "ifeat0", "ifeat1"}, cancel);

        // Prompts in crop-model coordinates.
        const float sx = static_cast<float>(Size) / cw, sy = static_cast<float>(Size) / ch;
        const auto inCurrent = [&](int x, int y) {
            const int ix = x - current.left, iy = y - current.top;
            return ix >= 0 && iy >= 0 && ix < current.width && iy < current.height &&
                   current.mask[static_cast<size_t>(iy) * current.width + ix] > 0;
        };
        Geometry local{cw, ch, Size, Size, 0, 0, 1.f};
        const auto inside = cellCentres(local, [&](int x, int y) { return inCurrent(x + left, y + top); });
        const auto negative = exclude ? cellCentres(local, [&](int x, int y) {
            return exclude[static_cast<size_t>(y + top) * g.width + x + left] != 0; }) : std::vector<std::array<float, 3>>{};
        const auto strokes = cellCentres(local, [&](int x, int y) {
            return add[static_cast<size_t>(y + top) * g.width + x + left] != 0; });
        std::vector<float> points{(current.left - left) * sx, (current.top - top) * sy,
                                  (current.left + current.width - left) * sx, (current.top + current.height - top) * sy};
        std::vector<int64_t> labels{2, 3};
        const int budget = std::max(0, refinePoints_ - 2);
        const int negatives = std::min<int>(static_cast<int>(negative.size()), budget / 3);
        const int fromStrokes = std::min<int>(static_cast<int>(strokes.size()), (budget - negatives) / 2);
        auto take = [&](const std::vector<std::array<float, 3>>& from, int count, int64_t label) {
            for (int i = 0; i < count && i < static_cast<int>(from.size()); ++i) {
                points.push_back(from[i][0] * sx); points.push_back(from[i][1] * sy); labels.push_back(label);
            }
        };
        take(strokes, fromStrokes, 1);
        take(inside, budget - negatives - fromStrokes, 1);
        take(negative, negatives, 0);
        const int64_t count = static_cast<int64_t>(labels.size());

        // Current mask over the crop, as a dense prompt.
        std::vector<float> previous(static_cast<size_t>(maskSize_) * maskSize_);
        for (int y = 0; y < maskSize_; ++y) for (int x = 0; x < maskSize_; ++x) {
            const int dx = left + std::min(cw - 1, static_cast<int>((x + .5f) * cw / maskSize_));
            const int dy = top + std::min(ch - 1, static_cast<int>((y + .5f) * ch / maskSize_));
            previous[static_cast<size_t>(y) * maskSize_ + x] = inCurrent(dx, dy) ? 8.f : -8.f;
        }
        float hasMask = 1.f;
        std::vector<Ort::Value> inputs;
        for (auto& f : feats) {
            const auto& s = f.shape;
            inputs.push_back(tensor(f.data.data(), f.data.size(), {s[0], s[1], s[2], s[3]}));
        }
        inputs.push_back(tensor(points.data(), points.size(), {1, count, 2}));
        inputs.push_back(tensor(labels.data(), labels.size(), {1, count}));
        inputs.push_back(tensor(previous.data(), previous.size(), {1, 1, maskSize_, maskSize_}));
        inputs.push_back(tensor(&hasMask, 1, {1}));
        auto out = run(*refine_, {"iembed", "ifeat0", "ifeat1", "points", "point_labels", "mask_input", "has_mask"},
                       inputs, {"mask", "iou", "object_score"}, cancel);
        const float iou = out[1].data[0], objectScore = out[2].data[0];
        diagnostics["detailIoU"] = iou;
        diagnostics["detailObjectScore"] = objectScore;
        if (objectScore <= 0) return false;

        // Upsample the crop logits into document space. Outside the crop the mask cannot change.
        const float* logits = out[0].data.data();
        std::vector<uint8_t> detailed(static_cast<size_t>(cw) * ch, 0);
        size_t agree = 0, either = 0;
        for (int y = 0; y < ch; ++y) {
            const float fy = (y + .5f) * maskSize_ / ch - .5f;
            for (int x = 0; x < cw; ++x) {
                const bool on = bilinearSample(logits, maskSize_, maskSize_, (x + .5f) * maskSize_ / cw - .5f, fy) > 0;
                const bool before = inCurrent(x + left, y + top);
                detailed[static_cast<size_t>(y) * cw + x] = on ? 255 : 0;
                agree += on && before; either += on || before;
            }
            if ((y & 63) == 0) checkCancel(cancel);
        }
        // Guard: a crop prediction that disagrees badly with the full-image object is a different object.
        const double overlap = either ? static_cast<double>(agree) / either : 0;
        diagnostics["detailAgreement"] = overlap;
        if (overlap < .6) return false;

        int mx0 = g.width, my0 = g.height, mx1 = -1, my1 = -1;
        auto valueAt = [&](int x, int y) -> bool {
            if (x >= left && y >= top && x < left + cw && y < top + ch) return detailed[static_cast<size_t>(y - top) * cw + (x - left)] > 0;
            return inCurrent(x, y);
        };
        const int bx0 = std::min(left, current.left), by0 = std::min(top, current.top);
        const int bx1 = std::max(left + cw, current.left + current.width), by1 = std::max(top + ch, current.top + current.height);
        for (int y = by0; y < by1; ++y) for (int x = bx0; x < bx1; ++x)
            if (valueAt(x, y)) { mx0 = std::min(mx0, x); my0 = std::min(my0, y); mx1 = std::max(mx1, x); my1 = std::max(my1, y); }
        if (mx1 < 0) return false;
        Instance next = current;
        next.left = mx0; next.top = my0; next.width = mx1 - mx0 + 1; next.height = my1 - my0 + 1;
        next.box = {static_cast<float>(mx0), static_cast<float>(my0), mx1 + 1.f, my1 + 1.f};
        next.mask.assign(static_cast<size_t>(next.width) * next.height, 0);
        for (int y = 0; y < next.height; ++y) for (int x = 0; x < next.width; ++x)
            if (valueAt(x + mx0, y + my0)) next.mask[static_cast<size_t>(y) * next.width + x] = 255;
        next.detailed = true;
        // Hole/island cleanup now works in finer mask cells.
        next.cleanupScale = static_cast<float>(1.0 / (gain * gain));
        current = std::move(next);
        return true;
    }

    bool refine(const Session& session, Instance& current, const uint8_t* add, const uint8_t* exclude,
                Json& diagnostics, const std::atomic_bool* cancel) override {
        if (!refine_ || session.features.size() < 6) return false;
        const auto& g = session.geometry;
        const auto inCurrent = [&](int x, int y) {
            const int cx = x - current.left, cy = y - current.top;
            return cx >= 0 && cy >= 0 && cx < current.width && cy < current.height &&
                   current.mask[static_cast<size_t>(cy) * current.width + cx] > 0;
        };
        // Add-stroke pixels outside the current mask are what the detector missed (a bag, a hat).
        const auto missed = cellCentres(g, [&](int x, int y) { return add[static_cast<size_t>(y) * g.width + x] && !inCurrent(x, y); });
        const auto inside = cellCentres(g, [&](int x, int y) { return add[static_cast<size_t>(y) * g.width + x] && inCurrent(x, y); });
        const auto negative = exclude ? cellCentres(g, [&](int x, int y) { return exclude[static_cast<size_t>(y) * g.width + x] != 0; })
                                      : std::vector<std::array<float, 3>>{};
        diagnostics["refineMissedCells"] = missed.size();
        diagnostics["refineExcludeCells"] = negative.size();
        if (missed.empty() && negative.empty()) return false;  // nothing for the interactive head to change

        // Box around the current object plus the missed strokes; SAM expects it as the first two points.
        float x0 = static_cast<float>(current.left), y0 = static_cast<float>(current.top);
        float x1 = static_cast<float>(current.left + current.width), y1 = static_cast<float>(current.top + current.height);
        for (const auto& p : missed) { x0 = std::min(x0, p[0]); y0 = std::min(y0, p[1]); x1 = std::max(x1, p[0] + 1); y1 = std::max(y1, p[1] + 1); }
        const float sx = static_cast<float>(Size) / g.width, sy = static_cast<float>(Size) / g.height;
        std::vector<float> points{x0 * sx, y0 * sy, x1 * sx, y1 * sy};
        std::vector<int64_t> labels{2, 3};
        const int budget = std::max(0, refinePoints_ - 2);
        const int negatives = std::min<int>(static_cast<int>(negative.size()), budget / 3);
        int positives = budget - negatives;
        auto take = [&](const std::vector<std::array<float, 3>>& from, int count, int64_t label) {
            for (int i = 0; i < count && i < static_cast<int>(from.size()); ++i) {
                points.push_back(from[i][0] * sx); points.push_back(from[i][1] * sy); labels.push_back(label);
            }
        };
        const int fromMissed = std::min<int>(static_cast<int>(missed.size()), positives);
        take(missed, fromMissed, 1);
        take(inside, std::min(positives - fromMissed, 4), 1);
        take(negative, negatives, 0);
        const int64_t count = static_cast<int64_t>(labels.size());

        // The merged mask, resampled to the head's 288×288 input, as confident logits.
        std::vector<float> previous(static_cast<size_t>(maskSize_) * maskSize_);
        for (int y = 0; y < maskSize_; ++y) for (int x = 0; x < maskSize_; ++x) {
            const int dx = std::min(g.width - 1, static_cast<int>((x + .5f) * g.width / maskSize_));
            const int dy = std::min(g.height - 1, static_cast<int>((y + .5f) * g.height / maskSize_));
            previous[static_cast<size_t>(y) * maskSize_ + x] = inCurrent(dx, dy) ? 8.f : -8.f;
        }
        float hasMask = 1.f;
        std::array<std::vector<float>, 3> feats;  // ORT input buffers must be mutable
        std::vector<Ort::Value> inputs;
        for (int i = 0; i < 3; ++i) {
            feats[i] = session.features[3 + i].data;
            const auto& s = session.features[3 + i].shape;
            inputs.push_back(tensor(feats[i].data(), feats[i].size(), {s[0], s[1], s[2], s[3]}));
        }
        inputs.push_back(tensor(points.data(), points.size(), {1, count, 2}));
        inputs.push_back(tensor(labels.data(), labels.size(), {1, count}));
        inputs.push_back(tensor(previous.data(), previous.size(), {1, 1, maskSize_, maskSize_}));
        inputs.push_back(tensor(&hasMask, 1, {1}));
        auto out = run(*refine_, {"iembed", "ifeat0", "ifeat1", "points", "point_labels", "mask_input", "has_mask"},
                       inputs, {"mask", "iou", "object_score"}, cancel);
        const float iou = out[1].data[0], objectScore = out[2].data[0];
        diagnostics["refinePoints"] = count;
        diagnostics["refineIoU"] = iou;
        diagnostics["refineObjectScore"] = objectScore;
        if (objectScore <= 0) return false;  // the head sees no object here; keep the detector result

        // With exclude strokes the refined mask replaces the result (it may drop background);
        // with add strokes only, it can only grow the merged object.
        const bool replace = !negative.empty();
        const float* logits = out[0].data.data();
        int mx0 = g.width, my0 = g.height, mx1 = -1, my1 = -1;
        std::vector<uint8_t> full(static_cast<size_t>(g.width) * g.height, 0);
        for (int y = 0; y < g.height; ++y) {
            const float fy = (y + .5f) * maskSize_ / g.height - .5f;
            for (int x = 0; x < g.width; ++x) {
                const bool on = bilinearSample(logits, maskSize_, maskSize_, (x + .5f) * maskSize_ / g.width - .5f, fy) > 0 ||
                                (!replace && inCurrent(x, y));
                if (!on) continue;
                full[static_cast<size_t>(y) * g.width + x] = 255;
                mx0 = std::min(mx0, x); my0 = std::min(my0, y); mx1 = std::max(mx1, x); my1 = std::max(my1, y);
            }
            if ((y & 63) == 0) checkCancel(cancel);
        }
        if (mx1 < 0) return false;
        current.left = mx0; current.top = my0; current.width = mx1 - mx0 + 1; current.height = my1 - my0 + 1;
        current.box = {static_cast<float>(mx0), static_cast<float>(my0), mx1 + 1.f, my1 + 1.f};
        current.mask.assign(static_cast<size_t>(current.width) * current.height, 0);
        for (int y = 0; y < current.height; ++y)
            std::copy_n(&full[static_cast<size_t>(y + my0) * g.width + mx0], current.width,
                        &current.mask[static_cast<size_t>(y) * current.width]);
        current.refined = true;
        return true;
    }
    Json describeModel() const override {
        return {{"modelName", manifest_.value("modelName", "SAM 3.1")}, {"architecture", "sam3"},
                {"promptKind", "visual"}, {"resample", resampleName(resample_)}, {"promptSampling", "component-boxes-v1"},
                {"maxPrompts", maxPrompts_}};
    }
    std::vector<float> preprocess(const uint8_t* rgba, size_t length, int width, int height, Geometry& g) const override {
        const size_t count = pixels(width, height);
        if (!rgba || length != count * 4) throw Error("BUFFER_SIZE", "Expected document-sized RGBA buffer");
        g = {width, height, Size, Size, 0, 0, 1.f};
        std::vector<float> input(3 * static_cast<size_t>(Size) * Size);
        resampleComposite(rgba, width, height, Size, Size, resample_, input.data(), Size, static_cast<size_t>(Size) * Size, 0, 0);
        for (float& value : input) value = (value - 127.5f) / 127.5f;
        return input;
    }
    std::vector<Tensor> encode(std::vector<float>& input) override {
        std::vector<Ort::Value> inputs;
        inputs.push_back(tensor(input.data(), input.size(), {1, 3, Size, Size}));
        // The interactive neck outputs (iembed, ifeat0, ifeat1) feed refine(); bundles without it stop at fpn2.
        if (hasRefine_) return run(*image_, {"image"}, inputs, {"fpn0", "fpn1", "fpn2", "iembed", "ifeat0", "ifeat1"});
        return run(*image_, {"image"}, inputs, {"fpn0", "fpn1", "fpn2"});
    }
    std::vector<Instance> segment(const Session& session, const uint8_t* alpha, const uint8_t*, size_t length,
                                  const SegmentOptions& options, Json& diagnostics, const std::atomic_bool* cancel) override {
        const auto& g = session.geometry;
        if (!alpha || length != pixels(g.width, g.height)) throw Error("BUFFER_SIZE", "Expected document-sized prompt alpha");
        const auto stats = alphaStats(alpha, g.width, g.height);
        diagnostics = Json::object();
        recordAlpha(stats, length, diagnostics);
        diagnostics["sampling"] = "component-boxes-v1";
        diagnostics["modelInputAccepted"] = false;
        if (!stats.painted) throw Error("EMPTY_PROMPT", "No painted pixels reached the visual prompt input");

        // Exemplar boxes in normalized CxCyWH; tiny specks (noise, stray brush dabs) are ignored
        // unless they are the only stroke.
        auto parts = components(alpha, g.width, g.height);
        const size_t minimum = std::max<size_t>(16, stats.painted / 200);
        std::vector<float> boxes(static_cast<size_t>(maxPrompts_) * 4), grid;
        std::vector<int64_t> labels(maxPrompts_, 1);
        std::vector<uint8_t> valid(maxPrompts_, 0);
        for (int i = 0; i < maxPrompts_; ++i) { boxes[i * 4] = .5f; boxes[i * 4 + 1] = .5f; boxes[i * 4 + 2] = .1f; boxes[i * 4 + 3] = .1f; }
        int used = 0;
        Json exemplars = Json::array();
        for (const auto& [area, box] : parts) {
            if (used == maxPrompts_ || (used > 0 && area < minimum)) break;
            boxes[used * 4] = (box.x0 + box.x1) / 2 / g.width;
            boxes[used * 4 + 1] = (box.y0 + box.y1) / 2 / g.height;
            boxes[used * 4 + 2] = (box.x1 - box.x0) / g.width;
            boxes[used * 4 + 3] = (box.y1 - box.y0) / g.height;
            valid[used] = 1;
            exemplars.push_back({box.x0, box.y0, box.x1, box.y1});
            ++used;
        }
        diagnostics["exemplarBoxes"] = exemplars;
        diagnostics["strokeComponents"] = parts.size();
        diagnostics["gridActiveCells"] = used;

        std::vector<Ort::Value> inputs;
        std::array<std::vector<float>, 3> feats;  // ORT input buffers must be mutable
        static const char* names[] = {"fpn0", "fpn1", "fpn2"};
        for (int i = 0; i < 3; ++i) {
            feats[i] = session.features[i].data;
            const auto& s = session.features[i].shape;
            inputs.push_back(tensor(feats[i].data(), feats[i].size(), {s[0], s[1], s[2], s[3]}));
        }
        inputs.push_back(tensor(boxes.data(), boxes.size(), {maxPrompts_, 4}));
        inputs.push_back(tensor(labels.data(), labels.size(), {maxPrompts_}));
        inputs.push_back(Ort::Value::CreateTensor<bool>(cpuMemory(), reinterpret_cast<bool*>(valid.data()), valid.size(),
                                                        std::vector<int64_t>{maxPrompts_}.data(), 1));
        diagnostics["modelInputAccepted"] = true;
        auto out = run(*prompt_, {names[0], names[1], names[2], "boxes", "labels", "valid"}, inputs,
                       {"scores", "pred_boxes", "masks"}, cancel);
        diagnostics["promptGraphExecuted"] = true;
        diagnostics["embeddingUsed"] = true;
        const auto& scores = out[0].data;
        const auto& predicted = out[1].data;
        const auto& masks = out[2].data;
        if (static_cast<int>(scores.size()) != queries_ || masks.size() != static_cast<size_t>(queries_) * maskSize_ * maskSize_)
            throw Error("MODEL_VERSION", "Unexpected SAM 3 decoder output shape");

        std::vector<int> order;
        float maximumConfidence = 0;
        for (int q = 0; q < queries_; ++q) {
            maximumConfidence = std::max(maximumConfidence, scores[q]);
            if (scores[q] >= options.confidence) order.push_back(q);
        }
        std::sort(order.begin(), order.end(), [&](int a, int b) { return scores[a] > scores[b]; });
        diagnostics["maximumConfidence"] = maximumConfidence;
        diagnostics["confidenceThreshold"] = options.confidence;
        diagnostics["candidatesAboveThreshold"] = order.size();

        // Box NMS, as SAM3SemanticPredictor.postprocess does.
        std::vector<std::array<float, 4>> kept;
        std::vector<Instance> result;
        size_t resultBytes = 0;
        for (int q : order) {
            if (static_cast<int>(result.size()) == options.maxInstances) break;
            checkCancel(cancel);
            const float* b = &predicted[static_cast<size_t>(q) * 4];
            std::array<float, 4> box{std::clamp((b[0] - b[2] / 2) * g.width, 0.f, static_cast<float>(g.width)),
                                     std::clamp((b[1] - b[3] / 2) * g.height, 0.f, static_cast<float>(g.height)),
                                     std::clamp((b[0] + b[2] / 2) * g.width, 0.f, static_cast<float>(g.width)),
                                     std::clamp((b[1] + b[3] / 2) * g.height, 0.f, static_cast<float>(g.height))};
            if (std::any_of(kept.begin(), kept.end(), [&](const auto& k) { return iou(k, box) > nmsIou_; })) continue;
            kept.push_back(box);
            // Masks are not cropped to the box upstream; scan the box expanded by one mask cell.
            const float cellX = static_cast<float>(g.width) / maskSize_, cellY = static_cast<float>(g.height) / maskSize_;
            Instance instance; instance.id = q; instance.confidence = scores[q]; instance.box = box;
            const int x0 = std::max(0, static_cast<int>(std::floor(box[0] - cellX)));
            const int y0 = std::max(0, static_cast<int>(std::floor(box[1] - cellY)));
            const int x1 = std::min(g.width, static_cast<int>(std::ceil(box[2] + cellX)));
            const int y1 = std::min(g.height, static_cast<int>(std::ceil(box[3] + cellY)));
            if (x1 <= x0 || y1 <= y0) continue;
            const float* logits = &masks[static_cast<size_t>(q) * maskSize_ * maskSize_];
            // Bilinear upsample of logits to document resolution, then threshold (F.interpolate, align_corners=False).
            std::vector<uint8_t> full(static_cast<size_t>(x1 - x0) * (y1 - y0));
            int mx0 = x1, my0 = y1, mx1 = x0 - 1, my1 = y0 - 1;
            size_t intersection = 0, nonzero = 0;
            for (int y = y0; y < y1; ++y) {
                const float sy = (y + .5f) * maskSize_ / g.height - .5f;
                for (int x = x0; x < x1; ++x) {
                    if (bilinearSample(logits, maskSize_, maskSize_, (x + .5f) * maskSize_ / g.width - .5f, sy) <= 0) continue;
                    full[static_cast<size_t>(y - y0) * (x1 - x0) + (x - x0)] = 255;
                    ++nonzero;
                    intersection += alpha[static_cast<size_t>(y) * g.width + x] > 0;
                    mx0 = std::min(mx0, x); my0 = std::min(my0, y); mx1 = std::max(mx1, x); my1 = std::max(my1, y);
                }
            }
            if (!nonzero) continue;
            instance.left = mx0; instance.top = my0; instance.width = mx1 - mx0 + 1; instance.height = my1 - my0 + 1;
            const size_t maskBytes = static_cast<size_t>(instance.width) * instance.height;
            if (maskBytes > 400000000 - resultBytes) throw Error("RESULT_TOO_LARGE", "Masks exceed 400 MB; increase confidence");
            instance.mask.resize(maskBytes);
            for (int y = 0; y < instance.height; ++y)
                std::copy_n(&full[static_cast<size_t>(y + my0 - y0) * (x1 - x0) + (mx0 - x0)], instance.width,
                            &instance.mask[static_cast<size_t>(y) * instance.width]);
            instance.overlap = static_cast<float>(intersection) / std::max<size_t>(1, stats.painted);
            resultBytes += maskBytes;
            result.push_back(std::move(instance));
        }
        return result;
    }
private:
    std::filesystem::path directory_;
    Json manifest_;
    Resample resample_;
    int maxPrompts_ = 0, queries_ = 0, maskSize_ = 0, refinePoints_ = 20;
    float nmsIou_ = .7f;
    bool hasRefine_ = false;
    std::unique_ptr<Ort::Session> image_, prompt_, refine_;

    // Samples a stroke as point prompts: one point per occupied cell of a coarse grid (about 24
    // model pixels), at the painted pixel nearest the cell's centroid, most-painted cells first.
    template <class Painted>
    static std::vector<std::array<float, 3>> cellCentres(const Geometry& g, Painted painted) {
        const int cell = std::max(1, static_cast<int>(std::ceil(24.f * std::max(g.width, g.height) / Size)));
        const int cols = (g.width + cell - 1) / cell, rows = (g.height + cell - 1) / cell;
        struct Acc { double x = 0, y = 0; size_t n = 0; };
        std::vector<Acc> acc(static_cast<size_t>(cols) * rows);
        for (int y = 0; y < g.height; ++y) for (int x = 0; x < g.width; ++x)
            if (painted(x, y)) { auto& a = acc[static_cast<size_t>(y / cell) * cols + x / cell]; a.x += x; a.y += y; ++a.n; }
        std::vector<std::array<float, 3>> result;
        const size_t minimum = std::max<size_t>(1, static_cast<size_t>(cell) * cell / 16);
        for (const auto& a : acc)
            if (a.n >= minimum) result.push_back({static_cast<float>(a.x / a.n), static_cast<float>(a.y / a.n), static_cast<float>(a.n)});
        std::sort(result.begin(), result.end(), [](const auto& a, const auto& b) { return a[2] > b[2]; });
        return result;
    }
};
}

std::unique_ptr<Model> makeSam3(const std::filesystem::path& directory, const Json& manifest) {
    return std::make_unique<Sam3>(directory, manifest);
}
}
