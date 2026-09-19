import { describe, expect, it } from "vitest";
import { compareSemver, latestSemverTag, parseSemver } from "./release-version.mjs";

describe("release version checks", () => {
  it("accepts semantic versions and rejects malformed versions", () => {
    expect(parseSemver("1.0.0")).not.toBeNull();
    expect(parseSemver("2.1.0-rc.1+build.7")).not.toBeNull();
    expect(parseSemver("1.0")).toBeNull();
    expect(parseSemver("01.0.0")).toBeNull();
  });

  it("requires a version greater than the latest stable release", () => {
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemver("0.9.9", "1.0.0")).toBeLessThan(0);
    expect(compareSemver("1.0.1", "1.0.0")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
  });

  it("finds the greatest semantic release tag", () => {
    expect(latestSemverTag(["not-a-release", "v1.0.0", "v1.2.0", "v1.1.9"])).toBe("v1.2.0");
    expect(latestSemverTag([])).toBeNull();
  });
});
