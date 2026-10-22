// Adobe UXP bridge. Worker never owns addon_value handles or calls Photoshop APIs.
// JS polls completion on its own scripting queue; no cross-thread V8 handles.
#include "samps/engine.h"
#include "UxpAddon.h"
#include <algorithm>
#include <cstring>
#include <mutex>
#include <thread>

namespace {
using samps::Json;
struct Job {
    uint32_t id = 0;
    std::atomic_bool cancelled{false}, done{false};
    Json result;
    std::vector<uint8_t> bytes;
    std::thread worker;
    ~Job() { cancelled = true; if (worker.joinable()) worker.join(); }
};
std::unique_ptr<Job> job;
std::unique_ptr<samps::Engine> engine;
std::shared_ptr<samps::Session> session;
uint32_t nextRequest = 1;

void check(addon_status status) {
    if (status != addon_ok) throw samps::Error("BRIDGE_ERROR", "UXP buffer or argument conversion failed");
}
std::string stringValue(addon_env env, addon_value value) {
    size_t size = 0;
    check(UxpAddonApis.uxp_addon_get_value_string_utf8(env,value,nullptr,0,&size));
    std::vector<char> buffer(size+1);
    check(UxpAddonApis.uxp_addon_get_value_string_utf8(env,value,buffer.data(),buffer.size(),&size));
    return {buffer.data(),size};
}
addon_value jsString(addon_env env,const std::string& text) {
    addon_value value = nullptr;
    check(UxpAddonApis.uxp_addon_create_string_utf8(env,text.c_str(),text.size(),&value));
    return value;
}
// Panel smoothing sliders, 0..1 each; non-numbers fall back to the defaults.
samps::SmoothParams smoothing(const Json& options) {
    samps::SmoothParams params;
    auto read = [&](const char* key, float& target) {
        if (options.contains(key) && options.at(key).is_number()) target = std::clamp(options.at(key).get<float>(), 0.f, 1.f);
    };
    read("smooth", params.smooth); read("expand", params.expand);
    return params;
}

// Serializes instances: descriptors in JSON, masks concatenated into `bytes`.
Json pack(const std::vector<samps::Instance>& instances, std::vector<uint8_t>& bytes) {
    size_t total = 0;
    for (const auto& item : instances) {
        if (item.mask.size() > 400000000-total) throw samps::Error("RESULT_TOO_LARGE", "Too many large masks; increase confidence");
        total += item.mask.size();
    }
    bytes.clear(); bytes.reserve(total);
    Json result = Json::array();
    for (const auto& item : instances) {
        auto value = samps::describe(item);
        value["offset"] = bytes.size(); value["length"] = item.mask.size();
        bytes.insert(bytes.end(),item.mask.begin(),item.mask.end());
        result.push_back(value);
    }
    return {{"instances",result},{"prompt",engine->promptDiagnostics()},{"resultId",engine->resultId()}};
}

addon_value submit(addon_env env, addon_callback_info callback) {
    try {
        if (job) throw samps::Error("BUSY", "Wait for or cancel the current request");
        addon_value args[3]{}; size_t count = 3;
        check(UxpAddonApis.uxp_addon_get_cb_info(env,callback,&count,args,nullptr,nullptr));
        if (count != 3) throw samps::Error("INVALID_ARGUMENT", "Expected operation, JSON options and ArrayBuffer");
        auto operation = stringValue(env,args[0]);
        auto options = Json::parse(stringValue(env,args[1]));
        void* source = nullptr; size_t length = 0;
        check(UxpAddonApis.uxp_addon_get_arraybuffer_info(env,args[2],&source,&length));
        if (length > 400000000) throw samps::Error("BUFFER_SIZE", "Buffer exceeds the prototype memory limit");
        std::vector<uint8_t> input(length);
        if (length) std::memcpy(input.data(),source,length);
        auto pending = std::make_unique<Job>();
        pending->id = nextRequest++;
        Job* state = pending.get();
        state->worker = std::thread([state,operation,options,input=std::move(input)]() mutable {
            try {
                if (operation == "initialize") {
                    session.reset(); engine.reset();
                    auto candidate = std::make_unique<samps::Engine>();
                    const int device = options.contains("device") && options.at("device").is_number_integer()
                        ? options.at("device").get<int>() : -2;
                    samps::LoadOptions load;
                    load.lowVram = options.contains("lowVram") && options.at("lowVram").is_boolean() && options.at("lowVram").get<bool>();
                    if (options.contains("optimization") && options.at("optimization").is_string())
                        load.optimization = options.at("optimization").get<std::string>();
                    if (options.contains("inputSize") && options.at("inputSize").is_number_integer())
                        load.inputSize = options.at("inputSize").get<int>();
                    auto info = candidate->initialize(std::filesystem::u8path(options.at("directory").get<std::string>()),
                        device,options.value("allowUnvalidated",false),load);
                    if (state->cancelled) throw samps::Error("CANCELLED", "Operation cancelled");
                    engine = std::move(candidate);
                    state->result = {{"ok",true},{"value",info}};
                } else if (operation == "prepareImage") {
                    if (!engine) throw samps::Error("NOT_INITIALIZED", "Choose an offline model bundle first");
                    session.reset();
                    auto prepared = engine->prepareImage(input.data(),input.size(),options.at("width"),options.at("height"),&state->cancelled);
                    session = std::move(prepared);
                    state->result = {{"ok",true},{"value",{{"sessionId",session->id},{"info",engine->info()}}}};
                } else if (operation == "segment") {
                    if (!session || session->id != options.at("sessionId").get<uint64_t>()) throw samps::Error("STALE_SESSION", "Image session expired");
                    samps::SegmentOptions config;
                    config.confidence = options.value("confidence",.25f);
                    config.currentOnly = options.value("mode",std::string("current")) == "current";
                    config.hasNegative = options.value("hasNegative",false);
                    config.detail = options.value("detail",true);
                    config.smoothing = smoothing(options);
                    auto instances = engine->segment(*session,input.data(),input.size(),config,&state->cancelled);
                    state->result = {{"ok",true},{"value",pack(instances,state->bytes)}};
                } else if (operation == "resmooth") {
                    if (!engine) throw samps::Error("NOT_INITIALIZED", "Choose an offline model bundle first");
                    if (!session || session->id != options.at("sessionId").get<uint64_t>()) throw samps::Error("STALE_SESSION", "Image session expired");
                    auto instances = engine->resmooth(*session,options.at("resultId").get<uint64_t>(),smoothing(options),&state->cancelled);
                    state->result = {{"ok",true},{"value",pack(instances,state->bytes)}};
                } else if (operation == "unload") {
                    // Destroying the engine destroys its ORT sessions, which is the only way to
                    // return DirectML's allocation arena. initialize() loads the model again.
                    session.reset();
                    engine.reset();
                    state->result = {{"ok",true},{"value",nullptr}};
                } else if (operation == "dispose") {
                    if (session && session->id == options.at("sessionId").get<uint64_t>()) session.reset();
                    state->result = {{"ok",true},{"value",nullptr}};
                } else throw samps::Error("INVALID_OPERATION", "Unknown native operation");
                if (state->cancelled) throw samps::Error("CANCELLED", "Operation cancelled");
            } catch (const samps::Error& error) {
                state->result = {{"ok",false},{"code",error.code},{"message",error.what()}}; state->bytes.clear();
                // A removed GPU device leaves every session unusable; drop them so the next request
                // reloads, and so their memory is returned.
                if (error.code == "GPU_LOST") { session.reset(); engine.reset(); state->result["unloaded"] = true; }
            } catch (const std::exception& error) {
                state->result = {{"ok",false},{"code","NATIVE_ERROR"},{"message",error.what()}}; state->bytes.clear();
            } catch (...) {
                state->result = {{"ok",false},{"code","NATIVE_ERROR"},{"message","Unknown native exception"}}; state->bytes.clear();
            }
            if (operation == "segment" && engine && !state->result.value("ok",false))
                state->result["prompt"] = engine->promptDiagnostics();
            state->done.store(true,std::memory_order_release);
        });
        addon_value id = nullptr;
        check(UxpAddonApis.uxp_addon_create_uint32(env,state->id,&id));
        job = std::move(pending);
        return id;
    } catch (const samps::Error& error) {
        UxpAddonApis.uxp_addon_throw_error(env,error.code.c_str(),error.what()); return nullptr;
    } catch (const std::exception& error) {
        UxpAddonApis.uxp_addon_throw_error(env,"BRIDGE_ERROR",error.what()); return nullptr;
    }
}
addon_value take(addon_env env, addon_callback_info callback) {
    try {
        addon_value arg = nullptr; size_t count = 1; uint32_t request = 0;
        check(UxpAddonApis.uxp_addon_get_cb_info(env,callback,&count,&arg,nullptr,nullptr));
        check(UxpAddonApis.uxp_addon_get_value_uint32(env,arg,&request));
        if (!job || job->id != request) throw samps::Error("REQUEST_MISSING", "Native request expired");
        addon_value result = nullptr;
        if (!job->done.load(std::memory_order_acquire)) {
            check(UxpAddonApis.uxp_addon_get_null(env,&result)); return result;
        }
        job->worker.join();
        check(UxpAddonApis.uxp_addon_create_object(env,&result));
        check(UxpAddonApis.uxp_addon_set_named_property(env,result,"json",jsString(env,job->result.dump())));
        void* memory = nullptr; addon_value buffer = nullptr;
        check(UxpAddonApis.uxp_addon_create_arraybuffer(env,job->bytes.size(),&memory,&buffer));
        if (!job->bytes.empty()) std::memcpy(memory,job->bytes.data(),job->bytes.size());
        check(UxpAddonApis.uxp_addon_set_named_property(env,result,"buffer",buffer));
        job.reset();
        return result;
    } catch (const std::exception& error) {
        job.reset(); UxpAddonApis.uxp_addon_throw_error(env,"BRIDGE_ERROR",error.what()); return nullptr;
    }
}
addon_value cancel(addon_env env, addon_callback_info callback) {
    addon_value result = nullptr, arg = nullptr; size_t count = 1; uint32_t id = 0;
    if (UxpAddonApis.uxp_addon_get_cb_info(env,callback,&count,&arg,nullptr,nullptr) == addon_ok &&
        UxpAddonApis.uxp_addon_get_value_uint32(env,arg,&id) == addon_ok && job && job->id == id) job->cancelled = true;
    UxpAddonApis.uxp_addon_get_undefined(env,&result); return result;
}
addon_value initialize(addon_env env, addon_value exports, const addon_apis&) {
    for (const auto& entry : std::vector<std::pair<const char*,addon_callback>>{{"submit",submit},{"take",take},{"cancel",cancel}}) {
        addon_value fn = nullptr;
        check(UxpAddonApis.uxp_addon_create_function(env,entry.first,std::strlen(entry.first),entry.second,nullptr,&fn));
        check(UxpAddonApis.uxp_addon_set_named_property(env,exports,entry.first,fn));
    }
    return exports;
}
void terminate(addon_env) { job.reset(); session.reset(); engine.reset(); }
}
UXP_ADDON_INIT(initialize)
UXP_ADDON_TERMINATE(terminate)
