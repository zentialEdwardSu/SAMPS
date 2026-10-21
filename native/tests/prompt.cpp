#include "samps/engine.h"
#include <cmath>
#include <utility>
namespace samps::detail { std::pair<size_t, size_t> cleanMask(Instance&, size_t area); }
#include <iostream>

static void require(bool ok, const char* message) { if (!ok) throw std::runtime_error(message); }
int main() try {
    samps::Engine engine;
    int checked = 0;
    // Compute expected cell occupancy independently using rectangle intersections.
    for (const auto dims : {std::array<int,2>{640,640}, {1279,1706}, {8192,5461}, {3,2}, {1,1}, {1001,7}}) {
        samps::Geometry g;
        g.width=dims[0]; g.height=dims[1]; g.scale=640.f/std::max(g.width,g.height);
        g.resizedWidth=static_cast<int>(std::nearbyint(g.width*g.scale));
        g.resizedHeight=static_cast<int>(std::nearbyint(g.height*g.scale));
        g.left=(640-g.resizedWidth)/2; g.top=(640-g.resizedHeight)/2;
        std::vector<uint8_t> alpha(static_cast<size_t>(g.width)*g.height);
        for (const auto point : {std::array<int,2>{0,0}, {g.width-1,g.height-1}, {g.width/2,g.height/2}, {1%g.width,1%g.height}}) {
            std::fill(alpha.begin(),alpha.end(),0);
            alpha[static_cast<size_t>(point[1])*g.width+point[0]]=1; // even a faint single pixel survives
            auto mask=engine.preparePrompt(g,alpha.data(),alpha.size());
            const float* actual=mask.data();
            const double x0=g.left+static_cast<double>(point[0])*g.resizedWidth/g.width;
            const double x1=g.left+static_cast<double>(point[0]+1)*g.resizedWidth/g.width;
            const double y0=g.top+static_cast<double>(point[1])*g.resizedHeight/g.height;
            const double y1=g.top+static_cast<double>(point[1]+1)*g.resizedHeight/g.height;
            int occupied=0;
            for(int y=0;y<80;++y)for(int x=0;x<80;++x){
                const bool expected=x*8<x1 && (x+1)*8>x0 && y*8<y1 && (y+1)*8>y0;
                require((actual[y*80+x]>0)==expected,"Prompt footprint or letterbox coordinates differ");
                occupied+=expected;
            }
            auto diagnostic=engine.promptDiagnostics();
            require(occupied>0 && diagnostic.at("gridActiveCells")==occupied,"Thin stroke vanished");
            require(diagnostic.at("sourcePaintedPixels")==1,"Paint count differs");
            require(diagnostic.at("sourceBounds")==samps::Json::array({point[0],point[1],point[0]+1,point[1]+1}),"Bounds differ");
            uint32_t hash=2166136261u;for(auto byte:alpha)hash=(hash^byte)*16777619u;
            require(diagnostic.at("alphaChecksum")==hash,"Transport checksum differs");
            ++checked;
        }
        std::fill(alpha.begin(),alpha.end(),0);
        try { engine.preparePrompt(g,alpha.data(),alpha.size()); throw std::runtime_error("Empty prompt accepted"); }
        catch(const samps::Error& error) { require(error.code=="EMPTY_PROMPT","Wrong empty prompt error"); }
        try { engine.preparePrompt(g,alpha.data(),alpha.size()-1); throw std::runtime_error("Invalid buffer accepted"); }
        catch(const samps::Error& error) { require(error.code=="BUFFER_SIZE","Wrong buffer error"); }
    }
    // Mask cleanup: a small enclosed hole is filled, a small detached speck removed, a large hole kept.
    {
        samps::Instance item; item.width = 12; item.height = 12; item.mask.assign(144, 255);
        auto at = [&](int x, int y) -> uint8_t& { return item.mask[static_cast<size_t>(y) * 12 + x]; };
        at(3, 3) = 0;                                                     // 1 px pinhole
        for (int y = 6; y < 11; ++y) for (int x = 6; x < 11; ++x) at(x, y) = 0;  // 25 px hole
        at(8, 8) = 255;                                                   // 1 px speck inside it
        auto [holes, islands] = samps::detail::cleanMask(item, 4);
        require(at(3, 3) == 255, "Pinhole was not filled");
        require(at(6, 6) == 0, "Large hole was filled");
        require(at(8, 8) == 0, "Speck was not removed");
        require(holes == 1 && islands == 1, "Unexpected cleanup counts");
    }
    std::cout << checked << " prompt geometry cases passed; empty and invalid buffers rejected; mask cleanup passed\n";
    return 0;
} catch(const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
