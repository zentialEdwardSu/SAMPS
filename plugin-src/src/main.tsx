import "./panel.css";
import React from "react";
import { createRoot } from "react-dom/client";
import { App, type Services } from "./ui/App";
import { PhotoshopHost } from "./host/PhotoshopHost";
import { NativeEngine } from "./host/NativeEngine";

declare const require: (name: string) => any;

const ADDON = "samps-0.5.0.uxpaddon";
const uxp = require("uxp");
const photoshop = require("photoshop");
const host = new PhotoshopHost(photoshop);

// Events that can change the active document, its size or history.
const EVENTS = ["open", "close", "select", "make", "delete", "set", "historyStateChanged",
  "canvasSize", "imageSize", "crop", "rotateEventEnum", "newDocument", "revert", "hide", "show"];

async function entry(folder: any, name: string) {
  try { return await folder.getEntry(name); } catch { return null; }
}

const services: Services = {
  host,
  loadEngine: async () => new NativeEngine(await require(ADDON)),
  // Bundled models live in the plugin's models/ folder; large downloads go in the data folder.
  async modelFolder(name) {
    const { localFileSystem } = uxp.storage;
    for (const root of [await localFileSystem.getPluginFolder(), await localFileSystem.getDataFolder()]) {
      const models = await entry(root, "models");
      const found = models && await entry(models, name);
      if (found && found.isFolder) return found;
    }
    return null;
  },
  pickFolder: () => uxp.storage.localFileSystem.getFolder(),
  subscribe(listener) {
    let scheduled = false;
    const handler = (event: string) => {
      // Choosing a brush/eraser (or a marks layer) while the marks are hidden reveals them.
      if (event === "select") host.revealMarksForPainting().catch(error => console.warn("SAMPS reveal marks:", error));
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => { scheduled = false; listener(); }, 50);
    };
    photoshop.action.addNotificationListener(EVENTS, handler);
    return () => { photoshop.action.removeNotificationListener(EVENTS, handler); };
  }
};

// Render immediately; panel show() is not delivered on every host build.
let root: ReturnType<typeof createRoot> | null = createRoot(document.getElementById("app")!);
root.render(<App services={services} />);
uxp.entrypoints.setup({
  plugin: { create() {}, destroy() { root?.unmount(); root = null; } },
  panels: { sampsPanel: { create() {}, show() {}, destroy() {} } }
});
