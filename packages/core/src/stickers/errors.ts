export type StickerErrorCode = 'unknown_sticker' | 'unknown_provider' | 'unsupported_format' | 'no_provider' | 'load_failed' | 'invalid_argument';

/** A refusal from a sticker provider or the sticker tools. The message says what to do instead. */
export class StickerError extends Error {
  constructor(
    readonly code: StickerErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'StickerError';
  }
}
