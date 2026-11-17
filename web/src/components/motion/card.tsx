"use client";
// beui.dev/components/motion/card

import { animate, isDragActive, motion, useMotionValue, useReducedMotion } from "motion/react";
import { type ComponentPropsWithRef, createContext, useContext, useEffect, useRef } from "react";
import { SPRING_PRESS } from "@/lib/ease";
import { cn } from "@/lib/utils";

export type CardVariant = "outlined" | "muted";
export type CardSize = "default" | "compact";

const CardSizeContext = createContext<CardSize>("default");
const CardVariantContext = createContext<CardVariant>("outlined");

const VARIANT_CLASS: Record<CardVariant, string> = {
  outlined: "border-b border-border/75 bg-transparent",
  muted: "rounded-lg bg-muted/45",
};

// Each part pads itself on the inline axis, so a part can be left out without
// the others losing their edges. The root owns the block padding and the gap.
const ROOT_SIZE_CLASS: Record<CardSize, string> = {
  default: "gap-4 py-5",
  compact: "gap-3 py-3.5",
};
const INSET_CLASS: Record<CardVariant, Record<CardSize, string>> = {
  outlined: {
    default: "px-0",
    compact: "px-0",
  },
  muted: {
    default: "px-4",
    compact: "px-3",
  },
};

/**
 * Spread onto the one control that owns a card (a Checkbox or RadioGroupItem
 * root, or a link or button) to stretch its hit area over the whole card. Any
 * other interactive element inside that card needs `relative z-10` to stay on top.
 */
export const CARD_TARGET_CLASS = "after:absolute after:inset-0";

export interface CardProps extends ComponentPropsWithRef<"div"> {
  /** Default "outlined" (flat divider-separated section). */
  variant?: CardVariant;
  /** Spacing for every part. Default "default". */
  size?: CardSize;
  /**
   * Hover and press feedback, for a card that is one target as a whole. Visual
   * only: the card never takes focus, so put the control that owns it inside
   * and stretch it with `CARD_TARGET_CLASS`.
   */
  interactive?: boolean;
  /** Marks a selectable card as chosen. Visual only; the control inside carries the state. */
  selected?: boolean;
}

export function Card({
  variant = "outlined",
  size = "default",
  interactive = false,
  selected = false,
  className,
  children,
  style,
  onPointerDown,
  ...props
}: CardProps) {
  const reduce = useReducedMotion();
  // The press is driven by hand: whileTap would make motion give the card
  // tabIndex 0, an unnamed tab stop ahead of the control that owns the card.
  const scale = useMotionValue(1);
  const releaseRef = useRef<(() => void) | null>(null);

  // Turning `interactive` off or unmounting mid-press settles the card.
  useEffect(() => {
    if (!interactive) return;
    return () => releaseRef.current?.();
  }, [interactive]);

  const press = (event: React.PointerEvent<HTMLDivElement>) => {
    onPointerDown?.(event);
    if (!interactive || reduce || releaseRef.current) return;
    if (!event.isPrimary || event.button !== 0 || isDragActive()) return;

    // Capture phase, as motion's own press does, so a descendant that stops
    // pointerup propagation cannot leave the card pressed.
    const options = { capture: true };
    const release = () => {
      window.removeEventListener("pointerup", release, options);
      window.removeEventListener("pointercancel", release, options);
      window.removeEventListener("pointermove", releaseOnDrag);
      releaseRef.current = null;
      animate(scale, 1, SPRING_PRESS);
    };
    // A drag that starts from the card (a sheet or swipeable row around it)
    // takes over the gesture, so the press ends there. Bubble phase: motion's
    // pan session sets the drag lock in its own window pointermove, registered
    // before this one, so the move that starts the drag already reads it.
    const releaseOnDrag = () => {
      if (isDragActive()) release();
    };
    window.addEventListener("pointerup", release, options);
    window.addEventListener("pointercancel", release, options);
    window.addEventListener("pointermove", releaseOnDrag);
    releaseRef.current = release;
    animate(scale, 0.985, SPRING_PRESS);
  };

  return (
    <CardVariantContext.Provider value={variant}>
      <CardSizeContext.Provider value={size}>
        <motion.div
          {...(props as React.ComponentProps<typeof motion.div>)}
          onPointerDown={press}
          // Only an interactive card carries the scale, so a plain one keeps
          // any transform the caller gives it.
          style={interactive ? { ...style, scale } : style}
          data-slot="card"
          data-selected={selected || undefined}
          className={cn(
            "relative flex flex-col text-card-foreground",
            "transition-[border-color,background-color] duration-200",
            VARIANT_CLASS[variant],
            ROOT_SIZE_CLASS[size],
            interactive &&
              "cursor-pointer rounded-lg hover:bg-muted/50 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-foreground",
            selected && "rounded-lg bg-primary/8",
            className,
          )}
        >
          {children}
        </motion.div>
      </CardSizeContext.Provider>
    </CardVariantContext.Provider>
  );
}

export type CardHeaderProps = ComponentPropsWithRef<"div">;

/** Title and description, with an optional CardAction pinned to the top right. */
export function CardHeader({ className, ...props }: CardHeaderProps) {
  const size = useContext(CardSizeContext);
  const variant = useContext(CardVariantContext);
  return (
    <div
      {...props}
      data-slot="card-header"
      className={cn(
        "grid auto-rows-min grid-rows-[auto_auto] items-start gap-1",
        "has-data-[slot=card-action]:grid-cols-[1fr_auto]",
        INSET_CLASS[variant][size],
        className,
      )}
    />
  );
}

export interface CardTitleProps extends ComponentPropsWithRef<"div"> {
  /** Heading level, when the card starts a section. Default "div". */
  as?: "div" | "h2" | "h3" | "h4";
}

export function CardTitle({ as: Tag = "div", className, ...props }: CardTitleProps) {
  return (
    <Tag
      {...props}
      data-slot="card-title"
      className={cn("text-[15px] leading-snug font-semibold text-foreground", className)}
    />
  );
}

export type CardDescriptionProps = ComponentPropsWithRef<"p">;

export function CardDescription({ className, ...props }: CardDescriptionProps) {
  return (
    <p
      {...props}
      data-slot="card-description"
      className={cn("text-xs leading-relaxed text-muted-foreground", className)}
    />
  );
}

export type CardActionProps = ComponentPropsWithRef<"div">;

/** Sits beside the title and description inside CardHeader. */
export function CardAction({ className, ...props }: CardActionProps) {
  return (
    // Flex, not block: an inline-flex control (Checkbox, Radio) would
    // otherwise sit on a text baseline that moves when its mark appears.
    <div
      {...props}
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 flex items-center self-start justify-self-end",
        className,
      )}
    />
  );
}

export type CardContentProps = ComponentPropsWithRef<"div">;

export function CardContent({ className, ...props }: CardContentProps) {
  const size = useContext(CardSizeContext);
  const variant = useContext(CardVariantContext);
  return (
    <div
      {...props}
      data-slot="card-content"
      className={cn("text-sm", INSET_CLASS[variant][size], className)}
    />
  );
}

export type CardFooterProps = ComponentPropsWithRef<"div">;

export function CardFooter({ className, ...props }: CardFooterProps) {
  const size = useContext(CardSizeContext);
  const variant = useContext(CardVariantContext);
  return (
    <div
      {...props}
      data-slot="card-footer"
      className={cn("flex items-center gap-2", INSET_CLASS[variant][size], className)}
    />
  );
}
