import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RecommendForm, resolvePreset } from "../src/app/(app)/recommend/recommend-form";

type Props = Parameters<typeof RecommendForm>[0];
type ButtonProps = {
  "aria-label"?: string;
  "aria-pressed"?: boolean;
  onClick?: (event: unknown) => void;
  children?: ReactNode;
};

const TAGS = ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"];

/** RecommendForm uses no hooks, so calling it gives the element tree to inspect. */
function form(overrides: Partial<Props> = {}) {
  const calls = { focus: [] as string[], preset: [] as Array<string | null> };
  const props: Props = {
    loading: false,
    hasKey: true,
    pickEmpty: false,
    generate: async () => {},
    focus: "",
    setFocus: (value) => calls.focus.push(value),
    activePreset: null,
    setActivePreset: (value) => calls.preset.push(value),
    tags: TAGS,
    type: "all",
    setType: () => {},
    count: 12,
    countStr: "12",
    setCountStr: () => {},
    warnings: [],
    onDismissWarning: () => {},
    error: null,
    children: null,
    ...overrides,
  };
  return { calls, tree: RecommendForm(props) };
}

/** Every native <button> in the tree, found without rendering components. */
function buttons(node: ReactNode): Array<ReactElement<ButtonProps>> {
  const found: Array<ReactElement<ButtonProps>> = [];
  const walk = (child: ReactNode) => {
    if (Array.isArray(child)) return child.forEach(walk);
    if (!isValidElement<ButtonProps>(child)) return;
    if (child.type === "button") found.push(child);
    walk(child.props.children);
  };
  walk(node);
  return found;
}

const tagChip = (tree: ReactNode, tag: string) =>
  buttons(tree).find((button) => button.key === `tag:${tag}`);
const removeChip = (tree: ReactNode) =>
  buttons(tree).find((button) => button.props["aria-label"]?.startsWith("Remove the #"));

describe("tag quick starts", () => {
  it("restores a remembered tag with the same key and focus a click sets", () => {
    for (const tag of ["t2", "t8"]) {
      // t8 is past the offered chips, so click it through a form that shows it.
      const { calls, tree } = form({ tags: tag === "t8" ? ["t8"] : TAGS });
      tagChip(tree, tag)!.props.onClick!({});
      assert.deepEqual(resolvePreset(`tag:${tag}`, TAGS), {
        key: calls.preset.at(-1),
        focus: calls.focus.at(-1),
      });
    }
    assert.equal(resolvePreset("tag:gone", TAGS), null);
  });

  it("offers the first six tags as chips", () => {
    const { tree } = form();
    assert.deepEqual(
      TAGS.map((tag) => Boolean(tagChip(tree, tag))),
      [true, true, true, true, true, true, false, false],
    );
    assert.equal(removeChip(tree), undefined);
  });

  it("shows a remembered tag within the six as its pressed chip, with no extra chip", () => {
    const restored = resolvePreset("tag:t3", TAGS)!;
    const { tree } = form({ activePreset: restored.key, focus: restored.focus });
    assert.equal(tagChip(tree, "t3")!.props["aria-pressed"], true);
    assert.equal(removeChip(tree), undefined);
  });

  it("gives a remembered tag past the six a visible chip that removes it", () => {
    const restored = resolvePreset("tag:t8", TAGS)!;
    const { calls, tree } = form({ activePreset: restored.key, focus: restored.focus });
    const chip = removeChip(tree)!;
    assert.equal(chip.props["aria-label"], "Remove the #t8 quick start");
    assert.match(renderToStaticMarkup(tree), /#t8/);

    chip.props.onClick!({ currentTarget: { form: null } });
    assert.deepEqual(calls.preset, [null]);
    assert.deepEqual(calls.focus, [""]);
  });

  it("hands focus from the remembered-tag chip to the focus box it cleared", (t) => {
    // Node has no DOM, so stand in for HTMLElement and the chip's form.
    class FakeElement {
      focus = t.mock.fn();
    }
    const hadHTMLElement = "HTMLElement" in globalThis;
    const original = (globalThis as { HTMLElement?: unknown }).HTMLElement;
    (globalThis as { HTMLElement?: unknown }).HTMLElement = FakeElement;
    t.after(() => {
      if (hadHTMLElement) (globalThis as { HTMLElement?: unknown }).HTMLElement = original;
      else delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
    });

    const restored = resolvePreset("tag:t8", TAGS)!;
    const { calls, tree } = form({ activePreset: restored.key, focus: restored.focus });
    const box = new FakeElement();
    const namedItem = t.mock.fn((name: string) => (name === "recommendation-focus" ? box : null));
    removeChip(tree)!.props.onClick!({ currentTarget: { form: { elements: { namedItem } } } });

    assert.deepEqual(namedItem.mock.calls.map((call) => call.arguments), [["recommendation-focus"]]);
    assert.equal(box.focus.mock.callCount(), 1);
    assert.deepEqual(calls.preset, [null]);
    assert.deepEqual(calls.focus, [""]);
    // The name looked up is the focus box's own.
    assert.match(renderToStaticMarkup(tree), /<input[^>]*name="recommendation-focus"/);
  });
});

describe("recommend helper copy", () => {
  it("sets the wait expectation without naming one model", async () => {
    const { tree } = form();
    assert.match(
      renderToStaticMarkup(tree),
      /Suggestions appear as they(?:&#x27;|')re ready\. The first can take up to a minute on more capable models\./,
    );
    // Model names live in lib/models.ts, so a lineup change can't strand copy.
    const dir = new URL("../src/app/(app)/recommend/", import.meta.url);
    for (const name of (await readdir(dir)).filter((file) => file.endsWith(".tsx"))) {
      const source = await readFile(new URL(name, dir), "utf8");
      assert.doesNotMatch(source, /\b(?:Opus|Sonnet|Haiku)\b/, name);
    }
  });
});
