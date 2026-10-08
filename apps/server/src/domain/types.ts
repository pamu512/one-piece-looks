/**
 * Shared domain types for One Piece Looks.
 *
 * These types are the client/server contract. The client owns capture and
 * sampling; the server owns everything that touches YouCam: skin analysis,
 * face tone, look recipes, and renders.
 */

/** Makeup categories the product supports. */
export type Category = "lip" | "cheek" | "eye" | "brow" | "liner";

export const CATEGORIES: readonly Category[] = ["lip", "cheek", "eye", "brow", "liner"] as const;

/** Moods, exactly as specced. No defaults; both mood and event are required. */
export const MOODS = [
  "Bitch mode",
  "Boss",
  "Demure",
  "Owning it",
  "Sexy",
  "Soft",
  "Clean",
  "Main character",
] as const;
export type Mood = (typeof MOODS)[number];

/** Events, exactly as specced. */
export const EVENTS = [
  "Dinner date",
  "Office",
  "Casual",
  "Workout",
  "Night out",
  "Wedding guest",
  "Errands",
  "Interview",
] as const;
export type Event = (typeof EVENTS)[number];

/** YouCam hd_skin_type values we may receive (whole face). */
export type SkinType =
  | "Normal"
  | "Oily"
  | "Dry"
  | "Combination"
  | "Redness"
  | "Dry & Redness"
  | "Oily & Redness"
  | "Combination & Redness";

/** Face tone depth options for the manual picker (used when face-tone API fails). */
export const TONE_DEPTHS = [
  "01",
  "02",
  "03",
  "04",
  "05",
  "06",
] as const;
export type ToneDepth = (typeof TONE_DEPTHS)[number];

/** Undertone temperature. */
export type ToneTemperature = "warm" | "neutral" | "cool";

/**
 * Tone as consumed by the recipe builder.
 * - API path: `{ source: "api", skinColor }` from skin-tone-analysis.
 * - Fallback path: `{ source: "picker", depth, temperature }` when the
 *   face-tone API fails; the client shows the six-depth/three-temperature
 *   picker (two taps max).
 */
export type Tone =
  | { source: "api"; skinColor: string }
  | { source: "picker"; depth: ToneDepth; temperature: ToneTemperature };

/** What one sample of a color is: a hex plus where it came from. */
export interface ColorSample {
  /** #RRGGBB */
  hex: string;
}

/** The lock: the on-face color the whole look builds around. */
export interface Lock {
  category: Category;
  /** On-face worn-zone hex, sampled by the client. */
  onFaceHex: string;
  /** Product (pan/bullet/pencil) hex, sampled by the client. */
  productHex: string;
  /** True when the user bypassed retake gates ("Continue anyway"). */
  unverified: boolean;
}

/** Look roles. Always three, always these names. */
export const LOOK_ROLES = ["anchor", "lift", "statement"] as const;
export type LookRole = (typeof LOOK_ROLES)[number];

/** A human-readable recipe chip for one layer of a look. */
export interface RecipeChip {
  /** Layer label, e.g. "Lip", "Cheek", "Contour". */
  label: string;
  /** Short descriptor, e.g. "matte brick", "soft rose". */
  detail: string;
  /** #RRGGBB shown in the chip. */
  hex: string;
}

/** One finished look. */
export interface Look {
  role: LookRole;
  /** Rendered full-face image (data URL in mock mode, https URL live). */
  imageUrl: string;
  /** Recipe chips, lock first. */
  chips: RecipeChip[];
  /** Present only when this look adds a product beyond the starting one. */
  shop?: { label: string; url: string };
  /** True when the lock was rendered via the nearest named shade fallback. */
  lockApproximated: boolean;
}

/** POST /api/session/:id/face — start analysis after face photo accepted. */
export interface FaceAnalysisRequest {
  /** Client-captured face photo, base64 JPEG. */
  faceImageBase64: string;
  /** The lock established on the Shift screen. */
  lock: Lock;
  /**
   * Manual tone (from the client picker). Required only on the fallback path,
   * i.e. when the response reports toneFallback: true and the user has picked.
   */
  tone?: { depth: ToneDepth; temperature: ToneTemperature };
  /**
   * Optional client-detected face landmarks (fractional 4:5 coordinates).
   * Additive: used by mock compositing to align patches to the real face.
   */
  landmarks?: {
    faceBox?: { x: number; y: number; w: number; h: number };
    lip?: [number, number][];
    lipInner?: [number, number][];
    /** CIE L* of the lip flesh, 0..100. Values outside that range are dropped. */
    lipMeanL?: number;
    /** CIE a* of the lip flesh, -128..127. Values outside that range are dropped. */
    lipMeanA?: number;
    /** CIE b* of the lip flesh, -128..127. Values outside that range are dropped. */
    lipMeanB?: number;
    /** Class-1 skin contour. */
    skin?: [number, number][];
    eyeL?: [number, number][];
    eyeR?: [number, number][];
    browL?: [number, number][];
    browR?: [number, number][];
    cheekL?: [number, number][];
    cheekR?: [number, number][];
  };
}

/** Result of the face analysis step. */
export interface FaceAnalysisResult {
  sessionId: string;
  /** From YouCam hd_skin_type (whole face). Omitted only if analysis failed entirely. */
  skinType?: SkinType;
  /** True when the face-tone API failed and the client must show the picker. */
  toneFallback: boolean;
  /** Present when the tone API succeeded. */
  tone?: Tone;
  /** Present when the tone API succeeded: face tone as #RRGGBB. */
  toneHex?: string;
}

/** POST /api/session/:id/looks — build the three looks. */
export interface BuildLooksRequest {
  mood: Mood;
  event: Event;
  /** Re-send in case analysis went the fallback route. */
  tone?: { depth: ToneDepth; temperature: ToneTemperature };
}

/** Response with the three looks. */
export interface LooksResult {
  sessionId: string;
  looks: Look[];
  /** Remaining shared render budget (initial build + shuffles). */
  rendersLeft: number;
  /** True when the lock was approximated by the nearest named shade. */
  lockApproximated: boolean;
}

/** POST /api/session/:id/shuffle — re-roll supporting layers only. */
export interface ShuffleResult extends LooksResult {}

/** Error shape every non-2xx returns. */
export interface ApiError {
  error: string;
  code: string;
  retryable: boolean;
}
