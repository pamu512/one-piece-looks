/**
 * Share-card composer: client-side canvas PNG of the three looks plus the
 * lock swatch and wordmark. Save downloads this PNG; Share hands the real
 * File (image/png) to navigator.share. No burned-in text inside look
 * renders themselves; this card is deliberately branded output.
 */

export interface ShareCardLook {
  imageUrl: string;
  role: string;
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`image load failed: ${src.slice(0, 40)}`));
    img.src = src;
  });
}

/**
 * Compose the share card. 1080x1440 (3:4), dark editorial ground, three
 * mini renders in rounded tiles, lock swatch chip, wordmark footer.
 */
export async function composeShareCard(
  looks: ShareCardLook[],
  lockHex: string,
  lockCategory: string,
): Promise<Blob> {
  const W = 1080, H = 1440;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;

  // ground
  ctx.fillStyle = "#0c0d10";
  ctx.fillRect(0, 0, W, H);
  const wash = ctx.createRadialGradient(W / 2, 0, 0, W / 2, 0, W * 1.1);
  wash.addColorStop(0, `${lockHex}26`);
  wash.addColorStop(1, "transparent");
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, W, H);

  const pad = 60;
  const gap = 24;
  const tileW = (W - pad * 2 - gap * 2) / 3;
  const tileH = tileW * 1.25;
  const tilesY = 120;

  const imgs = await Promise.all(
    looks.slice(0, 3).map((l) => loadImage(l.imageUrl).catch(() => null)),
  );

  imgs.forEach((img, i) => {
    const x = pad + i * (tileW + gap);
    ctx.save();
    roundedRect(ctx, x, tilesY, tileW, tileH, 28);
    ctx.clip();
    if (img) {
      // cover-fit
      const ar = img.naturalWidth / img.naturalHeight;
      const tar = tileW / tileH;
      let sw = img.naturalWidth, sh = img.naturalHeight;
      if (ar > tar) sw = sh * tar; else ch: sh = sw / tar;
      ctx.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, x, tilesY, tileW, tileH);
    } else {
      ctx.fillStyle = "#1a1c23";
      ctx.fillRect(x, tilesY, tileW, tileH);
    }
    ctx.restore();
    // tile border
    ctx.strokeStyle = "rgba(255,255,255,0.14)";
    ctx.lineWidth = 2;
    roundedRect(ctx, x, tilesY, tileW, tileH, 28);
    ctx.stroke();
    // role label (chrome on the card, not in the renders)
    ctx.fillStyle = "rgba(244,242,238,0.92)";
    ctx.font = `600 34px -apple-system, "SF Pro Text", "Segoe UI", Helvetica, Arial, sans-serif`;
    ctx.textAlign = "center";
    const role = looks[i]?.role ?? "";
    ctx.fillText(role.toUpperCase(), x + tileW / 2, tilesY + tileH + 56);
  });

  // lock swatch chip
  const chipY = tilesY + tileH + 130;
  const chipW = 460, chipH = 84;
  const chipX = (W - chipW) / 2;
  ctx.save();
  roundedRect(ctx, chipX, chipY, chipW, chipH, chipH / 2);
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(chipX + 52, chipY + chipH / 2, 24, 0, Math.PI * 2);
  ctx.fillStyle = lockHex;
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.4)";
  ctx.stroke();
  ctx.fillStyle = "#f4f2ee";
  ctx.font = `500 32px -apple-system, "SF Pro Text", "Segoe UI", Helvetica, Arial, sans-serif`;
  ctx.textAlign = "left";
  ctx.fillText(`Your ${lockCategory}, kept`, chipX + 96, chipY + chipH / 2 + 11);
  ctx.restore();

  // wordmark
  ctx.fillStyle = "#7d7a72";
  ctx.font = `500 36px "New York", "Iowan Old Style", Palatino, Georgia, serif`;
  ctx.textAlign = "center";
  ctx.fillText("One piece. Three looks.", W / 2, H - 90);

  return await new Promise<Blob>((resolve, reject) => {
    c.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png");
  });
}

/** Share with a real image File; returns the outcome for copy. */
export async function shareLooksPng(
  blob: Blob,
  title: string,
  text: string,
): Promise<"shared" | "downloaded" | "cancelled" | "failed"> {
  const file = new File([blob], "one-piece-looks.png", { type: "image/png" });
  const nav = navigator as Navigator & {
    canShare?: (d: ShareData) => boolean;
    share?: (d: ShareData) => Promise<void>;
  };
  if (typeof nav.share === "function" && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title, text });
      return "shared";
    } catch (e) {
      if ((e as DOMException)?.name === "AbortError") return "cancelled";
      // fall through to download on non-user-cancel failure
    }
  }
  const ok = downloadBlob(blob, "one-piece-looks.png");
  return ok ? "downloaded" : "failed";
}

export function downloadBlob(blob: Blob, filename: string): boolean {
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return true;
  } catch {
    return false;
  }
}
