import { expect, type Page } from "@playwright/test";
import {
  installHost,
  stageImportFile,
  waitUntilEstablished,
  type Payload,
  type SentFile,
} from "./host";
import {
  type Device,
  edit,
  exchange,
  expectConverged,
  fingerprint,
  sheetNames,
  test,
  value,
} from "./peers";

// Exporting sends the workbook to a chat as .xlsx. Importing replaces the
// shared workbook with an .xlsx file, for everyone: the file becomes a workbook
// of the next generation (see src/components/bootstrap.ts), and when the
// workbook already holds changes, the user is asked first.

// A real Excel-produced workbook with ten sheets, A1 of the first being
// "A string", served by the dev server straight out of the vendored tree.
const EXAMPLE_URL = "/vendor/ironcalc/bindings/nodejs/example.xlsx";

const IMPORT = { name: "Replace workbook with .xlsx" };
const EXPORT = { name: "Send as .xlsx" };

// Names of the parts an xlsx must contain. Zip stores entry names uncompressed,
// so they can be found in the raw bytes without unpacking the archive.
const REQUIRED_PARTS = ["[Content_Types].xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"];

// Records every dialog the page opens, answering confirms with `answer`.
function dialogs(page: Page, answer: "accept" | "dismiss" = "accept") {
  const seen: { type: string; message: string }[] = [];
  page.on("dialog", async (dialog) => {
    seen.push({ type: dialog.type(), message: dialog.message() });
    if (answer === "accept") {
      await dialog.accept();
    } else {
      await dialog.dismiss();
    }
  });
  return seen;
}

async function importExample(device: Device) {
  await stageImportFile(device.page, EXAMPLE_URL, "example.xlsx");
  await device.page.getByRole("button", IMPORT).click();
}

async function sheetCount(device: Device) {
  return (await sheetNames(device)).length;
}

test.describe("exporting", () => {
  test("sends a valid xlsx named after the workbook, without a status update", async ({
    page,
  }) => {
    const history: Payload[] = [];
    const sentFiles: SentFile[] = [];
    await installHost(page, history, { sentFiles });
    await page.goto("/");
    await waitUntilEstablished(page);
    await page.evaluate(() => {
      window.__model!.setUserInput(0, 1, 1, "Revenue");
      window.__model!.setUserInput(0, 2, 1, "10");
      window.__model!.setUserInput(0, 3, 1, "=A2*2");
    });
    await expect.poll(() => history.length).toBe(2);

    await page.getByRole("button", EXPORT).click();
    await expect.poll(() => sentFiles.length).toBe(1);

    const name = await page.evaluate(() => window.__model!.getName());
    expect(sentFiles[0].name).toBe(`${name}.xlsx`);
    const bytes = atob(sentFiles[0].base64);
    expect(bytes.startsWith("PK\x03\x04")).toBe(true);
    for (const part of REQUIRED_PARTS) {
      expect(bytes).toContain(part);
    }
    // Readable again, with what was typed.
    const readBack = await page.evaluate((base64) => {
      const M = (window.__model as unknown as { constructor: any }).constructor;
      const data = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const copy = M.fromXlsx(data, "copy", "en", "UTC", "en", 7);
      return [copy.getFormattedCellValue(0, 1, 1), copy.getFormattedCellValue(0, 3, 1)];
    }, sentFiles[0].base64);
    expect(readBack).toEqual(["Revenue", "20"]);

    // Exporting is not an edit: nothing went to the other devices.
    await page.waitForTimeout(1500);
    expect(history).toHaveLength(2);
  });
});

test.describe("importing", () => {
  test("an untouched workbook is replaced without asking, for the other devices too", async ({
    peers,
  }) => {
    const [a, b] = await peers(2);
    const asked = dialogs(a.page);

    await importExample(a);
    await expect.poll(() => sheetCount(a)).toBe(10);
    expect(await value(a, 1, 1)).toBe("A string");
    expect(await a.page.evaluate(() => window.__model!.getName())).toBe("example");
    expect(asked).toEqual([]);
    expect(a.sent[a.sent.length - 1]).toMatchObject({
      kind: "snapshot",
      epoch: 1,
      imported: true,
    });

    await exchange([a, b]);
    await expect.poll(() => sheetCount(b)).toBe(10);
    await expectConverged([a, b]);
  });

  test("a workbook with changes asks first: no keeps it, yes replaces it everywhere", async ({
    peers,
  }) => {
    const [a, b] = await peers(2);
    await edit(a, (m) => m.setUserInput(0, 1, 1, "keep me"));
    await exchange([a, b]);

    // Declined: nothing changes, and nothing goes out.
    const declined = dialogs(a.page, "dismiss");
    const sentBefore = a.sent.length;
    await importExample(a);
    await expect.poll(() => declined.length).toBe(1);
    expect(declined[0].type).toBe("confirm");
    expect(declined[0].message).toContain("already has changes");
    await a.page.waitForTimeout(500);
    expect(await value(a, 1, 1)).toBe("keep me");
    expect(await sheetCount(a)).toBe(1);
    expect(a.sent.length).toBe(sentBefore);
    a.page.removeAllListeners("dialog");

    // Accepted: replaced here, and on the other device.
    dialogs(a.page, "accept");
    await importExample(a);
    await expect.poll(() => sheetCount(a)).toBe(10);
    await exchange([a, b]);
    await expect.poll(() => sheetCount(b)).toBe(10);
    const workbook = await expectConverged([a, b]);
    expect(workbook).not.toContain("keep me");
  });

  test("edits still made on the replaced workbook do not leak into the imported one", async ({
    peers,
  }) => {
    const [a, b] = await peers(2);
    await edit(a, (m) => m.setUserInput(0, 1, 1, "before"));
    await exchange([a, b]);

    dialogs(a.page, "accept");
    await importExample(a);
    await expect.poll(() => sheetCount(a)).toBe(10);
    // B has not heard of the import yet and keeps editing the old workbook.
    await edit(b, (m) => m.setUserInput(0, 5, 5, "late on the old one"));

    await exchange([a, b]);
    await expect.poll(() => sheetCount(b)).toBe(10);
    const workbook = await expectConverged([a, b]);
    expect(workbook).not.toContain("late on the old one");

    // On the imported workbook, edits cross as usual.
    await edit(b, (m) => m.setUserInput(0, 6, 6, "on the new one"));
    await exchange([a, b]);
    await expect.poll(() => value(a, 6, 6)).toBe("on the new one");
  });

  test("a device joining later starts from the imported workbook", async ({
    peers,
    browser,
    baseURL,
  }) => {
    const [a] = await peers(1);
    await edit(a, (m) => m.setUserInput(0, 1, 1, "replaced"));
    dialogs(a.page, "accept");
    await importExample(a);
    await expect.poll(() => sheetCount(a)).toBe(10);
    await edit(a, (m) => m.setUserInput(0, 6, 6, "after the import"));
    // The log now holds both generations: the first workbook and its edit,
    // then the imported one and its edit.
    expect(a.sent.map((u) => `${u.kind ?? "diff"}@${u.epoch ?? 0}`)).toEqual([
      "snapshot@0",
      "diff@0",
      "snapshot@1",
      "diff@1",
    ]);

    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await installHost(page, [], { replay: a.sent.slice() });
      await page.goto(baseURL!);
      await waitUntilEstablished(page);
      const c: Device = { name: "C", page, sent: [], received: new Map() };
      await expect.poll(() => sheetCount(c)).toBe(10);
      expect(await fingerprint(c)).toBe(await fingerprint(a));
      expect(await value(c, 6, 6)).toBe("after the import");
    } finally {
      await context.close();
    }
  });

  test("a file that is not a spreadsheet is refused and changes nothing", async ({ peers }) => {
    const [a] = await peers(1);
    await edit(a, (m) => m.setUserInput(0, 1, 1, "still here"));
    const seen = dialogs(a.page, "accept");
    const sentBefore = a.sent.length;

    await stageImportFile(a.page, "/index.html", "not-really.xlsx");
    await a.page.getByRole("button", IMPORT).click();
    await expect.poll(() => seen.map((d) => d.type)).toEqual(["confirm", "alert"]);
    expect(seen[1].message).toContain("Could not read this file");
    expect(await value(a, 1, 1)).toBe("still here");
    expect(a.sent.length).toBe(sentBefore);
  });

  test("cancelling the file picker leaves the button usable", async ({ peers }) => {
    const [a] = await peers(1);
    // Nothing staged: the picker is cancelled, and never settles.
    await a.page.getByRole("button", IMPORT).click();
    await expect(a.page.getByRole("button", IMPORT)).toBeEnabled();

    await importExample(a);
    await expect.poll(() => sheetCount(a)).toBe(10);
  });
});
