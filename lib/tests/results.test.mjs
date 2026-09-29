// node --test lib/tests/
import test from "node:test";
import assert from "node:assert/strict";
import { parseMaxWinners, tallySeats } from "../results.js";

const ann = { id: "a", name: "Ann A" };
const ben = { id: "b", name: "Ben B" };
const cat = { id: "c", name: "Cat C" };
const dan = { id: "d", name: "Dan D" };
const all = [ann, ben, cat];

test("one seat keeps the original rule", () => {
  const win = tallySeats(all, { a: 3, b: 2, c: 1 }, 1);
  assert.deepEqual([win.names, win.display, win.is_tie, win.vote_count], [["Ann A"], "Ann A", false, 3]);
  const tie = tallySeats(all, { a: 2, b: 2, c: 1 }, 1);
  assert.deepEqual([tie.names, tie.display, tie.is_tie, tie.vote_count], [["Ann A", "Ben B"], "Ann A · Ben B", true, 2]);
  assert.equal(tallySeats([], {}, 1).display, "No candidates");
  assert.equal(tallySeats(all, {}, 1).display, "No votes");
});

test("two seats go to the top two", () => {
  // The route used to report only Ann here, so the second seat was lost.
  const r = tallySeats(all, { a: 3, b: 2, c: 1 }, 2);
  assert.deepEqual([r.names, r.is_tie, r.open_seats], [["Ann A", "Ben B"], false, 0]);
  assert.equal(r.display, "Ann A · Ben B");
});

test("two candidates level on the top count fill two seats without a tie", () => {
  const r = tallySeats(all, { a: 2, b: 2, c: 1 }, 2);
  assert.deepEqual([r.names, r.is_tie], [["Ann A", "Ben B"], false]);
});

test("a tie for the last seat names everyone on that count", () => {
  const r = tallySeats([ann, ben, cat, dan], { a: 4, b: 2, c: 2, d: 1 }, 2);
  assert.equal(r.is_tie, true);
  assert.deepEqual(r.winners, ["Ann A"]);
  assert.deepEqual(r.tied, ["Ben B", "Cat C"]);
  assert.deepEqual(r.names, ["Ann A", "Ben B", "Cat C"]);
  assert.equal(r.open_seats, 1);
  assert.equal(r.display, "Ann A · tied for the last seat: Ben B · Cat C");
  const three = tallySeats(all, { a: 1, b: 1, c: 1 }, 2);
  assert.equal(three.display, "Tied for 2 seats: Ann A · Ben B · Cat C");
});

test("a candidate with no votes never takes a seat", () => {
  const r = tallySeats(all, { a: 3 }, 2);
  assert.deepEqual([r.names, r.is_tie], [["Ann A"], false]);
});

test("max_winners must be a whole number from 1 to 50", () => {
  assert.deepEqual(parseMaxWinners(undefined), { value: 1 });
  assert.deepEqual(parseMaxWinners(null), { value: 1 });
  assert.deepEqual(parseMaxWinners(2), { value: 2 });
  assert.deepEqual(parseMaxWinners("3"), { value: 3 });
  for (const bad of [2.5, "2.5", 0, 51, -1, "", "two", true, NaN, [2]]) {
    assert.ok(parseMaxWinners(bad).error, String(bad));
  }
});
