/**
 * Decode look images before the carousel mounts. decode() can reject
 * without firing error; the cap keeps a stuck decode from holding the veil.
 */
export interface WarmImage {
  src: string;
  complete: boolean;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  decode?: () => Promise<void>;
}

const DECODE_CAP_MS = 1000;

export function warmDecode(
  urls: readonly string[],
  // DOM Image's onload handler is not the same function type as WarmImage.
  create: () => WarmImage = () => new Image() as unknown as WarmImage,
  capMs = DECODE_CAP_MS,
): Promise<void> {
  return Promise.all(urls.map((url) => settle(url, create, capMs))).then(() => undefined);
}

function settle(url: string, create: () => WarmImage, capMs: number): Promise<void> {
  if (!url) return Promise.resolve();
  return new Promise((res) => {
    const img = create();
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      res();
    };
    const kick = () => {
      if (typeof img.decode === "function") img.decode().then(done, done);
      else done();
    };
    timer = setTimeout(done, capMs);
    img.onload = kick;
    img.onerror = done;
    img.src = url;
    if (img.complete) kick();
  });
}
