import { type Page } from "@playwright/test";

// Mirrors the payload in App.tsx: a diff, unless `kind` says it is a snapshot.
export type Payload = {
  data: string;
  sender: string;
  kind?: "snapshot";
  epoch?: number;
  createdAt?: number;
  session?: number;
  imported?: boolean;
};

// A file handed to the host by `sendToChat`, with the blob read back as
// base64 so it survives the trip out of the page.
export type SentFile = { name: string; base64: string };

declare global {
  interface Window {
    // The file the stubbed file picker returns on the next importFiles call.
    __nextImportFile?: { name: string; base64: string };
  }
}

/**
 * Stages the file the next `importFiles` call returns. The file is fetched
 * from the dev server inside the page.
 */
export async function stageImportFile(page: Page, url: string, name: string) {
  await page.evaluate(
    async ({ url, name }) => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Could not fetch ${url}: ${response.status}`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = "";
      for (const byte of bytes) {
        binary += String.fromCharCode(byte);
      }
      window.__nextImportFile = { name, base64: btoa(binary) };
    },
    { url, name },
  );
}

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
// real host does. `replay` is what the host replays on registration, if that
// is not simply `history`: a device joining a chat sees the others' updates,
// but records only its own.
export async function installHost(
  page: Page,
  history: Payload[],
  {
    echo = true,
    replay = history,
    sentFiles,
  }: { echo?: boolean; replay?: Payload[]; sentFiles?: SentFile[] } = {},
) {
  await page.exposeFunction("recordUpdate", (payload: Payload) => {
    history.push(payload);
  });
  await page.exposeFunction("recordSentFile", (file: SentFile) => {
    sentFiles?.push(file);
  });
  await page.route("**/webxdc.js", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `
      const history = ${JSON.stringify(replay)};
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
        // The real host shows a file picker. Tests stage the file the picker
        // is to return in window.__nextImportFile; an empty slot stands for
        // the user cancelling out of the picker, which never settles - as in
        // Delta Chat, which only listens for the input's \`change\` event.
        async importFiles() {
          const staged = window.__nextImportFile;
          if (!staged) {
            return new Promise(() => {});
          }
          window.__nextImportFile = undefined;
          const bin = atob(staged.base64);
          const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
          return [new File([bytes], staged.name)];
        },
        // The real host shows a chat picker. Reading the blob here also
        // asserts that what the app passed is still readable, rather than a
        // view on freed WASM memory.
        async sendToChat({ file }) {
          if (file) {
            const buffer = await file.blob.arrayBuffer();
            let binary = '';
            for (const byte of new Uint8Array(buffer)) {
              binary += String.fromCharCode(byte);
            }
            await window.recordSentFile({ name: file.name, base64: btoa(binary) });
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
