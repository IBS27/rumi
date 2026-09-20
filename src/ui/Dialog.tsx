import type { ComponentProps } from "react";
import { X } from "lucide-react";
import { cx } from "./cx";

/**
 * Native <dialog> in plaster. Open it with `ref.current?.showModal()`.
 * Pass `onClose` to render the close control in the corner.
 */
export function Dialog({
  className,
  onClose,
  closeDisabled,
  children,
  ...rest
}: ComponentProps<"dialog"> & {
  onClose?: () => void;
  closeDisabled?: boolean;
}) {
  return (
    <dialog
      className={cx(
        "fixed inset-0 m-auto w-[min(420px,calc(100vw-32px))] max-h-[calc(100dvh-32px)] overflow-y-auto rounded-panel bg-chalk p-6 text-ink shadow-float",
        className,
      )}
      {...rest}
    >
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          disabled={closeDisabled}
          aria-label="Close"
          className="absolute top-3 right-3 rounded-md p-1.5 text-mute hover:bg-wash disabled:opacity-45 cursor-pointer"
        >
          <X size={18} />
        </button>
      )}
      {children}
    </dialog>
  );
}
