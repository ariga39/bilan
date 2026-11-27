import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

function Card({ className, children, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "grimoire-card text-card-foreground flex flex-col gap-6 rounded-2xl border border-[#f5d08a]/35 py-6 backdrop-blur-md",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-2 left-2.5 text-[9px] leading-none text-[#f5d08a]/55"
      >
        ✦
      </span>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-2 right-2.5 text-[9px] leading-none text-[#f5d08a]/55"
      >
        ✦
      </span>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute bottom-2 left-2.5 text-[9px] leading-none text-[#f5d08a]/40"
      >
        ✦
      </span>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute right-2.5 bottom-2 text-[9px] leading-none text-[#f5d08a]/40"
      >
        ✦
      </span>
      {children}
    </div>
  );
}

function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-1.5 px-6 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-6",
        className,
      )}
      {...props}
    />
  );
}

function CardTitle({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn("leading-none font-semibold", className)}
      {...props}
    />
  );
}

function CardDescription({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  );
}

function CardAction({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn("col-start-2 row-span-2 row-start-1 self-start justify-self-end", className)}
      {...props}
    />
  );
}

function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("px-6", className)} {...props} />;
}

function CardFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex items-center px-6 [.border-t]:pt-6", className)}
      {...props}
    />
  );
}

export { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle };
