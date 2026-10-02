// Which xterm renderer the webview uses. WebGL is the fast path, but on a software GL stack
// (SwiftShader on emulators and GPU-blocklisted devices, Mesa llvmpipe/softpipe) its glyph
// atlas tears: gaps inside letters and broken box-drawing rows. There the DOM renderer is
// both crisp and fast enough, so it wins. WebGL that fails to load or loses its context also
// falls back to the DOM renderer (handled where the addon is loaded).

export type TerminalRendererKind = "webgl" | "dom";

export interface WebglProbe {
  /** A WebGL2 context could be created (xterm's WebGL addon needs WebGL2). */
  supported: boolean;
  /** UNMASKED_RENDERER_WEBGL when WEBGL_debug_renderer_info is exposed, else RENDERER. */
  renderer: string | null;
}

export interface TerminalRendererChoice {
  renderer: TerminalRendererKind;
  reason: "webgl" | "no-webgl2" | "software-gl";
  glRenderer: string | null;
}

const SOFTWARE_GL = /swiftshader|llvmpipe|softpipe|software rasterizer|microsoft basic render/i;

export function isSoftwareGlRenderer(renderer: string | null | undefined): boolean {
  return typeof renderer === "string" && SOFTWARE_GL.test(renderer);
}

export function chooseTerminalRenderer(probe: WebglProbe): TerminalRendererChoice {
  if (!probe.supported) return { renderer: "dom", reason: "no-webgl2", glRenderer: null };
  if (isSoftwareGlRenderer(probe.renderer))
    return { renderer: "dom", reason: "software-gl", glRenderer: probe.renderer };
  return { renderer: "webgl", reason: "webgl", glRenderer: probe.renderer };
}

interface ProbeDocument {
  createElement(tag: "canvas"): HTMLCanvasElement;
}

/** Creates a throwaway WebGL2 context and reads its renderer string; never throws. */
export function probeWebgl(doc: ProbeDocument): WebglProbe {
  try {
    const canvas = doc.createElement("canvas");
    const gl = canvas.getContext("webgl2") as WebGL2RenderingContext | null;
    if (!gl) return { supported: false, renderer: null };
    const info = gl.getExtension("WEBGL_debug_renderer_info") as {
      UNMASKED_RENDERER_WEBGL: number;
    } | null;
    const value: unknown = info
      ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return { supported: true, renderer: typeof value === "string" ? value : null };
  } catch {
    return { supported: false, renderer: null };
  }
}
