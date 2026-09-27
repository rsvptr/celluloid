import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { regionName, sortRegionsByName } from "../src/lib/tmdb-extras";
import { REGION_NAMES } from "../src/lib/region-names";
import { languageName } from "../src/lib/format";
import { LANGUAGE_NAMES } from "../src/lib/language-names";

const src = (f: string) => readFileSync(new URL(`../src/lib/${f}`, import.meta.url), "utf8");

describe("regionName uses the static table", () => {
  it("returns the table value", () => {
    assert.equal(regionName("HK"), REGION_NAMES.HK);
    assert.equal(regionName("US"), "United States");
  });
  it("returns an unknown code unchanged", () => {
    assert.equal(regionName("QQ"), "QQ");
  });
  it("sorts by the table's names", () => {
    const codes = ["US", "HK", "GB", "DE", "NL", "KR", "IN"];
    const expected = [...codes].sort((a, b) =>
      REGION_NAMES[a].localeCompare(REGION_NAMES[b], "en"),
    );
    assert.deepEqual(sortRegionsByName(codes), expected);
    assert.deepEqual(sortRegionsByName([...codes].reverse()), expected);
  });
});

describe("languageName uses the static table", () => {
  it("returns the table value", () => {
    assert.equal(languageName("zh"), LANGUAGE_NAMES.zh);
    assert.equal(languageName("en"), "English");
  });
  it("returns an unknown code unchanged", () => {
    assert.equal(languageName("xx"), "xx");
  });
});

describe("no runtime Intl.DisplayNames", () => {
  it("tmdb-extras.ts and format.ts don't call it", () => {
    assert.ok(!src("tmdb-extras.ts").includes("Intl.DisplayNames"));
    assert.ok(!src("format.ts").includes("Intl.DisplayNames"));
  });
});
