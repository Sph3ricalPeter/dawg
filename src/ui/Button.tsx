import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { Icon, type IconName } from "./Icon";

type Native = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> & { ref?: Ref<HTMLButtonElement>; className?: string };

/** A labelled button: "default" for most, "primary" for the one a dialog
 * is for (Enter), "ghost" for Cancel and other ways out. */
export function Button({
  variant = "default",
  small = false,
  className = "",
  ...rest
}: Native & { variant?: "default" | "primary" | "ghost"; small?: boolean }) {
  const cls = ["btn", variant !== "default" && variant, small && "small", className].filter(Boolean).join(" ");
  return <button type="button" className={cls} {...rest} />;
}

/** A toolbar button: an icon (or icon and text), lit when `on`. */
export function ToolButton({
  icon,
  on = false,
  className = "",
  children,
  ...rest
}: Native & { icon?: IconName; on?: boolean; children?: ReactNode }) {
  return (
    <button type="button" className={`tb${on ? " on" : ""}${className ? ` ${className}` : ""}`} {...rest}>
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
}

/** The × that closes a panel or removes a row or chip. "sm" sits inline in
 * a chip or a list row. */
export function CloseButton({ size = "md", className = "", ...rest }: Native & { size?: "sm" | "md" }) {
  return (
    <button type="button" className={`xbtn ${size}${className ? ` ${className}` : ""}`} {...rest}>
      <Icon name="close" />
    </button>
  );
}

/** A device's or band's power: a green dot when on. */
export function PowerButton({ on, className = "", ...rest }: Native & { on: boolean }) {
  return (
    <button
      type="button"
      className={`pw${on ? "" : " off"}${className ? ` ${className}` : ""}`}
      aria-pressed={on}
      {...rest}
    />
  );
}
