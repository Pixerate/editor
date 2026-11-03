/**
 * `@pixerate/editor/stickers`: the sticker provider contract (dependency-free). A host plugs in
 * any sticker library (`StickerProvider`); the editor's own stamps are the built-in set
 * (`editorStickers()`, the default in every `StickersSlot`). Also: a conformance checker, a fake
 * provider for tests, combining providers, and the `find_stickers` / `describe_sticker` tools.
 */

export * from './types';
export * from './errors';
export * from './helpers';
export * from './stamps';
export { editorStickers, stampOutline, stampPixels } from './editor';
export { createFakeStickerProvider, type FakeStickerProviderOptions } from './fake';
export { combineStickerProviders } from './combine';
export { checkStickerProvider, type StickerConformanceIssue, type StickerConformanceOptions } from './conformance';
export { createInsertStickerTool, insertSticker, createStickerTools, createStickerToolProvider, describeStickerRef, stickerForAgent, type StickerInsertHost, type StickerPlacement, type StickerToolsOptions } from './tools';
export { StickerBrowser, type StickerBrowserItem, type StickerBrowserState } from './browser';
