#include "samps/engine.h"
#include <fstream>
#include <iostream>
#include <chrono>
#include <algorithm>
#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <psapi.h>
#endif
namespace {
std::vector<uint8_t> bytes(const std::filesystem::path& path) {
    std::ifstream f(path,std::ios::binary); if(!f) throw std::runtime_error("Missing fixture");
    return {std::istreambuf_iterator<char>(f),{}};
}
void require(bool ok, const char* message) { if(!ok) throw std::runtime_error(message); }
template<class F> void error(F action,const char* code) {
    try { action(); } catch(const samps::Error& e) { require(e.code==code,"Wrong error code"); return; }
    throw std::runtime_error(std::string("Expected ")+code);
}
size_t resident() {
#ifdef _WIN32
    PROCESS_MEMORY_COUNTERS info{};GetProcessMemoryInfo(GetCurrentProcess(),&info,sizeof(info));return info.WorkingSetSize;
#else
    return 0;
#endif
}
}
int main(int argc,char** argv) try {
    require(argc==4 || (argc==5 && std::string(argv[4])=="--experimental"),"Expected model-directory cases.json output.json [--experimental]");
    samps::Engine engine;
    auto coldStart=std::chrono::steady_clock::now();
    auto info=engine.initialize(std::filesystem::u8path(argv[1]),-2,argc==5);
    double coldMs=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-coldStart).count();
    std::ifstream input(argv[2]);samps::Json fixtures;input>>fixtures;
    auto fixture=fixtures.at("cases").at(0);
    auto rgba=bytes(std::filesystem::u8path(fixture.at("rgba").get<std::string>()));
    auto prompt=bytes(std::filesystem::u8path(fixture.at("prompt").get<std::string>()));
    int w=fixture.at("width"),h=fixture.at("height");
    error([&]{engine.prepareImage(rgba.data(),1,w,h);},"BUFFER_SIZE");
    std::atomic_bool cancelled{true};
    error([&]{engine.prepareImage(rgba.data(),rgba.size(),w,h,&cancelled);},"CANCELLED");
    auto firstStart=std::chrono::steady_clock::now();
    auto session=engine.prepareImage(rgba.data(),rgba.size(),w,h);
    double firstMs=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-firstStart).count();
    samps::SegmentOptions similar;similar.currentOnly=false;
    auto all=engine.segment(*session,prompt.data(),prompt.size(),similar);
    require(all.size()>=2,"Fixture must contain multiple detections");
    auto selected=engine.segment(*session,prompt.data(),prompt.size(),{});
    const auto originalGrid=engine.promptDiagnostics().at("grid").get<std::string>();
    require(selected.size()==1 && selected[0].overlap>0,"Current-object selection failed");
    auto best=std::max_element(all.begin(),all.end(),[](const auto& a,const auto& b){return a.overlap!=b.overlap?a.overlap<b.overlap:a.confidence<b.confidence;});
    require(best->id==selected[0].id,"Current-object overlap ranking failed");
    std::vector<uint8_t> empty(prompt.size(),0);
    error([&]{engine.segment(*session,empty.data(),empty.size(),{});},"EMPTY_PROMPT");
    empty[1]=255;
    engine.segment(*session,empty.data(),empty.size(),{});
    require(engine.promptDiagnostics().at("gridActiveCells").get<int>()>0,"Thin prompt was lost");
    error([&]{engine.segment(*session,prompt.data(),prompt.size(),{},&cancelled);},"CANCELLED");
    samps::SegmentOptions noResults;noResults.confidence=1.f;
    require(engine.segment(*session,prompt.data(),prompt.size(),noResults).empty(),"No-result threshold failed");
    auto altered=prompt;
    for(auto& value:altered)value=value?0:255;
    auto changed=engine.segment(*session,altered.data(),altered.size(),similar);
    require(changed.empty() || changed.front().id!=all.front().id || std::abs(changed.front().confidence-all.front().confidence)>1e-3,"Prompt update did not affect predictions");
    std::vector<double> times;
    size_t baseline=0, peak=0, final=0;
    for(int i=0;i<110;++i){
        auto start=std::chrono::steady_clock::now();
        auto result=engine.segment(*session,prompt.data(),prompt.size(),{});
        require(result.size()==1 && result[0].id==selected[0].id,"Repeated inference changed results");
        if(i==9)baseline=resident();
        if(i>=10){times.push_back(std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count());peak=std::max(peak,resident());}
        final=resident();
    }
    require(final<=baseline+32*1024*1024,"Resident memory grew by more than 32 MB after warmup");
    samps::Json geometry=samps::Json::array();
    for(int width:{4096,8192}){
        int height=static_cast<int>(std::nearbyint(static_cast<double>(h)*width/w));
        auto scaled=*session;
        auto& g=scaled.geometry;g.width=width;g.height=height;g.scale=640.f/width;
        g.resizedWidth=640;g.resizedHeight=static_cast<int>(std::nearbyint(height*g.scale));g.left=0;g.top=(640-g.resizedHeight)/2;
        std::vector<uint8_t> alpha(static_cast<size_t>(width)*height);
        // Hold the actual model prompt fixed when checking output coordinates.
        // Resampling a brush bitmap can change edge-cell occupancy and therefore
        // object ranking; that is a different input, not a coordinate mapping test.
        for(int gy=0;gy<80;++gy)for(int gx=0;gx<80;++gx)if(originalGrid[gy*80+gx]=='1'){
            double x0=std::max(0.,static_cast<double>(gx*8-g.left)*width/g.resizedWidth);
            double x1=std::min(static_cast<double>(width),static_cast<double>((gx+1)*8-g.left)*width/g.resizedWidth);
            double y0=std::max(0.,static_cast<double>(gy*8-g.top)*height/g.resizedHeight);
            double y1=std::min(static_cast<double>(height),static_cast<double>((gy+1)*8-g.top)*height/g.resizedHeight);
            require(x1>x0 && y1>y0,"Active prompt cell outside image");
            int x=std::clamp(static_cast<int>((x0+x1)/2),0,width-1);
            int y=std::clamp(static_cast<int>((y0+y1)/2),0,height-1);
            alpha[static_cast<size_t>(y)*width+x]=255;
        }
        engine.preparePrompt(g,alpha.data(),alpha.size());
        require(engine.promptDiagnostics().at("grid")==originalGrid,"Mapping fixture changed the model prompt");
        auto results=engine.segment(scaled,alpha.data(),alpha.size(),{});
        require(results.size()==1,"Large-image mapping lost the selected object");
        for(int c=0;c<4;++c)require(std::abs(results[0].box[c]*w/width-selected[0].box[c])<1.f,"Large-image bbox drift");
        require(results[0].mask.size()==static_cast<size_t>(results[0].width)*results[0].height,"Invalid large-image mask size");
        geometry.push_back({{"width",width},{"height",height},{"passed",true}});
    }
    std::sort(times.begin(),times.end());
    samps::Json report{{"passed",true},{"device",info},{"coldInitializeMs",coldMs},{"firstImageMs",firstMs},
      {"cachedUpdates",100},{"promptMedianMs",times[times.size()/2]},{"promptP95Ms",times[static_cast<size_t>(times.size()*.95)-1]},
      {"workingSetBaseline",baseline},{"workingSetPeak",peak},{"workingSetFinal",final},{"largeImageMapping",geometry},
      {"checks",{"current-object ranking","similar instances","changed prompt without re-export","empty prompt","preserved thin stroke","cancel","no results","buffer validation","100 cached updates","4K/8K mask mapping"}}};
    std::ofstream(std::filesystem::u8path(argv[3]))<<report.dump(2);
    std::cout<<report.dump(2)<<'\n';return 0;
}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}
