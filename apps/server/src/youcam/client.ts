/**
 * YouCam s2s client: file upload, skin-analysis v2.1, skin-tone-analysis v2.0,
 * makeup-vto v2.0. Typed wrapper with timeouts, polling, and structured errors.
 *
 * Grounded in docs.perfectcorp.com OpenAPI bundles (fetched 2026-09-30):
 * - POST /s2s/v2.0/file               register upload -> presigned PUT
 * - POST /s2s/v2.1/task/skin-analysis dst_actions: ["hd_skin_type"], format: json
 * - GET  /s2s/v2.1/task/skin-analysis/{task_id}
 * - POST /s2s/v2.0/task/skin-tone-analysis
 * - GET  /s2s/v2.0/task/skin-tone-analysis/{task_id}
 * - POST /s2s/v2.0/task/makeup-vto    effects[]
 * - GET  /s2s/v2.0/task/makeup-vto/{task_id}
 */

export const YOUCAM_BASE_URL = "https://yce-api-01.makeupar.com";

const REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_PUT_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 2_000;
const MAX_POLLS = 60; // 2 min per task at 2s interval

/** Structured YouCam failure the routes can map to retryable/calm-card errors. */
export class YoucamError extends Error {
  constructor(
    message: string,
    readonly code:
      | "network"
      | "auth"
      | "credit"
      | "engine"
      | "face"
      | "timeout"
      | "unknown",
    readonly status?: number,
    readonly retryable: boolean = code === "network" || code === "timeout",
  ) {
    super(message);
    this.name = "YoucamError";
  }
}

function headers(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

async function fetchJson(
  url: string,
  init: RequestInit,
  what: string,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new YoucamError(`${what}: network failure (${String(e)})`, "network");
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  if (!res.ok) {
    const errCode = typeof body.error_code === "string" ? body.error_code : undefined;
    const errMsg =
      typeof body.error === "string" ? body.error : `HTTP ${res.status} from ${what}`;
    if (res.status === 401) throw new YoucamError(errMsg, "auth", res.status, false);
    if (errCode === "CreditInsufficiency" || errCode === "InsufficientCredit")
      throw new YoucamError(errMsg, "credit", res.status, false);
    if ([429, 500, 502, 503, 504].includes(res.status))
      throw new YoucamError(errMsg, "network", res.status, true);
    throw new YoucamError(errMsg, "unknown", res.status, false);
  }
  return body;
}

/** Convert a base64 JPEG payload to Uint8Array for the presigned PUT. */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface UploadResult {
  fileId: string;
}

/** Register + PUT one image. Returns the file_id used by all task APIs. */
export async function uploadFile(
  apiKey: string,
  base64Jpeg: string,
  baseUrl = YOUCAM_BASE_URL,
): Promise<UploadResult> {
  const bytes = base64ToBytes(base64Jpeg);
  const meta = await fetchJson(
    `${baseUrl}/s2s/v2.0/file`,
    {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify({
        files: [
          {
            content_type: "image/jpeg",
            file_name: "capture.jpg",
            file_size: bytes.byteLength,
          },
        ],
      }),
    },
    "file register",
  );
  let info: unknown;
  try {
    info = ((meta.data as Record<string, unknown>).files as unknown[])[0];
  } catch {
    throw new YoucamError("file register: unexpected response shape", "unknown");
  }
  const file = info as { file_id: string; requests: { method: string; url: string; headers?: Record<string, string> }[] };
  const put = file.requests[0];
  if (!put || typeof put.url !== "string" || typeof file.file_id !== "string") {
    throw new YoucamError("file register: missing presigned PUT", "unknown");
  }
  const putRes = await fetch(put.url, {
    method: "PUT",
    headers: put.headers ?? { "Content-Type": "image/jpeg" },
    body: bytes,
  }).catch((e) => {
    throw new YoucamError(`file upload: network failure (${String(e)})`, "network");
  });
  if (!putRes.ok) {
    throw new YoucamError(`file upload: HTTP ${putRes.status}`, putRes.status >= 500 ? "network" : "unknown", putRes.status);
  }
  return { fileId: file.file_id };
}

type TaskStatus = "running" | "success" | "error";

interface TaskData {
  task_status?: string;
  error?: string;
  error_message?: string;
  results?: unknown;
}

async function pollTask(
  apiKey: string,
  taskPath: string,
  taskId: string,
  baseUrl: string,
): Promise<TaskData> {
  const url = `${baseUrl}${taskPath}/${encodeURIComponent(taskId)}`;
  let last: TaskData = {};
  for (let i = 0; i < MAX_POLLS; i++) {
    const body = await fetchJson(url, { headers: headers(apiKey) }, `poll ${taskPath}`);
    const data = (body.data ?? {}) as TaskData;
    last = data;
    if (data.task_status === "success" || data.task_status === "error") return data;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new YoucamError(`task ${taskId}: timed out after ${MAX_POLLS} polls`, "timeout");
}

/** Classification for an engine error code we can translate for the user. */
export function classifyEngineError(code: string | undefined): YoucamError {
  switch (code) {
    case "error_no_face":
    case "error_pose":
    case "error_face_parsing":
    case "error_face_position_invalid":
    case "error_face_position_too_small":
    case "error_face_position_out_of_boundary":
    case "error_face_angle_invalid":
    case "error_src_face_too_small":
    case "error_src_face_out_of_bound":
    case "error_lighting_dark":
      return new YoucamError("face could not be read", "face", undefined, false);
    default:
      return new YoucamError(`engine error: ${code ?? "unknown"}`, "engine", undefined, true);
  }
}

// ---------------------------------------------------------------------------
// Skin analysis v2.1 — hd_skin_type only
// ---------------------------------------------------------------------------

export interface SkinTypeRegion {
  region: "whole" | "t_zone" | "u_zone";
  skin_type: string;
}

export interface SkinAnalysisOutcome {
  whole: string;
  tZone?: string | undefined;
  uZone?: string | undefined;
}

/** One HD pass requesting ONLY hd_skin_type (HD/SD never mixed). */
export async function runSkinAnalysis(
  apiKey: string,
  fileId: string,
  baseUrl = YOUCAM_BASE_URL,
): Promise<SkinAnalysisOutcome> {
  const create = await fetchJson(
    `${baseUrl}/s2s/v2.1/task/skin-analysis`,
    {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify({
        src_file_id: fileId,
        dst_actions: ["hd_skin_type"],
        format: "json",
      }),
    },
    "skin-analysis create",
  );
  const taskId = ((create.data as Record<string, unknown>)?.task_id as string) ?? "";
  if (!taskId) throw new YoucamError("skin-analysis: no task_id in response", "unknown");
  const done = await pollTask(apiKey, "/s2s/v2.1/task/skin-analysis", taskId, baseUrl);
  if (done.task_status === "error") throw classifyEngineError(done.error);
  const output = ((done.results as Record<string, unknown>)?.output ?? []) as SkinTypeRegion[];
  const whole = output.find((o) => o.region === "whole");
  if (!whole || typeof whole.skin_type !== "string") {
    throw new YoucamError("skin-analysis: no whole-face skin_type in output", "engine");
  }
  return {
    whole: whole.skin_type,
    tZone: output.find((o) => o.region === "t_zone")?.skin_type,
    uZone: output.find((o) => o.region === "u_zone")?.skin_type,
  };
}

// ---------------------------------------------------------------------------
// Skin tone v2.0 (the separate face-tone API)
// ---------------------------------------------------------------------------

export interface SkinToneOutcome {
  skinColor: string;
}

export async function runSkinTone(
  apiKey: string,
  fileId: string,
  baseUrl = YOUCAM_BASE_URL,
): Promise<SkinToneOutcome> {
  const create = await fetchJson(
    `${baseUrl}/s2s/v2.0/task/skin-tone-analysis`,
    {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify({ src_file_id: fileId }),
    },
    "skin-tone create",
  );
  const taskId = ((create.data as Record<string, unknown>)?.task_id as string) ?? "";
  if (!taskId) throw new YoucamError("skin-tone: no task_id in response", "unknown");
  const done = await pollTask(apiKey, "/s2s/v2.0/task/skin-tone-analysis", taskId, baseUrl);
  if (done.task_status === "error") throw classifyEngineError(done.error);
  const color = (done.results as Record<string, unknown>)?.color as
    | { skin_color?: string }
    | undefined;
  const skinColor = color?.skin_color;
  if (typeof skinColor !== "string" || !/^#[0-9a-fA-F]{6}$/.test(skinColor)) {
    throw new YoucamError("skin-tone: no skin_color in results", "engine");
  }
  return { skinColor: skinColor.toLowerCase() };
}

// ---------------------------------------------------------------------------
// Makeup VTO v2.0
// ---------------------------------------------------------------------------

/** Effect objects, exactly as the API expects them. */
export type VtoEffect = Record<string, unknown>;

export interface VtoResponse {
  imageUrl: string;
}

export async function runMakeupVto(
  apiKey: string,
  fileId: string,
  effects: VtoEffect[],
  baseUrl = YOUCAM_BASE_URL,
): Promise<VtoResponse> {
  const create = await fetchJson(
    `${baseUrl}/s2s/v2.0/task/makeup-vto`,
    {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify({ src_file_id: fileId, effects, version: "1.0" }),
    },
    "makeup-vto create",
  );
  const taskId = ((create.data as Record<string, unknown>)?.task_id as string) ?? "";
  if (!taskId) throw new YoucamError("makeup-vto: no task_id in response", "unknown");
  const done = await pollTask(apiKey, "/s2s/v2.0/task/makeup-vto", taskId, baseUrl);
  if (done.task_status === "error") throw classifyEngineError(done.error);
  const results = done.results as
    | { url?: string; download_url?: string }
    | { results?: { url?: string }[] }
    | undefined;
  let url: string | undefined;
  if (results && "url" in results && typeof results.url === "string") url = results.url;
  else if (results && "download_url" in results && typeof results.download_url === "string")
    url = results.download_url;
  else if (results && "results" in results && Array.isArray(results.results)) {
    const first = results.results[0] as { url?: string } | undefined;
    if (first && typeof first.url === "string") url = first.url;
  }
  if (!url) throw new YoucamError("makeup-vto: no result url", "engine");
  return { imageUrl: url };
}
