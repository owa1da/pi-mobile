import { describe, expect, it } from "vitest";
import {
  chooseTerminalRenderer,
  isSoftwareGlRenderer,
  probeWebgl,
} from "./terminal-renderer-choice";

describe("isSoftwareGlRenderer", () => {
  it("flags SwiftShader, llvmpipe and other software rasterizers", () => {
    expect(
      isSoftwareGlRenderer(
        "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
      ),
    ).toBe(true);
    expect(isSoftwareGlRenderer("Google SwiftShader")).toBe(true);
    expect(isSoftwareGlRenderer("llvmpipe (LLVM 17.0.6, 256 bits)")).toBe(true);
    expect(isSoftwareGlRenderer("Mesa softpipe")).toBe(true);
    expect(isSoftwareGlRenderer("Microsoft Basic Render Driver")).toBe(true);
  });

  it("accepts hardware GPUs and unknown renderers", () => {
    expect(isSoftwareGlRenderer("Adreno (TM) 740")).toBe(false);
    expect(isSoftwareGlRenderer("Mali-G715")).toBe(false);
    expect(isSoftwareGlRenderer("ANGLE (Qualcomm, Adreno (TM) 650, OpenGL ES 3.2)")).toBe(false);
    expect(isSoftwareGlRenderer(null)).toBe(false);
    expect(isSoftwareGlRenderer(undefined)).toBe(false);
  });
});

describe("chooseTerminalRenderer", () => {
  it("uses WebGL on a hardware GPU and DOM on software GL or without WebGL2", () => {
    expect(chooseTerminalRenderer({ supported: true, renderer: "Adreno (TM) 740" })).toEqual({
      renderer: "webgl",
      reason: "webgl",
      glRenderer: "Adreno (TM) 740",
    });
    expect(chooseTerminalRenderer({ supported: true, renderer: null }).renderer).toBe("webgl");
    expect(
      chooseTerminalRenderer({ supported: true, renderer: "Google SwiftShader" }),
    ).toMatchObject({ renderer: "dom", reason: "software-gl" });
    expect(chooseTerminalRenderer({ supported: false, renderer: null })).toMatchObject({
      renderer: "dom",
      reason: "no-webgl2",
    });
  });
});

function fakeDoc(context: unknown, throws = false) {
  return {
    createElement: () =>
      ({
        getContext: () => {
          if (throws) throw new Error("boom");
          return context;
        },
      }) as unknown as HTMLCanvasElement,
  };
}

describe("probeWebgl", () => {
  it("reads the unmasked renderer and releases the context", () => {
    let lost = false;
    const gl = {
      RENDERER: 1,
      getExtension: (name: string) => {
        if (name === "WEBGL_debug_renderer_info") return { UNMASKED_RENDERER_WEBGL: 2 };
        if (name === "WEBGL_lose_context")
          return {
            loseContext: () => {
              lost = true;
            },
          };
        return null;
      },
      getParameter: (p: number) => (p === 2 ? "Google SwiftShader" : "WebKit WebGL"),
    };
    expect(probeWebgl(fakeDoc(gl))).toEqual({ supported: true, renderer: "Google SwiftShader" });
    expect(lost).toBe(true);
  });

  it("falls back to RENDERER without the debug extension", () => {
    const gl = { RENDERER: 1, getExtension: () => null, getParameter: () => "WebKit WebGL" };
    expect(probeWebgl(fakeDoc(gl))).toEqual({ supported: true, renderer: "WebKit WebGL" });
  });

  it("reports no WebGL2 when the context is missing or creation throws", () => {
    expect(probeWebgl(fakeDoc(null))).toEqual({ supported: false, renderer: null });
    expect(probeWebgl(fakeDoc(null, true))).toEqual({ supported: false, renderer: null });
  });
});
