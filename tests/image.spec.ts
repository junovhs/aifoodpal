// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { ImageCaptureError, MAX_EDGE_PX, prepareImage, targetSize, type DecodedImage, type ImageCodec } from "../src/image";

const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08]);

const fakeCodec = (width: number, height: number, close = vi.fn()) => {
  const encode = vi.fn(async (_image: DecodedImage, _width: number, _height: number, _quality: number) => new Blob([jpegBytes], { type: "image/jpeg" }));
  const codec: ImageCodec = { decode: async () => ({ width, height, close }), encode };
  return { codec, encode, close };
};

const photo = (type = "image/jpeg") => new Blob([jpegBytes], { type });

describe("capture downscaling", () => {
  it("fits a landscape photo inside one row of Gemini tiles", () => {
    expect(targetSize(2400, 1600)).toEqual({ width: 768, height: 512 });
    expect(MAX_EDGE_PX).toBe(768);
  });

  it("keeps the long edge on the correct axis for a portrait photo", () => {
    expect(targetSize(1600, 2400)).toEqual({ width: 512, height: 768 });
  });

  it("never upscales an image that is already small", () => {
    expect(targetSize(300, 200)).toEqual({ width: 300, height: 200 });
  });

  it("rejects an image that reports no usable dimensions", () => {
    expect(() => targetSize(0, 0)).toThrowError(ImageCaptureError);
  });
});

describe("prepareImage", () => {
  it("encodes at the downscaled size and returns raw base64 for an inline Gemini part", async () => {
    const { codec, encode, close } = fakeCodec(2400, 1600);

    const result = await prepareImage(photo(), { codec });

    expect(encode).toHaveBeenCalledWith(expect.objectContaining({ width: 2400, height: 1600 }), 768, 512, 0.8);
    expect(result).toMatchObject({ mimeType: "image/jpeg", width: 768, height: 512, bytes: jpegBytes.length });
    expect(result.base64).toBe("/9j/2wBDAAg=");
    expect(result.base64).not.toContain("data:");
    expect(close).toHaveBeenCalled();
  });

  it("re-encodes a small photo without enlarging it", async () => {
    const { codec, encode } = fakeCodec(300, 200);

    const result = await prepareImage(photo(), { codec });

    expect(encode).toHaveBeenCalledWith(expect.anything(), 300, 200, 0.8);
    expect(result).toMatchObject({ width: 300, height: 200 });
  });

  it("refuses a file that is not an image before decoding it", async () => {
    const decode = vi.fn();
    const codec: ImageCodec = { decode, encode: vi.fn() };

    await expect(prepareImage(new Blob(["notes"], { type: "text/plain" }), { codec })).rejects.toMatchObject({
      name: "ImageCaptureError",
      code: "unsupported-type",
    });
    expect(decode).not.toHaveBeenCalled();
  });

  it("reports a typed error when the photo cannot be decoded", async () => {
    const codec: ImageCodec = {
      decode: async () => { throw new ImageCaptureError("decode-failed", "unreadable"); },
      encode: vi.fn(),
    };

    await expect(prepareImage(photo("image/heic"), { codec })).rejects.toMatchObject({ code: "decode-failed" });
  });

  it("releases the decoded bitmap even when encoding fails", async () => {
    const close = vi.fn();
    const codec: ImageCodec = {
      decode: async () => ({ width: 1200, height: 900, close }),
      encode: async () => { throw new ImageCaptureError("encode-failed", "no context"); },
    };

    await expect(prepareImage(photo(), { codec })).rejects.toMatchObject({ code: "encode-failed" });
    expect(close).toHaveBeenCalled();
  });
});
