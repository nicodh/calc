import { Model } from "@ironcalc/workbook";
import { getSessionId } from "./session";
import { ENGINE_LANGUAGE, ENGINE_LOCALE, ENGINE_TIMEZONE } from "./storage";

const XLSX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// Delta Chat shows the extension to the user, and the workbook carries the
// name on its own, so the suffix would only be repeated.
function workbookNameFromFile(fileName: string): string {
  const withoutExtension = fileName.replace(/\.xlsx$/i, "").trim();
  return withoutExtension === "" ? "Workbook" : withoutExtension;
}

/**
 * Asks Delta Chat for an .xlsx file. Resolves to null when the user picks
 * nothing.
 */
export async function pickXlsxFile(): Promise<File | null> {
  const files = await window.webxdc.importFiles({
    extensions: [".xlsx"],
    mimeTypes: [XLSX_MIME_TYPE],
    multiple: false,
  });
  return files[0] ?? null;
}

/**
 * Reads an .xlsx file into a workbook of its own, as a replica with this
 * device's session. It is a new workbook, not an edit of the shared one: the
 * app publishes it as a snapshot that replaces the shared workbook.
 *
 * The engine settings are forced rather than taken from the file, so that
 * every device evaluates the imported workbook the same way.
 */
export async function modelFromXlsxFile(file: File): Promise<Model> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return Model.fromXlsx(
    bytes,
    workbookNameFromFile(file.name),
    ENGINE_LOCALE,
    ENGINE_TIMEZONE,
    ENGINE_LANGUAGE,
    getSessionId(),
  );
}
