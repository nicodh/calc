import { test, expect, type Browser, type Page } from "@playwright/test";
import {
  cell,
  deliver,
  installHost,
  waitUntilEstablished,
  type Payload,
} from "./host";
import { B2_DIFF, SENDER, SNAPSHOT } from "./fixtures";

// How a device comes to share one workbook with the chat. See
// src/components/bootstrap.ts.

function set(page: Page, row: number, column: number, value: string) {
  return page.evaluate(
    ([row, column, value]) =>
      window.__model!.setUserInput(0, row as number, column as number, value as string),
    [row, column, value],
  );
}

function base(page: Page) {
  return page.evaluate(() => localStorage.getItem("bootstrap_base"));
}

// A device on its own in a chat: opens, settles as the creator, and types.
async function creator(page: Page, history: Payload[]) {
  await installHost(page, history);
  await page.goto("/");
  await waitUntilEstablished(page);
  expect(history[0].kind).toBe("snapshot");
}

async function newDevice(browser: Browser, baseURL: string, history: Payload[]) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await installHost(page, history);
  await page.goto(baseURL);
  return { context, page };
}

test("a device alone in the chat publishes its workbook, a later one joins from it", async ({
  page,
  browser,
  baseURL,
}) => {
  const history: Payload[] = [];
  await installHost(page, history);
  await page.goto("/");
  await page.waitForFunction(() => !!window.__model);

  // Nothing goes out while the workbook is provisional.
  await page.waitForTimeout(500);
  expect(history).toHaveLength(0);

  // The log stays quiet, so this device publishes its workbook.
  await waitUntilEstablished(page);
  await expect.poll(() => history.length).toBe(1);
  expect(history[0]).toMatchObject({ kind: "snapshot" });
  expect(typeof history[0].createdAt).toBe("number");
  expect(typeof history[0].session).toBe("number");

  // From then on it sends ordinary diffs.
  await set(page, 2, 2, "42");
  await expect.poll(() => history.length).toBe(2);
  expect(history[1].kind).toBeUndefined();

  // A second device joins to a log holding the snapshot and the edit.
  const joiner = await newDevice(browser, baseURL!, history);
  try {
    await waitUntilEstablished(joiner.page);
    await expect.poll(() => cell(joiner.page, 2, 2)).toBe("42");

    // It adopted rather than published: still one snapshot in the log.
    await joiner.page.waitForTimeout(2000);
    expect(history.filter((u) => u.kind === "snapshot")).toHaveLength(1);

    // And it is a full peer: its own edit reaches the first device.
    const before = history.length;
    await set(joiner.page, 3, 3, "7");
    await expect.poll(() => history.length).toBe(before + 1);
    await deliver(page, history.slice(before));
    await expect.poll(() => cell(page, 3, 3)).toBe("7");
  } finally {
    await joiner.context.close();
  }
});

test("two devices that both started alone end up on one workbook", async ({
  page,
  browser,
  baseURL,
}) => {
  const historyA: Payload[] = [];
  await creator(page, historyA);
  await set(page, 1, 1, "from A");
  await expect.poll(() => historyA.length).toBe(2);

  // B opens while A is out of reach, and publishes a workbook of its own.
  const historyB: Payload[] = [];
  const b = await newDevice(browser, baseURL!, historyB);
  try {
    await waitUntilEstablished(b.page);
    expect(historyB[0].kind).toBe("snapshot");
    await set(b.page, 2, 2, "from B");
    await expect.poll(() => historyB.length).toBe(2);

    // They meet. A's workbook is the earlier one, so B moves onto it,
    // replaying its own edit; A keeps its workbook and takes B's edit.
    await deliver(page, historyB.slice());
    await deliver(b.page, historyA.slice());
    await expect.poll(() => cell(b.page, 1, 1)).toBe("from A");
    expect(await cell(b.page, 2, 2)).toBe("from B");
    await expect.poll(() => cell(page, 2, 2)).toBe("from B");
    expect(await cell(page, 1, 1)).toBe("from A");
    expect(await base(b.page)).toBe(await base(page));

    // From here on diffs cross in both directions.
    const seenA = historyA.length;
    const seenB = historyB.length;
    await set(page, 3, 3, "A again");
    await set(b.page, 4, 4, "B again");
    await expect.poll(() => historyA.length).toBe(seenA + 1);
    await expect.poll(() => historyB.length).toBe(seenB + 1);
    await deliver(b.page, historyA.slice(seenA));
    await deliver(page, historyB.slice(seenB));
    await expect.poll(() => cell(b.page, 3, 3)).toBe("A again");
    await expect.poll(() => cell(page, 4, 4)).toBe("B again");
  } finally {
    await b.context.close();
  }
});

test("a device that joined the later workbook moves to the earlier one when it shows up", async ({
  page,
  browser,
  baseURL,
}) => {
  const historyA: Payload[] = [];
  await creator(page, historyA);
  await set(page, 1, 1, "from A");
  await expect.poll(() => historyA.length).toBe(2);

  const historyB: Payload[] = [];
  const b = await newDevice(browser, baseURL!, historyB);
  try {
    await waitUntilEstablished(b.page);
    await set(b.page, 2, 2, "from B");
    await expect.poll(() => historyB.length).toBe(2);

    // C has only heard of B's workbook so far, and joins it.
    const historyC: Payload[] = historyB.slice();
    const c = await newDevice(browser, baseURL!, historyC);
    try {
      await waitUntilEstablished(c.page);
      await expect.poll(() => cell(c.page, 2, 2)).toBe("from B");

      // A's workbook reaches C late. C moves onto it and keeps B's edit.
      await deliver(c.page, historyA.slice());
      await expect.poll(() => cell(c.page, 1, 1)).toBe("from A");
      expect(await cell(c.page, 2, 2)).toBe("from B");
      expect(await base(c.page)).toBe(await base(page));

      // The chat delivers everything to everyone: A takes B's edit (and
      // ignores B's later snapshot). Until a replica has every update, a row
      // nobody inserted explicitly can show at a different position - its key
      // is only known once some update materialized it.
      await deliver(page, historyB.slice());
      await expect.poll(() => cell(page, 2, 2)).toBe("from B");

      // C's own edits reach A as well.
      const seenC = historyC.length;
      await set(c.page, 5, 5, "from C");
      await expect.poll(() => historyC.length).toBe(seenC + 1);
      await deliver(page, historyC.slice(seenC));
      await expect.poll(() => cell(page, 5, 5)).toBe("from C");
    } finally {
      await c.context.close();
    }
  } finally {
    await b.context.close();
  }
});

test("reopening keeps the workbook and does not publish it again", async ({ page }) => {
  const history: Payload[] = [];
  await creator(page, history);
  await set(page, 2, 2, "kept");
  await expect.poll(() => history.length).toBe(2);

  await page.reload();
  await waitUntilEstablished(page);
  expect(await cell(page, 2, 2)).toBe("kept");
  await page.waitForTimeout(2000);
  expect(history.filter((u) => u.kind === "snapshot")).toHaveLength(1);
});

test("a device that lost its storage recovers its workbook from the chat", async ({
  page,
}) => {
  // This device once sent both of these, then lost its storage: its uuid and
  // a stale cursor are all that would be left behind.
  await installHost(page, [SNAPSHOT, B2_DIFF]);
  await page.addInitScript((sender) => {
    if (!sessionStorage.getItem("seeded")) {
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem("last_serial", "99");
      localStorage.setItem("uuid", sender);
    }
  }, SENDER);
  await page.goto("/");
  await waitUntilEstablished(page);
  await expect.poll(() => cell(page, 2, 2)).toBe("42");
});
