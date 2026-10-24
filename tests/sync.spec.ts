import { test, expect } from '@playwright/test';
import { cell, deliver, installHost, waitUntilEstablished } from './host';
import { B2_DIFF, SNAPSHOT } from './fixtures';

// The chat already holds a peer's workbook: the device joins from its
// snapshot, and then receives the peer's edit, setting B2 to 42.

test('incoming diff updates the model', async ({ page }) => {
  await installHost(page, [SNAPSHOT]);
  await page.goto('/');
  await waitUntilEstablished(page);

  // the diff arrives
  await deliver(page, [B2_DIFF]);

  // The diff should land in the model: B2 (sheet 0, row 2, col 2) becomes "42".
  await expect.poll(() => cell(page, 2, 2)).toBe('42');
});

// We read the value of the in-cell editor; the uncommitted text.
function activeEditor(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const ae = document.activeElement as HTMLTextAreaElement | null;
    return { tag: ae?.tagName ?? null, value: ae?.value ?? null };
  });
}

test('an incoming diff does not disrupt an in-progress edit', async ({ page }) => {
  await installHost(page, [SNAPSHOT]);
  await page.goto('/');
  await waitUntilEstablished(page);

  // we are editing A1 but do not commit
  await page.mouse.click(70, 110);
  await page.keyboard.type('hello');

  // we verify that we can see the value in the in-cell editor
  expect(await activeEditor(page)).toEqual({ tag: 'TEXTAREA', value: 'hello' });

  // now we get an update (of B2, not even what we're editing)
  await deliver(page, [B2_DIFF]);

  // it appears in the model
  await expect.poll(() => cell(page, 2, 2)).toBe('42');

  // but it shouldn't disrupt our edit: the editor still holds "hello" and is focused.
  expect(await activeEditor(page)).toEqual({ tag: 'TEXTAREA', value: 'hello' });

  // and if we commit that value it should show up in the model
  await page.keyboard.press('Enter');
  await expect.poll(() => cell(page, 1, 1)).toBe('hello');
});
