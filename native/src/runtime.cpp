// ONNX Runtime + DirectML loading and session helpers.
//
// Photoshop ships its own onnxruntime.dll (1.23) and loads it into the host process. A
// module imported by name would bind to that copy, so SAMPS ships its runtime renamed to
// samps_onnxruntime.dll and loads it by full path from the addon's own directory. Its
// DirectML.dll dependency resolves from the same directory (or reuses the host's copy,
// which is the same 1.15.4 build).
#include "internal.h"
#include <dml_provider_factory.h>
#include <algorithm>
#include <cctype>
#include <chrono>
#include <mutex>
#include <thread>
#ifdef _WIN32
#include <windows.h>
#include <dxgi1_6.h>
#include <wrl/client.h>
#endif

namespace samps::detail {
namespace {
#ifdef _WIN32
std::string utf8(const wchar_t* text) {
    const int size = WideCharToMultiByte(CP_UTF8, 0, text, -1, nullptr, 0, nullptr, nullptr);
    std::string result(size > 0 ? size - 1 : 0, '\0');
    if (size > 1) WideCharToMultiByte(CP_UTF8, 0, text, -1, result.data(), size, nullptr, nullptr);
    return result;
}
std::filesystem::path moduleDirectory() {
    HMODULE self = nullptr;
    if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                            reinterpret_cast<LPCWSTR>(&moduleDirectory), &self))
        throw Error("RUNTIME_MISSING", "Cannot locate the SAMPS module directory");
    std::wstring buffer(32768, L'\0');
    const DWORD length = GetModuleFileNameW(self, buffer.data(), static_cast<DWORD>(buffer.size()));
    if (!length || length >= buffer.size()) throw Error("RUNTIME_MISSING", "Cannot locate the SAMPS module directory");
    buffer.resize(length);
    return std::filesystem::path(buffer).parent_path();
}
#endif

const OrtApiBase* apiBase = nullptr;

void loadRuntime() {
    static std::once_flag once;
    std::call_once(once, [] {
#ifdef _WIN32
        const auto library = moduleDirectory() / L"samps_onnxruntime.dll";
        HMODULE module = LoadLibraryExW(library.c_str(), nullptr,
                                        LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
        if (!module) throw Error("RUNTIME_MISSING", "Cannot load " + library.u8string() +
                                 " (error " + std::to_string(GetLastError()) + ")");
        using GetApiBase = const OrtApiBase*(ORT_API_CALL*)();
        auto getApiBase = reinterpret_cast<GetApiBase>(GetProcAddress(module, "OrtGetApiBase"));
        apiBase = getApiBase ? getApiBase() : nullptr;
        const OrtApi* api = apiBase ? apiBase->GetApi(ORT_API_VERSION) : nullptr;
        if (!api) throw Error("RUNTIME_VERSION", "samps_onnxruntime.dll does not provide ONNX Runtime API " +
                              std::to_string(ORT_API_VERSION));
        // The runtime stays loaded for the life of the process; sessions may outlive the addon's teardown.
        Ort::InitApi(api);
#else
        throw Error("UNSUPPORTED_PLATFORM", "This build requires Windows x64");
#endif
    });
}

int cpuThreads() {
    const unsigned hardware = std::max(2u, std::thread::hardware_concurrency());
    // Leave half the cores to Photoshop's own UI and compositing threads.
    return static_cast<int>(std::clamp(hardware / 2, 1u, 8u));
}
}

Ort::Env& environment() {
    loadRuntime();
    // Intentionally leaked: destroying the environment during DLL unload is unsafe.
    static Ort::Env* env = new Ort::Env(ORT_LOGGING_LEVEL_ERROR, "samps");
    return *env;
}

// Ort::GetVersionString() links OrtGetApiBase directly; read it through the loaded module instead.
std::string runtimeVersion() {
    environment();
    return apiBase->GetVersionString();
}

const OrtMemoryInfo* cpuMemory() {
    environment();
    static Ort::MemoryInfo* info = new Ort::MemoryInfo(Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault));
    return *info;
}

Json adapters() {
    Json result = Json::array();
#ifdef _WIN32
    Microsoft::WRL::ComPtr<IDXGIFactory1> factory;
    if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) return result;
    Microsoft::WRL::ComPtr<IDXGIAdapter1> adapter;
    // DirectML device_id is the IDXGIFactory::EnumAdapters order.
    for (UINT index = 0; factory->EnumAdapters1(index, &adapter) != DXGI_ERROR_NOT_FOUND; ++index) {
        DXGI_ADAPTER_DESC1 desc{};
        if (FAILED(adapter->GetDesc1(&desc))) continue;
        result.push_back({{"id", index}, {"name", utf8(desc.Description)},
                          {"dedicatedMemoryMB", static_cast<uint64_t>(desc.DedicatedVideoMemory >> 20)},
                          {"software", (desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) != 0}});
    }
#endif
    return result;
}

const char* failureCode(const std::string& message, const char* fallback) {
    std::string text(message.size(), '\0');
    std::transform(message.begin(), message.end(), text.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    const auto has = [&](const char* needle) { return text.find(needle) != std::string::npos; };
    // DXGI_ERROR_DEVICE_REMOVED / HUNG / RESET / DRIVER_INTERNAL_ERROR: the D3D device is gone (often a
    // TDR after exhausting memory); every later call on it fails until the sessions are recreated.
    if (has("887a0005") || has("887a0006") || has("887a0007") || has("887a0020") || has("device_removed") ||
        has("device removed"))
        return "GPU_LOST";
    // E_OUTOFMEMORY (also localized as 内存资源不足), and ORT/DML allocation failures.
    if (has("8007000e") || has("e_outofmemory") || has("out of memory") || has("outofmemory") ||
        has("not enough memory") || has("failed to allocate") || has("bad allocation") || has("bad_alloc") ||
        has("\xe5\x86\x85\xe5\xad\x98\xe4\xb8\x8d\xe8\xb6\xb3") /* 内存不足 */ ||
        has("\xe5\x86\x85\xe5\xad\x98\xe8\xb5\x84\xe6\xba\x90\xe4\xb8\x8d\xe8\xb6\xb3") /* 内存资源不足 */)
        return "GPU_MEMORY";
    return fallback;
}

std::unique_ptr<Ort::Session> openSession(const std::filesystem::path& path, int device, const Json& options) {
    environment();
    try {
        Ort::SessionOptions settings;
        settings.SetIntraOpNumThreads(cpuThreads());
        settings.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);
        if (device >= 0) {
            // DirectML requires sequential execution without memory patterns.
            settings.DisableMemPattern();
            settings.SetExecutionMode(ExecutionMode::ORT_SEQUENTIAL);
            // Some graphs (the SAM 3 ViT) crash ORT's DirectML graph transforms at session creation;
            // the bundle picks a level ("disable", "basic", "extended", "all"), the panel may override it.
            const auto level = options.value("dmlOptimization", std::string("all"));
            if (level == "disable") settings.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_DISABLE_ALL);
            else if (level == "basic") settings.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_BASIC);
            else if (level == "extended") settings.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_EXTENDED);
            const OrtDmlApi* dml = nullptr;
            Ort::ThrowOnError(Ort::GetApi().GetExecutionProviderApi("DML", ORT_API_VERSION, reinterpret_cast<const void**>(&dml)));
            Ort::ThrowOnError(dml->SessionOptionsAppendExecutionProvider_DML(settings, device));
        }
        return std::make_unique<Ort::Session>(environment(), path.c_str(), settings);
    } catch (const Ort::Exception& error) {
        throw Error(failureCode(error.what(), "MODEL_LOAD"), path.filename().u8string() + ": " + error.what());
    }
}

std::vector<Tensor> run(Ort::Session& session, const std::vector<const char*>& inputNames,
                        std::vector<Ort::Value>& inputs, const std::vector<const char*>& outputNames,
                        const std::atomic_bool* cancelled) {
    Ort::RunOptions options;
    // ORT checks the terminate flag between kernels, so a long encoder pass can be cancelled.
    std::atomic_bool finished{false};
    std::thread watcher;
    if (cancelled) watcher = std::thread([&] {
        while (!finished.load()) {
            if (cancelled->load()) { options.SetTerminate(); return; }
            std::this_thread::sleep_for(std::chrono::milliseconds(30));
        }
    });
    auto stop = [&] { finished = true; if (watcher.joinable()) watcher.join(); };
    std::vector<Ort::Value> outputs;
    try {
        outputs = session.Run(options, inputNames.data(), inputs.data(), inputs.size(), outputNames.data(), outputNames.size());
    } catch (const Ort::Exception& error) {
        stop();
        checkCancel(cancelled);
        throw Error(failureCode(error.what(), "INFERENCE_FAILED"), error.what());
    }
    stop();
    checkCancel(cancelled);
    std::vector<Tensor> result;
    result.reserve(outputs.size());
    for (auto& value : outputs) {
        auto info = value.GetTensorTypeAndShapeInfo();
        if (info.GetElementType() != ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT)
            throw Error("INFERENCE_FAILED", "Model output is not float32");
        Tensor tensor;
        tensor.shape = info.GetShape();
        const float* data = value.GetTensorData<float>();
        tensor.data.assign(data, data + info.GetElementCount());
        result.push_back(std::move(tensor));
    }
    return result;
}
}
