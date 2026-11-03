import { type ReactNode, useEffect } from "react";

/** A modal dialog over a scrim: a title, a body and a row of buttons.
 * With `onCancel`, Escape and a click on the scrim call it. `wide` is the
 * export dialog's width; most dialogs are the small one. */
export function Dialog({
  label,
  title,
  wide = false,
  onCancel,
  footer,
  children,
}: {
  label: string;
  title: ReactNode;
  wide?: boolean;
  onCancel?: () => void;
  footer: ReactNode;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!onCancel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);
  return (
    <div className="scrim" onPointerDown={(e) => onCancel && e.target === e.currentTarget && onCancel()}>
      <div className={`dlg ${wide ? "export" : "small"}`} role="dialog" aria-label={label}>
        <header>{title}</header>
        <div className="bd">{children}</div>
        <footer>{footer}</footer>
      </div>
    </div>
  );
}
