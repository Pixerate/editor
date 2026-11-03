import { combineStickerProviders, createFakeStickerProvider, editorStickers } from "@pixerate/editor/stickers";

/**
 * The demo's sticker library: the editor's own stamps plus a stand-in host library (the fake
 * provider: weather, fruit, badges), shared by the paint, vector, image and canvas tabs.
 */
export const demoStickers = combineStickerProviders([editorStickers(), createFakeStickerProvider()], { name: "Demo stickers" });
