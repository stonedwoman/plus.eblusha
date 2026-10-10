/** Растр в памяти (сырые пиксели) и разбор PNG карты/тумана через sharp. */
import sharp from "sharp";

export interface Raster {
  data: Buffer;
  width: number;
  height: number;
  channels: 1 | 3 | 4;
}

/** PNG → сырые пиксели: 4 канала (RGBA) для карты, 1 (яркость) для тумана. */
export async function decodePng(png: Buffer, channels: 1 | 4): Promise<Raster> {
  const img = sharp(png, { limitInputPixels: 4096 * 4096 });
  const pipeline = channels === 1 ? img.extractChannel(0) : img.ensureAlpha();
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels as 1 | 3 | 4 };
}
