// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { blockRemoteImages, linkFragment, toggleTaskSource } from "../components/Reader";

describe("toggleTaskSource", () => {
  it("flips the marker on the line and reports the new state", () => {
    expect(toggleTaskSource("- [ ] a\n- [x] b", "\n", 0)).toEqual({ content: "- [x] a\n- [x] b", checked: true });
    expect(toggleTaskSource("- [ ] a\n- [x] b", "\n", 1)).toEqual({ content: "- [ ] a\n- [ ] b", checked: false });
  });

  it("keeps CRLF line endings and finds a marker up to two lines below a nested parent", () => {
    expect(toggleTaskSource("1. parent\r\n   - [ ] child", "\r\n", 0)).toEqual({
      content: "1. parent\r\n   - [x] child",
      checked: true,
    });
  });

  it("returns null when no marker is near the line", () => {
    expect(toggleTaskSource("plain\ntext\nmore\n- [ ] far", "\n", 0)).toBeNull();
    expect(toggleTaskSource("- [ ] a", "\n", Number.NaN)).toBeNull();
  });
});

describe("linkFragment", () => {
  it("returns the decoded fragment, or an empty string", () => {
    expect(linkFragment("other.md#Some%20Heading")).toBe("Some Heading");
    expect(linkFragment("other.md")).toBe("");
    expect(linkFragment("#")).toBe("");
  });
});

describe("blockRemoteImages", () => {
  it("replaces internet images with their alt text and keeps local images", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<p><img src="https://example.com/a.png" alt="Chart"></p>' +
      '<img src="assets/local.png" alt="Local">' +
      '<img srcset="//cdn.example.com/b.png 2x" alt="">' +
      '<video poster="https://example.com/p.jpg"></video>' +
      '<span style="background:url(https://example.com/bg.png)">x</span>';

    expect(blockRemoteImages(root)).toBe(2);
    expect(root.querySelectorAll("img")).toHaveLength(1);
    expect(root.querySelector("img")?.getAttribute("src")).toBe("assets/local.png");
    expect(root.querySelector(".remote-image")?.textContent).toBe("Chart");
    expect(root.querySelectorAll(".remote-image")[1]?.textContent).toBe("Image");
    expect(root.querySelector("video")?.hasAttribute("poster")).toBe(false);
    expect(root.querySelector("span[style]")).toBeNull();
    expect(root.innerHTML).not.toContain("example.com");
  });
});
