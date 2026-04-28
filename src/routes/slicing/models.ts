export interface SlicingSettings {
  printer?: string;
  preset?: string;
  // Single legacy filament name (kept for backwards-compat with clients that
  // pre-date multi-color support).
  filament?: string;
  // Multi-color: comma- or semicolon-separated filament names. Equivalent to
  // sending multiple `filamentProfile` parts; the body form is for clients
  // that pick by-name on disk rather than uploading content.
  filaments?: string;
  bedType?: string;
  plate?: string;
  multicolorOnePlate?: boolean;
  arrange?: boolean;
  orient?: boolean;
  exportType?: "gcode" | "3mf";
  // Optional caller-provided id used to publish live progress to the
  // ProgressStore. The same id is read back via `GET /slice/progress/:id`
  // so a polling client can show "Generating G-code (75%)" while the
  // sync /slice POST is still in flight.
  requestId?: string;
}

export interface SliceResult {
  gcodes: string[];
  workdir: string;
}

export interface SliceMetaData {
  printTime: number; //print time in seconds
  filamentUsedG: number; // filament used in grams
  filamentUsedMm: number; // total length of filament used in millimeters
}

export type Category = "printers" | "presets" | "filaments";

export interface UploadedProfiles {
  printer?: Buffer;
  preset?: Buffer;
  // Multi-color: one Buffer per filament slot, in plate order. Empty / single
  // entries handled identically by the slicing service so legacy single-color
  // clients continue to work without changes.
  filaments?: Buffer[];
}
