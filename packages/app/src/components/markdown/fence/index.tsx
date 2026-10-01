import { HighlightedCodeBlock } from "@/components/highlighted-code-block";
import { getMarkdownFenceLanguage } from "./language";
import type { MarkdownFenceRendererProps } from "./types";

export interface MarkdownFenceBlockProps extends MarkdownFenceRendererProps {
  info: string | null | undefined;
}

// Pi renders every fence (including mermaid) as a highlighted code block; no diagram runtime.
export function MarkdownFenceBlock({
  code,
  info,
  inheritedStyles,
  textStyle,
}: MarkdownFenceBlockProps) {
  const language = getMarkdownFenceLanguage(info);
  return (
    <HighlightedCodeBlock
      code={code}
      language={language}
      inheritedStyles={inheritedStyles}
      textStyle={textStyle}
    />
  );
}
