import type { ButtonHTMLAttributes } from "react";
import { cx } from "./cx";

export type ButtonVariant = "primary" | "soft" | "quiet" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const variants: Record<ButtonVariant, string> = {
  primary: "bg-teal text-white hover:enabled:bg-teal-deep",
  soft: "bg-white border-line hover:enabled:border-line-strong",
  quiet: "text-teal-deep hover:enabled:bg-teal/8",
  danger: "text-rust hover:enabled:bg-rust/8",
};
const sizes: Record<ButtonSize, string> = {
  sm: "px-2.5 py-1.5 text-xs",
  md: "px-3.5 py-2 text-[13px]",
  lg: "px-5 py-3 text-[15px] rounded-tile",
};

/** The only button. Icons go in as children before the label. */
export function Button({
  variant = "soft",
  size = "md",
  className,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <button
      type={type}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-ctrl border-[1.5px] border-transparent font-medium leading-tight whitespace-nowrap transition-colors cursor-pointer disabled:cursor-default disabled:opacity-45 [&>svg]:size-4 [&>svg]:shrink-0",
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    />
  );
}
