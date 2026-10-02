/** A real JPEG for the camera inputs: the client decodes it on a canvas, so it has to be one. */
import jpeg from "jpeg-js";

export const testJpeg = (seed = 1, width = 640, height = 480): Buffer => {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const x = i % width;
    const y = Math.floor(i / width);
    data[i * 4] = (x * seed) % 256;
    data[i * 4 + 1] = (y * 3) % 256;
    data[i * 4 + 2] = 90 + seed * 20;
    data[i * 4 + 3] = 255;
  }
  return jpeg.encode({ data, width, height }, 80).data;
};

export const jpegFile = (name: string, seed = 1): { name: string; mimeType: string; buffer: Buffer } => ({ name, mimeType: "image/jpeg", buffer: testJpeg(seed) });

export interface LotPhotos {
  photos: Array<{ id: number; kind: "before" | "after"; canDelete: boolean }>;
}
