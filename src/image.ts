/**
 * Gemini bills an inline image in 768x768 tiles at 258 tokens per tile, so a capture
 * whose long edge is at most 768px costs one or two tiles where a raw 12MP phone photo
 * costs a dozen. 768px still resolves the small print on a nutrition panel, which is the
 * most demanding thing we ask the model to read.
 */
export const MAX_EDGE_PX = 768;

/** High enough that label text stays crisp, low enough that cellular uploads stay quick. */
export const JPEG_QUALITY = 0.8;

/** Why a capture was refused: wrong file kind, unreadable photo, or a canvas that would not encode. */
export type ImageCaptureErrorCode = "unsupported-type" | "decode-failed" | "encode-failed";

/** Typed capture failure, so the food editor can show a specific message instead of a generic one. */
export class ImageCaptureError extends Error {
  readonly code: ImageCaptureErrorCode;

  constructor(code: ImageCaptureErrorCode, message: string) {
    super(message);
    this.name = "ImageCaptureError";
    this.code = code;
  }
}

/** A downscaled JPEG ready to send as a Gemini inlineData part. */
export interface CapturedImage {
  /** Raw base64, with no data: URL prefix, ready for a Gemini inlineData part. */
  base64: string;
  mimeType: "image/jpeg";
  width: number;
  height: number;
  bytes: number;
}

/** The subset of ImageBitmap the resize pipeline needs, so tests can supply a plain object. */
export interface DecodedImage {
  width: number;
  height: number;
  close?: () => void;
}

/** Decode and re-encode are injected so the resize pipeline is testable without a canvas. */
export interface ImageCodec {
  decode: (source: Blob) => Promise<DecodedImage>;
  encode: (image: DecodedImage, width: number, height: number, quality: number) => Promise<Blob>;
}

/** Post-fit pixel dimensions; the aspect ratio always matches the source. */
export interface PreparedImageSize {
  width: number;
  height: number;
}

/** Fit inside MAX_EDGE_PX while preserving aspect ratio. Never upscales. */
export const targetSize = (width: number, height: number, maxEdge = MAX_EDGE_PX): PreparedImageSize => {
  const longest = Math.max(width, height);
  if (!Number.isFinite(longest) || longest <= 0) throw new ImageCaptureError("decode-failed", "The image reported no usable dimensions.");
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
};

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  // btoa takes a binary string; chunk it so a large photo cannot blow the argument limit.
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

const drawToCanvas = (image: DecodedImage, width: number, height: number): HTMLCanvasElement | OffscreenCanvas => {
  const canvas: HTMLCanvasElement | OffscreenCanvas = typeof OffscreenCanvas === "function"
    ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement("canvas"), { width, height });
  const context = (canvas as HTMLCanvasElement).getContext("2d");
  if (!context) throw new ImageCaptureError("encode-failed", "This browser did not provide a 2D drawing context.");
  context.drawImage(image as unknown as CanvasImageSource, 0, 0, width, height);
  return canvas;
};

/** Browser codec: honours EXIF orientation on decode and always re-encodes to JPEG. */
export const browserImageCodec: ImageCodec = {
  async decode(source) {
    try {
      return await createImageBitmap(source, { imageOrientation: "from-image" });
    } catch {
      throw new ImageCaptureError("decode-failed", "That photo could not be read. Try taking it again.");
    }
  },
  async encode(image, width, height, quality) {
    const canvas = drawToCanvas(image, width, height);
    if (canvas instanceof OffscreenCanvas) return canvas.convertToBlob({ type: "image/jpeg", quality });
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (!blob) throw new ImageCaptureError("encode-failed", "That photo could not be prepared for upload.");
    return blob;
  },
};

/** Overrides for prepareImage; every field defaults to the browser codec and the tile-aware constants. */
export interface PrepareImageOptions {
  codec?: ImageCodec;
  maxEdge?: number;
  quality?: number;
}

/**
 * Turn a camera or file-input selection into a downscaled JPEG payload.
 * The long edge is capped at maxEdge; smaller images are re-encoded but never enlarged.
 */
export const prepareImage = async (file: Blob, options: PrepareImageOptions = {}): Promise<CapturedImage> => {
  const { codec = browserImageCodec, maxEdge = MAX_EDGE_PX, quality = JPEG_QUALITY } = options;
  if (!file.type.startsWith("image/")) throw new ImageCaptureError("unsupported-type", "Choose a photo — that file is not an image.");

  const decoded = await codec.decode(file);
  try {
    const { width, height } = targetSize(decoded.width, decoded.height, maxEdge);
    const encoded = await codec.encode(decoded, width, height, quality);
    const bytes = new Uint8Array(await encoded.arrayBuffer());
    if (bytes.length === 0) throw new ImageCaptureError("encode-failed", "That photo could not be prepared for upload.");
    return { base64: toBase64(bytes), mimeType: "image/jpeg", width, height, bytes: bytes.length };
  } finally {
    decoded.close?.();
  }
};
