import { describe, expect, it } from "vitest";
import {
  listExperimentalFlagDescriptors,
  readBoolAtPath,
  setBoolAtPath,
} from "./experimental-flags.js";

describe("listExperimentalFlagDescriptors", () => {
  it("derives experimental flags from the config schema (no hardcoding)", () => {
    const descriptors = listExperimentalFlagDescriptors();
    const paths = descriptors.map((descriptor) => descriptor.path);

    // Every path must contain an `experimental` segment — we never surface a
    // path that doesn't carry the experimental convention.
    for (const path of paths) {
      expect(path.split(".")).toContain("experimental");
    }

    // Sanity-check that the documented experimental boolean leaves are
    // discovered. If you add a new experimental flag to the schema, it will
    // appear here automatically — that is the point of this test.
    expect(paths).toContain("tools.experimental.planTool");
    expect(paths).toContain("agents.defaults.experimental.localModelLean");
    expect(paths).toContain("agents.defaults.memorySearch.experimental.sessionMemory");
  });

  it("attaches a human label to each descriptor", () => {
    const descriptors = listExperimentalFlagDescriptors();
    for (const descriptor of descriptors) {
      expect(descriptor.label.length).toBeGreaterThan(0);
    }
  });

  it("returns segments aligned with the dotted path", () => {
    const descriptors = listExperimentalFlagDescriptors();
    for (const descriptor of descriptors) {
      expect(descriptor.segments.join(".")).toBe(descriptor.path);
    }
  });

  it("output is stable (sorted by path)", () => {
    const first = listExperimentalFlagDescriptors().map((descriptor) => descriptor.path);
    const second = listExperimentalFlagDescriptors().map((descriptor) => descriptor.path);
    expect(first).toEqual(second);
    const sorted = first.toSorted((a, b) => a.localeCompare(b));
    expect(first).toEqual(sorted);
  });

  it("does not surface paths blocked by the policy seam", () => {
    // None of the experimental flags should fall under managed prefixes.
    // (`plugins.installs.*` is the only managed prefix today.)
    const descriptors = listExperimentalFlagDescriptors();
    for (const descriptor of descriptors) {
      expect(descriptor.segments[0]).not.toBe("plugins");
    }
  });
});

describe("readBoolAtPath / setBoolAtPath", () => {
  it("readBoolAtPath returns false for missing paths", () => {
    expect(readBoolAtPath({}, ["a", "b"])).toBe(false);
    expect(readBoolAtPath({ a: { b: true } }, ["a", "c"])).toBe(false);
    expect(readBoolAtPath({ a: 5 }, ["a", "b"])).toBe(false);
  });

  it("readBoolAtPath returns true only for boolean true", () => {
    expect(readBoolAtPath({ a: { b: true } }, ["a", "b"])).toBe(true);
    expect(readBoolAtPath({ a: { b: false } }, ["a", "b"])).toBe(false);
    expect(readBoolAtPath({ a: { b: 1 } }, ["a", "b"])).toBe(false);
    expect(readBoolAtPath({ a: { b: "true" } }, ["a", "b"])).toBe(false);
  });

  it("setBoolAtPath creates nested objects as needed", () => {
    const root: Record<string, unknown> = {};
    setBoolAtPath(root, ["a", "b", "c"], true);
    expect(root).toEqual({ a: { b: { c: true } } });
  });

  it("setBoolAtPath replaces non-object intermediates", () => {
    const root: Record<string, unknown> = { a: 5 };
    setBoolAtPath(root, ["a", "b"], false);
    expect(root).toEqual({ a: { b: false } });
  });

  it("setBoolAtPath updates existing values without wiping siblings", () => {
    const root: Record<string, unknown> = { a: { b: false, sibling: 1 } };
    setBoolAtPath(root, ["a", "b"], true);
    expect(root).toEqual({ a: { b: true, sibling: 1 } });
  });
});
