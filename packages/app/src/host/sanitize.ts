// Prompt text as a terminal paste may carry it: no control sequences of its own.
// pi reads the prompt from a bracketed paste; an ESC (e.g. `ESC[201~`) inside the text would end
// the paste early and the rest would be read as typed keys. A scanner, not a regex (oxlint's
// no-control-regex).

/** CRLF and CR become LF; every C0/C1 control character except LF and TAB (and DEL) is dropped. */
export function sanitizePrompt(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x0d) {
      out += "\n";
      if (text.charCodeAt(i + 1) === 0x0a) i++;
      continue;
    }
    if (code === 0x0a || code === 0x09) {
      out += text[i];
      continue;
    }
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) continue;
    out += text[i];
  }
  return out;
}
