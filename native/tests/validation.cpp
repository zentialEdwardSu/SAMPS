// Development-only fixture runner. Not installed or included in the plugin.
#include "samps/engine.h"
#include <fstream>
#include <iostream>
#include <chrono>

std::vector<uint8_t> readBytes(const std::filesystem::path& path) {
    std::ifstream file(path,std::ios::binary);
    if (!file) throw samps::Error("FILE_MISSING",path.string());
    return {std::istreambuf_iterator<char>(file),{}};
}
int main(int argc, char** argv) try {
    if (argc != 4) { std::cerr << "Development runner: model-directory fixtures.json output-directory\n"; return 2; }
    std::ifstream file(argv[2]); samps::Json cases; file >> cases;
    std::filesystem::path output(argv[3]); std::filesystem::create_directories(output);
    samps::Engine engine;
    auto info = engine.initialize(std::filesystem::u8path(argv[1]), cases.value("device",-1),true);
    std::ofstream(output/"device.json") << info.dump(2);
    for (const auto& fixture : cases.at("cases")) {
        std::string id = fixture.at("id");
        int width = fixture.at("width"), height = fixture.at("height");
        auto rgba = readBytes(std::filesystem::u8path(fixture.at("rgba").get<std::string>()));
        auto prompt = readBytes(std::filesystem::u8path(fixture.at("prompt").get<std::string>()));
        auto folder = output/id; std::filesystem::create_directories(folder);
        // Tensor dumps feed tools/validate.py; behaviour evaluations set "dumpTensors": false (they are GBs).
        const bool dump = cases.value("dumpTensors",true);
        samps::Geometry geometry;
        if (dump) samps::writeTensor(folder/"input.f32",engine.preprocess(rgba.data(),rgba.size(),width,height,geometry));
        auto start = std::chrono::steady_clock::now();
        auto session = engine.prepareImage(rgba.data(),rgba.size(),width,height);
        auto imageEnd = std::chrono::steady_clock::now();
        if (dump) for (size_t i = 0; i < session->features.size(); ++i) samps::writeTensor(folder/("out"+std::to_string(i)+".f32"),session->features[i].data);
        // The 80×80 grid is YOLOE's prompt input; SAM 3 derives exemplar boxes inside segment().
        if (dump && info.value("architecture","") == "yoloe26")
            samps::writeTensor(folder/"prompt.f32",engine.preparePrompt(session->geometry,prompt.data(),prompt.size()));
        // cases.json may set "mode": "current" and give a fixture an "exclude" alpha plane.
        samps::SegmentOptions options; options.currentOnly = cases.value("mode",std::string("similar")) == "current";
        options.detail = cases.value("detail",true);
        if (fixture.contains("exclude")) {
            auto exclude = readBytes(std::filesystem::u8path(fixture.at("exclude").get<std::string>()));
            if (exclude.size() != prompt.size()) throw samps::Error("BUFFER_SIZE","Exclude plane size differs");
            prompt.insert(prompt.end(),exclude.begin(),exclude.end());
            options.hasNegative = true;
        }
        auto segmentStart = std::chrono::steady_clock::now();
        auto instances = engine.segment(*session,prompt.data(),prompt.size(),options);
        std::ofstream(folder/"diagnostics.json") << engine.promptDiagnostics().dump(2);
        auto end = std::chrono::steady_clock::now();
        samps::Json results = samps::Json::array();
        for (const auto& instance : instances) {
            auto value = samps::describe(instance);
            std::string name = std::to_string(instance.id)+".mask"; value["file"] = name;
            std::ofstream mask(folder/name,std::ios::binary);
            mask.write(reinterpret_cast<const char*>(instance.mask.data()),instance.mask.size());
            results.push_back(value);
        }
        samps::Json report{{"instances",results},{"imageMs",std::chrono::duration<double,std::milli>(imageEnd-start).count()},
                           {"promptMs",std::chrono::duration<double,std::milli>(end-segmentStart).count()}};
        std::ofstream(folder/"result.json") << report.dump(2);
        std::cout << id << ": " << instances.size() << " instances\n" << std::flush;
    }
    return 0;
} catch (const samps::Error& error) { std::cerr << error.code << ": " << error.what() << '\n'; return 1; }
  catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
