/* Renders waveform tiles off the main thread, so drawing new detail never
 * costs the timeline a frame. */
import { drawTile, TILE_W, type TileJob } from "./wave-draw";

let canvas: OffscreenCanvas | null = null;

self.onmessage = (e: MessageEvent<TileJob & { id: number }>) => {
  const job = e.data;
  canvas ??= new OffscreenCanvas(TILE_W + 2, job.h);
  if (canvas.height !== job.h) canvas.height = job.h;
  drawTile(canvas.getContext("2d")!, job);
  const bmp = canvas.transferToImageBitmap();
  (self as unknown as Worker).postMessage({ id: job.id, bmp }, [bmp]);
};
