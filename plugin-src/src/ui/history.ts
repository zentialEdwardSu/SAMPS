import type { Instance } from "../host/NativeEngine";
import type { Capture } from "../host/PhotoshopHost";
import type { Stamp } from "../core/document";

/** Panel results as they were at one Photoshop history state. */
export interface ResultsAt { instances: Instance[]; selected: number[]; snapshot: Capture | null }

export const stampKey = (stamp: Stamp) => `${stamp.documentId}:${stamp.historyId}`;

/**
 * Remembers the panel results at each history state the plugin itself produced (preview created,
 * changed or removed, marks shown or hidden, output), so Photoshop's undo / redo can bring the
 * matching instance list back instead of discarding it. Each snapshot keeps the image it was
 * recognised on alive, so only the newest few distinct images are kept.
 */
export class ResultsHistory {
  private entries = new Map<string, ResultsAt>();
  constructor(private maxEntries = 64, private maxImages = 3) {}

  record(stamp: Stamp, results: ResultsAt) {
    const k = stampKey(stamp);
    this.entries.delete(k);  // re-insert as newest
    this.entries.set(k, { ...results, snapshot: results.snapshot ? { ...results.snapshot, stamp } : null });
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    // Drop the oldest entries of images beyond the newest maxImages.
    const images: Uint8Array[] = [];
    for (const entry of [...this.entries.values()].reverse()) {
      const rgba = entry.snapshot?.rgba;
      if (rgba && !images.includes(rgba)) images.push(rgba);
    }
    if (images.length > this.maxImages) {
      const kept = new Set(images.slice(0, this.maxImages));
      for (const [k2, entry] of this.entries) if (entry.snapshot && !kept.has(entry.snapshot.rgba)) this.entries.delete(k2);
    }
  }

  get(stamp: Stamp): ResultsAt | undefined {
    const entry = this.entries.get(stampKey(stamp));
    // A history state recorded for another canvas size is not this one.
    if (entry?.snapshot && (entry.snapshot.stamp.width !== stamp.width || entry.snapshot.stamp.height !== stamp.height)) return undefined;
    return entry;
  }

  clear() { this.entries.clear(); }
}
