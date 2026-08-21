import { useEffect, useRef, type ClipboardEvent, type KeyboardEvent } from "react";

const MIN_HEIGHT = 22;
const MAX_HEIGHT = 120;

export interface ComposerProps {
  value: string;
  placeholder: string;
  disabled: boolean;
  focusRequest: number;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onPasteImages: (buffers: Uint8Array[]) => void;
  /** Overlay only: shell-style recall through the session's earlier questions. */
  onHistory?: ((direction: -1 | 1) => void) | undefined;
  className?: string;
}

/**
 * Enter sends and Shift+Enter breaks the line, matching every other composer on
 * the platform. The field grows with its content up to a ceiling and then
 * scrolls, so a long paste never pushes the answer off screen.
 */
export function Composer({
  value,
  placeholder,
  disabled,
  focusRequest,
  onChange,
  onSubmit,
  onPasteImages,
  onHistory,
  className = "",
}: ComposerProps): React.ReactNode {
  const textarea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const element = textarea.current;
    if (element === null) return;
    element.style.height = "0px";
    element.style.height = `${Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, element.scrollHeight))}px`;
  }, [value]);

  useEffect(() => {
    textarea.current?.focus();
  }, [focusRequest]);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSubmit();
      return;
    }
    if (onHistory === undefined || value.includes("\n")) return;
    if (event.key === "ArrowUp" && textarea.current?.selectionStart === 0) {
      event.preventDefault();
      onHistory(-1);
    }
    if (event.key === "ArrowDown" && textarea.current?.selectionStart === value.length) {
      event.preventDefault();
      onHistory(1);
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.items]
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length === 0) return;
    event.preventDefault();
    void Promise.all(files.map((file) => file.arrayBuffer())).then((buffers) => {
      onPasteImages(buffers.map((buffer) => new Uint8Array(buffer)));
    });
  };

  return (
    <textarea
      ref={textarea}
      value={value}
      rows={1}
      disabled={disabled}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      className={`no-drag w-full resize-none bg-transparent leading-[22px] text-ink outline-none placeholder:text-ink-faint disabled:opacity-50 ${className}`}
    />
  );
}
