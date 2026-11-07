import { motionEase, motionMs } from "./tokens";

const root = document.documentElement;

afterEach(() => {
  root.style.removeProperty("--motion-enter");
  root.style.removeProperty("--ease-out");
});

describe("motionMs", () => {
  it("reads the duration token from the root in ms", () => {
    root.style.setProperty("--motion-enter", "280ms");
    expect(motionMs("enter")).toBe(280);
  });

  it("reads the root even when the element sets its own value", () => {
    root.style.setProperty("--motion-enter", "0ms");
    const el = document.createElement("div");
    el.style.setProperty("--motion-enter", "280ms");
    document.body.append(el);
    expect(motionMs("enter", el)).toBe(0);
    el.remove();
  });

  it("is 0 when the token is missing", () => {
    expect(motionMs("enter")).toBe(0);
  });
});

describe("motionEase", () => {
  it("trims the easing token", () => {
    root.style.setProperty("--ease-out", "  cubic-bezier(0.16, 1, 0.3, 1)");
    expect(motionEase("out")).toBe("cubic-bezier(0.16, 1, 0.3, 1)");
  });

  it("falls back to ease-out when the token is missing", () => {
    expect(motionEase("out")).toBe("ease-out");
  });
});
