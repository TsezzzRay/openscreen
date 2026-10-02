import { X } from "lucide-react";

import type { ImportedAttachment } from "@shared/ipc.ts";

export function AttachmentStrip({
  attachments,
  onRemove,
  onOpen,
}: {
  attachments: ImportedAttachment[];
  onRemove?: ((id: string) => void) | undefined;
  onOpen?: ((attachment: ImportedAttachment) => void) | undefined;
}): React.ReactNode {
  if (attachments.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-2">
      {attachments.map((attachment) => (
        <li key={attachment.id} className="group relative">
          <button
            type="button"
            onClick={() => onOpen?.(attachment)}
            className="block overflow-hidden rounded-lg border border-edge transition-colors hover:border-white/25"
            aria-label="Open screenshot"
          >
            <img
              src={attachment.url}
              alt=""
              className="h-12 w-[72px] object-cover"
              draggable={false}
            />
          </button>
          {onRemove === undefined ? null : (
            <button
              type="button"
              onClick={() => onRemove(attachment.id)}
              className="absolute -right-1.5 -top-1.5 flex size-[18px] items-center justify-center rounded-full border border-edge bg-surface text-ink-dim opacity-0 transition-opacity hover:text-ink group-hover:opacity-100 focus-visible:opacity-100"
              aria-label="Remove screenshot"
            >
              <X size={11} strokeWidth={2.5} aria-hidden />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
