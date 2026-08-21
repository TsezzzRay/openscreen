import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Answers are the only rich text in the product. Memoised because a streaming
 * run re-renders the containing turn on every delta.
 */
export const Markdown = memo(function Markdown({
  children,
}: {
  children: string;
}): React.ReactNode {
  return (
    <div className="prose-answer">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
});
