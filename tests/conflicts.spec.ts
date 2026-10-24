import { expect } from "@playwright/test";
import {
  edit,
  exchange,
  expectConverged,
  sheetNames,
  test,
  value,
} from "./peers";

// Devices editing the same workbook at the same time, then meeting. Every
// scenario checks first that all devices end up with the same workbook, and
// then what that workbook is. See docs/collab-conflict-resolution.md for the
// rules these exercise.

test("the same cell typed on two devices ends up with the later value everywhere", async ({
  peers,
}) => {
  const [a, b] = await peers(2);
  await edit(a, (m) => m.setUserInput(0, 1, 1, "from A"));
  // `edit` waits for A's diff to go out, so B types later.
  await edit(b, (m) => m.setUserInput(0, 1, 1, "from B"));

  await exchange([a, b]);
  await expectConverged([a, b]);
  expect(await value(a, 1, 1)).toBe("from B");
});

test("a value and a format written to one cell from two devices are both kept", async ({
  peers,
}) => {
  const [a, b] = await peers(2);
  await edit(a, (m) => m.setUserInput(0, 1, 1, "x"));
  await edit(b, (m) =>
    m.updateRangeStyle({ sheet: 0, row: 1, column: 1, width: 1, height: 1 }, "font.b", "true"),
  );

  await exchange([a, b]);
  const workbook = await expectConverged([a, b]);
  expect(workbook).toContain('1,1 "x" = "x" bold');
});

test("a row inserted on one device moves the other's concurrent edit, and formulas follow", async ({
  peers,
}) => {
  const [a, b] = await peers(2);
  await edit(a, (m) => {
    m.setUserInput(0, 1, 1, "1");
    m.setUserInput(0, 2, 1, "2");
    m.setUserInput(0, 3, 1, "=SUM(A1:A2)");
  });
  await exchange([a, b]);

  // A inserts a row above A2 while B overwrites A2.
  await edit(a, (m) => m.insertRows(0, 2, 1));
  await edit(b, (m) => m.setUserInput(0, 2, 1, "5"));

  await exchange([a, b]);
  const workbook = await expectConverged([a, b]);
  // B's 5 went to the row it was typed into, now row 3; the formula moved to
  // row 4 and its range grew over the inserted row.
  expect(await value(a, 2, 1)).toBe("");
  expect(await value(a, 3, 1)).toBe("5");
  expect(workbook).toContain('4,1 "=SUM(A1:A3)" = "6"');
});

test("a row deleted on one device takes the other's concurrent edit in it along", async ({
  peers,
}) => {
  const [a, b] = await peers(2);
  await edit(a, (m) => {
    m.setUserInput(0, 1, 1, "row 1");
    m.setUserInput(0, 2, 1, "row 2");
    m.setUserInput(0, 3, 1, "row 3");
  });
  await exchange([a, b]);

  await edit(a, (m) => m.deleteRows(0, 2, 1));
  // B types into row 2 after the delete, without having received it.
  await edit(b, (m) => m.setUserInput(0, 2, 2, "typed into row 2"));

  await exchange([a, b]);
  const workbook = await expectConverged([a, b]);
  // The delete removes the row, and the edit goes with it on both devices,
  // even though it was made later: a write into a row that no longer exists
  // is kept in storage but has nowhere to show. Nothing brings the row back.
  expect(workbook).not.toContain("typed into row 2");
  expect(await value(a, 2, 1)).toBe("row 3");
});

test("rows inserted at the same place on two devices are both kept, in the same order", async ({
  peers,
}) => {
  const [a, b] = await peers(2);
  await edit(a, (m) => {
    m.setUserInput(0, 1, 1, "top");
    m.setUserInput(0, 2, 1, "bottom");
  });
  await exchange([a, b]);

  await edit(a, (m) => {
    m.insertRows(0, 2, 1);
    m.setUserInput(0, 2, 1, "inserted by A");
  });
  await edit(b, (m) => {
    m.insertRows(0, 2, 1);
    m.setUserInput(0, 2, 1, "inserted by B");
  });

  await exchange([a, b]);
  await expectConverged([a, b]);
  expect(await value(a, 1, 1)).toBe("top");
  expect([await value(a, 2, 1), await value(a, 3, 1)].sort()).toEqual([
    "inserted by A",
    "inserted by B",
  ]);
  expect(await value(a, 4, 1)).toBe("bottom");
});

test("the same sheet renamed on two devices takes the later name everywhere", async ({
  peers,
}) => {
  const [a, b] = await peers(2);
  await edit(a, (m) => m.renameSheet(0, "Alpha"));
  await edit(b, (m) => m.renameSheet(0, "Beta"));

  await exchange([a, b]);
  await expectConverged([a, b]);
  expect(await sheetNames(a)).toEqual(["Beta"]);
});

test("sheets added under the same name on two devices get unique names, the same everywhere", async ({
  peers,
}) => {
  const [a, b] = await peers(2);
  await edit(a, (m) => {
    m.newSheet();
    m.renameSheet(1, "Data");
    m.setUserInput(1, 1, 1, "A's data");
  });
  await edit(b, (m) => {
    m.newSheet();
    m.renameSheet(1, "Data");
    m.setUserInput(1, 1, 1, "B's data");
  });

  await exchange([a, b]);
  await expectConverged([a, b]);
  const names = await sheetNames(a);
  expect(names).toHaveLength(3);
  expect(new Set(names.map((name) => name.toUpperCase())).size).toBe(3);
  expect(names).toContain("Data");
});

test("an undo is a new edit: it wins over another device's earlier-received change", async ({
  peers,
}) => {
  const [a, b] = await peers(2);
  await edit(a, (m) => m.setUserInput(0, 1, 1, "mine"));
  await exchange([a, b]);
  await edit(b, (m) => m.setUserInput(0, 1, 1, "theirs"));
  await exchange([a, b]);
  expect(await value(a, 1, 1)).toBe("theirs");

  // A takes back its own edit. The undo writes the value A1 held before A's
  // edit, with a fresh stamp, so it also replaces B's later change.
  await edit(a, (m) => m.undo());
  await exchange([a, b]);
  await expectConverged([a, b]);
  expect(await value(a, 1, 1)).toBe("");
});

test("updates that arrive late, in another sender order, and twice still converge", async ({
  peers,
}) => {
  test.setTimeout(90_000);
  const [a, b, c, observer] = await peers(4);

  // Three devices work on overlapping cells and on structure, none of them
  // hearing from the others.
  await edit(a, (m) => {
    m.setUserInput(0, 1, 1, "a");
    m.setUserInput(0, 2, 2, '=A1&"!"');
  });
  await edit(b, (m) => {
    m.setUserInput(0, 1, 1, "b");
    m.updateRangeStyle({ sheet: 0, row: 2, column: 2, width: 1, height: 1 }, "font.b", "true");
  });
  await edit(c, (m) => {
    m.renameSheet(0, "Shared");
    m.setUserInput(0, 3, 3, "c");
  });
  await edit(a, (m) => m.insertRows(0, 1, 1));
  await edit(b, (m) => m.insertColumns(0, 1, 1));
  // Row 2 exists on C: its edit in C3 created rows 1 to 3. Deleting a row no
  // update ever created sends nothing.
  await edit(c, (m) => m.deleteRows(0, 2, 1));

  // A, B and C exchange in the usual order.
  await exchange([a, b, c]);

  // The observer heard nothing so far. It gets the senders in reverse order,
  // then everything a second time.
  await exchange([observer, a, b, c], [c, b, a]);
  for (const sender of [a, b, c]) {
    observer.received.set(sender, 0);
  }
  await exchange([observer, a, b, c], [b, c, a]);

  const workbook = await expectConverged([a, b, c, observer]);
  expect(workbook).toContain('sheet 0 "Shared"');
});
