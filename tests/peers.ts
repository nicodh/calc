import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";
import { deliver, installHost, waitUntilEstablished, type Payload } from "./host";

// Several devices sharing one workbook, for scenarios where they edit at the
// same time.
//
// The test host has no transport between pages, so "at the same time" is
// simply "before either has received the other's updates": each device edits
// on its own, and the test decides when, and in which order, the updates
// reach the others.

export type Device = {
  name: string;
  page: Page;
  // Everything this device has sent, in order.
  sent: Payload[];
  // How many of each other device's `sent` this device has received.
  received: Map<Device, number>;
};

// The model as the page sees it. Typed loosely on purpose: the callbacks are
// serialized into the page and run against the real wasm object there.
// biome-ignore lint/suspicious/noExplicitAny: see above
type PageModel = any;

export const test = base.extend<{ peers: (count: number) => Promise<Device[]> }>({
  peers: async ({ browser, baseURL }, use) => {
    const contexts: BrowserContext[] = [];
    await use(async (count) => {
      const devices: Device[] = [];
      for (let i = 0; i < count; i += 1) {
        const context = await browser.newContext();
        contexts.push(context);
        const page = await context.newPage();
        const sent: Payload[] = [];
        // The first device opens an empty chat and publishes the workbook;
        // the others join from its snapshot, as they would in a real chat.
        const replay = i === 0 ? sent : [devices[0].sent[0]];
        await installHost(page, sent, { replay });
        await page.goto(baseURL!);
        await waitUntilEstablished(page);
        const device: Device = {
          name: String.fromCharCode(65 + i),
          page,
          sent,
          received: new Map(),
        };
        if (i > 0) {
          device.received.set(devices[0], 1);
        }
        devices.push(device);
      }
      expect(devices[0].sent[0].kind).toBe("snapshot");
      return devices;
    });
    for (const context of contexts) {
      await context.close();
    }
  },
});

// Runs `change` against the device's model and waits until the resulting
// diff has gone out. `change` is serialized into the page, so it cannot
// close over test variables: pass them as `arg`.
export async function edit<T>(
  device: Device,
  change: (model: PageModel, arg: T) => void,
  arg?: T,
) {
  const before = device.sent.length;
  await device.page.evaluate(
    ({ source, arg }) => {
      // biome-ignore lint/security/noGlobalEval: the callback comes from the test itself
      const run = (0, eval)(`(${source})`);
      run(window.__model, arg);
    },
    { source: change.toString(), arg },
  );
  await expect
    .poll(() => device.sent.length, { message: `${device.name} sends its edit` })
    .toBeGreaterThan(before);
}

// Hands every device the updates of the others it has not received yet.
// `from` fixes the order senders are delivered in; within one sender the
// order is always the order of sending, as Delta Chat keeps it.
export async function exchange(devices: Device[], from: Device[] = devices) {
  for (const receiver of devices) {
    for (const sender of from) {
      if (sender === receiver) {
        continue;
      }
      const seen = receiver.received.get(sender) ?? 0;
      await deliver(receiver.page, sender.sent.slice(seen));
      receiver.received.set(sender, sender.sent.length);
    }
  }
}

// Everything visible in the first rows and columns of every sheet: names,
// what was typed, what it shows, and boldness. Two devices holding the same
// workbook dump the same text.
export async function fingerprint(device: Device): Promise<string> {
  return device.page.evaluate(() => {
    const model = window.__model as PageModel;
    const lines: string[] = [];
    const sheets: { name: string }[] = model.getWorksheetsProperties();
    sheets.forEach((sheet, index) => {
      lines.push(`sheet ${index} ${JSON.stringify(sheet.name)}`);
      for (let row = 1; row <= 12; row += 1) {
        for (let column = 1; column <= 8; column += 1) {
          const content = model.getCellContent(index, row, column);
          const value = model.getFormattedCellValue(index, row, column);
          const bold = model.getCellStyle(index, row, column)?.style?.font?.b;
          if (content || value || bold) {
            lines.push(
              `  ${row},${column} ${JSON.stringify(content)} = ${JSON.stringify(value)}${bold ? " bold" : ""}`,
            );
          }
        }
      }
    });
    return lines.join("\n");
  });
}

// All devices show the same workbook. Returns it, for the test to check
// what that workbook is.
export async function expectConverged(devices: Device[]): Promise<string> {
  const prints = await Promise.all(devices.map(fingerprint));
  for (let i = 1; i < devices.length; i += 1) {
    expect(prints[i], `${devices[i].name} matches ${devices[0].name}`).toBe(prints[0]);
  }
  return prints[0];
}

export async function value(device: Device, row: number, column: number, sheet = 0) {
  return device.page.evaluate(
    ([sheet, row, column]) => window.__model!.getFormattedCellValue(sheet, row, column),
    [sheet, row, column],
  );
}

export async function sheetNames(device: Device): Promise<string[]> {
  return device.page.evaluate(() =>
    (window.__model as PageModel)
      .getWorksheetsProperties()
      .map((sheet: { name: string }) => sheet.name),
  );
}
