import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Recommendation } from "../src/lib/recommend";
import {
  initialRecommendState,
  recommendationIdentity,
  recommendReducer,
  type RecommendAction,
  type RecommendState,
} from "../src/app/(app)/recommend/recommend-state";

function rec(overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    title: "The Thing",
    year: 1982,
    mediaType: "movie",
    reason: "Because you rated bleak, practical-effects horror highly.",
    confidence: "high",
    ...overrides,
  };
}

const run = (...actions: RecommendAction[]) =>
  actions.reduce(recommendReducer, initialRecommendState);

const finish: RecommendAction = { type: "finish", language: undefined, era: "" };
const titles = (state: RecommendState) => state.recs.map((r) => r.title);

const alien = rec({ title: "Alien", year: 1979, tmdbId: 348 });
const heat = rec({ title: "Heat", year: 1995, tmdbId: 949, confidence: "medium" });
const brazil = rec({ title: "Brazil", year: 1985, confidence: "low" });

describe("recommend request lifecycle (VE-08)", () => {
  it("starts idle with nothing on screen", () => {
    assert.equal(initialRecommendState.status, "idle");
    assert.equal(initialRecommendState.error, null);
    assert.deepEqual(initialRecommendState.recs, []);
    assert.deepEqual(initialRecommendState.received, []);
    assert.deepEqual(initialRecommendState.warnings, []);
  });

  it("starts a run from scratch, whatever the last one left behind", () => {
    const previous = run(
      { type: "start" },
      { type: "rec", rec: alien },
      { type: "dismiss", identity: recommendationIdentity(alien) },
      { type: "warning", message: "Using the shared key." },
      { type: "fail", error: "Rate limited." },
      finish,
    );
    assert.equal(previous.status, "error");
    const next = recommendReducer(previous, { type: "start" });
    assert.equal(next.status, "streaming");
    assert.equal(next.status === "streaming" && next.phase, "starting");
    assert.equal(next.error, null);
    assert.deepEqual(next.recs, []);
    assert.deepEqual(next.received, []);
    assert.deepEqual(next.warnings, []);
    assert.equal(next.dismissed.size, 0);
  });

  it("follows status events, and keeps the state when the phase repeats", () => {
    const thinking = run({ type: "start" }, { type: "phase", phase: "thinking" });
    assert.equal(thinking.status === "streaming" && thinking.phase, "thinking");
    assert.equal(recommendReducer(thinking, { type: "phase", phase: "thinking" }), thinking);
    const generating = recommendReducer(thinking, { type: "phase", phase: "generating" });
    assert.equal(generating.status === "streaming" && generating.phase, "generating");
  });

  it("shows each pick the moment it streams in, in arrival order", () => {
    const state = run({ type: "start" }, { type: "rec", rec: brazil }, { type: "rec", rec: alien });
    assert.equal(state.status, "streaming");
    assert.deepEqual(titles(state), ["Brazil", "Alien"]);
    assert.deepEqual(state.received, [brazil, alien]);
  });

  it("keeps each distinct warning once, in arrival order", () => {
    const one = run({ type: "start" }, { type: "warning", message: "A" });
    assert.equal(recommendReducer(one, { type: "warning", message: "A" }), one);
    const two = recommendReducer(one, { type: "warning", message: "B" });
    assert.deepEqual(two.warnings, ["A", "B"]);
    assert.deepEqual(recommendReducer(two, { type: "dismissWarning", warning: "A" }).warnings, ["B"]);
  });

  it("ends done and ranks preference-confirmed picks, then confidence, then arrival", () => {
    const french = rec({ title: "Amélie", year: 2001, language: "fr", confidence: "low" });
    const fargo = rec({ title: "Fargo", year: 1996, confidence: "low" });
    const zodiac = rec({ title: "Zodiac", year: 2007, confidence: "low" });
    const state = run(
      { type: "start" },
      { type: "rec", rec: brazil },
      { type: "rec", rec: fargo },
      { type: "rec", rec: alien },
      { type: "rec", rec: french },
      { type: "rec", rec: heat },
      { type: "rec", rec: zodiac },
      { type: "finish", language: "fr", era: "1990s" },
    );
    assert.equal(state.status, "done");
    assert.equal(state.error, null);
    assert.deepEqual(titles(state), ["Amélie", "Heat", "Fargo", "Alien", "Brazil", "Zodiac"]);
  });

  it("holds a mid-stream error while the run winds down, then ends in error with partial picks", () => {
    const streaming = run(
      { type: "start" },
      { type: "rec", rec: heat },
      { type: "rec", rec: alien },
      { type: "fail", error: "Claude stopped early." },
    );
    assert.equal(streaming.status, "streaming");
    assert.equal(streaming.error, "Claude stopped early.");
    const later = recommendReducer(streaming, { type: "fail", error: "The connection stalled." });
    const ended = recommendReducer(later, finish);
    assert.equal(ended.status, "error");
    assert.equal(ended.error, "The connection stalled.");
    assert.deepEqual(titles(ended), ["Alien", "Heat"]);
  });

  it("ends a pre-stream failure in error with no picks", () => {
    const state = run({ type: "start" }, { type: "fail", error: "You're going a bit fast." }, finish);
    assert.equal(state.status, "error");
    assert.deepEqual(state.recs, []);
    assert.deepEqual(state.received, []);
  });

  it("ends a run stopped before any pick done and empty", () => {
    const state = run({ type: "start" }, { type: "phase", phase: "thinking" }, finish);
    assert.equal(state.status, "done");
    assert.deepEqual(state.recs, []);
    assert.deepEqual(state.received, []);
  });

  it("leaves the cards alone when nothing streamed in", () => {
    // An Undo from an earlier run can land a card mid-run; with nothing
    // received there is nothing to rank, so the list is kept as it is.
    const withCard = run({ type: "start" }, { type: "restore", rec: alien, index: 0 });
    const ended = recommendReducer(withCard, finish);
    assert.equal(ended.status, "done");
    assert.equal(ended.recs, withCard.recs);
  });

  it("turns a late error into the error state", () => {
    const done = run({ type: "start" }, { type: "rec", rec: alien }, finish);
    const failed = recommendReducer(done, { type: "fail", error: "Late." });
    assert.equal(failed.status, "error");
    assert.equal(failed.error, "Late.");
    assert.equal(failed.recs, done.recs);
    assert.equal(recommendReducer(initialRecommendState, { type: "fail", error: "Late." }).status, "error");
  });

  it("ignores stream events outside a run", () => {
    const done = run({ type: "start" }, { type: "rec", rec: alien }, finish);
    for (const action of [
      { type: "phase", phase: "thinking" },
      { type: "rec", rec: heat },
      { type: "warning", message: "Late warning." },
      finish,
    ] satisfies RecommendAction[]) {
      assert.equal(recommendReducer(done, action), done);
      assert.equal(recommendReducer(initialRecommendState, action), initialRecommendState);
    }
  });
});

describe("recommend dismiss and undo (VE-08)", () => {
  it("hides a dismissed pick and keeps it hidden if the stream sends it again", () => {
    const state = run(
      { type: "start" },
      { type: "rec", rec: alien },
      { type: "rec", rec: heat },
      { type: "dismiss", identity: recommendationIdentity(alien) },
      { type: "rec", rec: brazil },
      { type: "rec", rec: { ...alien } },
    );
    assert.deepEqual(titles(state), ["Heat", "Brazil"]);
    assert.equal(state.received.length, 4);
    assert.deepEqual(titles(recommendReducer(state, finish)), ["Heat", "Brazil"]);
  });

  it("ends done with no cards but picks received when every pick was dismissed", () => {
    const state = run(
      { type: "start" },
      { type: "rec", rec: alien },
      { type: "dismiss", identity: recommendationIdentity(alien) },
      finish,
    );
    assert.equal(state.status, "done");
    assert.deepEqual(state.recs, []);
    assert.equal(state.received.length, 1);
  });

  it("restores a card where it was, once, and lets the stream show it again", () => {
    const streaming = run(
      { type: "start" },
      { type: "rec", rec: alien },
      { type: "rec", rec: heat },
      { type: "rec", rec: brazil },
      { type: "dismiss", identity: recommendationIdentity(heat) },
    );
    const restored = recommendReducer(streaming, { type: "restore", rec: heat, index: 1 });
    assert.deepEqual(titles(restored), ["Alien", "Heat", "Brazil"]);
    assert.equal(restored.dismissed.has(recommendationIdentity(heat)), false);
    const again = recommendReducer(restored, { type: "restore", rec: heat, index: 0 });
    assert.deepEqual(titles(again), ["Alien", "Heat", "Brazil"]);
    assert.deepEqual(titles(recommendReducer(restored, finish)), ["Alien", "Heat", "Brazil"]);
  });

  it("clamps a restore past the end of a shorter list", () => {
    const state = run(
      { type: "start" },
      { type: "rec", rec: alien },
      { type: "rec", rec: heat },
      finish,
      { type: "dismiss", identity: recommendationIdentity(heat) },
      { type: "dismiss", identity: recommendationIdentity(alien) },
      { type: "restore", rec: heat, index: 1 },
    );
    assert.equal(state.status, "done");
    assert.deepEqual(titles(state), ["Heat"]);
  });

  it("never mutates the previous state", () => {
    const before = run({ type: "start" }, { type: "rec", rec: alien }, { type: "rec", rec: heat });
    const recs = before.recs;
    const dismissed = before.dismissed;
    const after = recommendReducer(before, { type: "dismiss", identity: recommendationIdentity(alien) });
    assert.deepEqual(titles(before), ["Alien", "Heat"]);
    assert.equal(before.recs, recs);
    assert.equal(dismissed.size, 0);
    assert.equal(after.dismissed.size, 1);
    recommendReducer(after, { type: "restore", rec: alien, index: 0 });
    assert.equal(after.dismissed.size, 1);
  });

  it("identifies a pick by TMDB id, or by normalized name and year", () => {
    assert.equal(recommendationIdentity(alien), "movie:tmdb:348");
    assert.equal(recommendationIdentity(rec({ title: "  Brazil ", year: 1985 })), "movie:name:brazil:1985");
    assert.equal(
      recommendationIdentity(rec({ title: "Twin Peaks", year: null, mediaType: "tv" })),
      "tv:name:twin peaks:?",
    );
  });
});
