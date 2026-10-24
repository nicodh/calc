import { type Page } from "@playwright/test";

// Mirrors the payload in App.tsx: a diff, unless `kind` says it is a snapshot.
export type Payload = {
  data: string;
  sender: string;
  kind?: "snapshot";
  createdAt?: number;
  session?: number;
};

// A stand-in for the webxdc host, installed before the app loads.
//
// The host owns this log independently of the app's localStorage and
// lifetime, the way Delta Chat does: it replays the history on registration,
// and records every update the page sends into `history`. The log is copied
// into the page when it loads, so a page sees what was in `history` then;
// there is no transport between pages. Tests hand one device's updates to
// another explicitly, with `deliver`.
//
// `echo` mirrors outgoing updates straight back to the listener, the way the
// real host does.
export async function installHost(
  page: Page,
  history: Payload[],
  { echo = true }: { echo?: boolean } = {},
) {
  await page.exposeFunction("recordUpdate", (payload: Payload) => {
    history.push(payload);
  });
  await page.route("**/webxdc.js", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `
      const history = ${JSON.stringify(history)};
      const echo = ${echo};
      let listener;
      let serial = history.length;
      window.webxdc = {
        selfAddr: 'same-account@example.org',
        selfName: 'Same account',
        // 0 stands for the app's "host reports nothing" case.
        sendUpdateMaxSize: 0,
        sendUpdateInterval: 0,
        setUpdateListener(cb, start = 0) {
          if (listener) throw new Error('Listener registered twice');
          listener = cb;
          history.forEach((payload, index) => {
            if (index + 1 > start) cb({ payload, serial: index + 1, max_serial: serial });
          });
          return Promise.resolve();
        },
        sendUpdate({ payload }) {
          window.recordUpdate(payload);
          serial += 1;
          if (echo) {
            listener({ payload, serial, max_serial: serial });
          }
        },
        // A received update is delivered like one the host stored for us.
        __receive(payload) {
          serial += 1;
          listener({ payload, serial, max_serial: serial });
        },
      };
    `,
    }),
  );
}

// Hands `updates` to the page as if the chat had delivered them.
export async function deliver(page: Page, updates: Payload[]) {
  for (const payload of updates) {
    await page.evaluate((payload) => {
      (window.webxdc as unknown as { __receive(p: unknown): void }).__receive(
        payload,
      );
    }, payload);
  }
}

// Resolves once the device has settled on a workbook: adopted one, or
// published its own.
export async function waitUntilEstablished(page: Page) {
  await page.waitForFunction(
    () =>
      !!window.__model &&
      localStorage.getItem("bootstrap_phase") === "established",
    undefined,
    { timeout: 10_000 },
  );
}

export async function cell(page: Page, row: number, column: number) {
  return page.evaluate(
    ([row, column]) => window.__model?.getFormattedCellValue(0, row, column),
    [row, column],
  );
}
