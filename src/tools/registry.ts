import { type ComponentType, type LazyExoticComponent, lazy } from "react";
import type { ToolProps } from "./types";

/**
 * Every tool page, loaded on demand so that pdf.js, document writers and the editor are only
 * downloaded by people who open those tools. A test asserts that each catalog entry has a component.
 */
export const TOOL_COMPONENTS: Record<string, LazyExoticComponent<ComponentType<ToolProps>>> = {
  merge: lazy(() => import("./merge/MergeTool")),
  split: lazy(() => import("./split/SplitTool")),
  "extract-pages": lazy(() => import("./pages/ExtractTool")),
  "delete-pages": lazy(() => import("./pages/DeleteTool")),
  organize: lazy(() => import("./organize/OrganizeTool")),
  rotate: lazy(() => import("./organize/RotateTool")),
  compress: lazy(() => import("./optimize/CompressTool")),
  repair: lazy(() => import("./security/RepairTool")),
  protect: lazy(() => import("./security/ProtectTool")),
  unlock: lazy(() => import("./security/UnlockTool")),
  metadata: lazy(() => import("./security/MetadataTool")),
  "word-to-pdf": lazy(() => import("./convert/OfficeToPdfTool")),
  "excel-to-pdf": lazy(() => import("./convert/OfficeToPdfTool")),
  "powerpoint-to-pdf": lazy(() => import("./convert/OfficeToPdfTool")),
  "pdf-to-word": lazy(() => import("./convert/PdfToOfficeTool")),
  "pdf-to-excel": lazy(() => import("./convert/PdfToOfficeTool")),
  "pdf-to-powerpoint": lazy(() => import("./convert/PdfToOfficeTool")),
  "jpg-to-pdf": lazy(() => import("./images/ImagesToPdfTool")),
  "pdf-to-jpg": lazy(() => import("./images/PdfToImagesTool")),
  edit: lazy(() => import("./edit/EditTool")),
  "page-numbers": lazy(() => import("./edit/PageNumbersTool")),
  watermark: lazy(() => import("./edit/WatermarkTool")),
  crop: lazy(() => import("./edit/CropTool")),
};
