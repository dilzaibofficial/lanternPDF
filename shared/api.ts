/** Types shared by the browser app and the optional server (`GET /api/capabilities`, etc.). */

export interface EngineStatus {
  available: boolean;
  /** Version string reported by the engine, when it could be read. */
  version?: string;
  /** Why it is unavailable, in plain language, for the setup hint. */
  reason?: string;
}

export interface Capabilities {
  version: string;
  limits: {
    /** Largest accepted upload, in bytes. */
    maxUploadBytes: number;
  };
  engines: {
    libreoffice: EngineStatus;
    ghostscript: EngineStatus;
  };
}

export type OfficeTarget = "docx" | "pptx";

/** JSON error body returned by every failing /api route. */
export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}
