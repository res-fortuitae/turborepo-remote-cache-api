import { Check } from "lucide-react";
import { cn } from "@repo/ui/lib/utils";

export function Stepper({
  steps,
  current,
}: {
  readonly steps: ReadonlyArray<string>;
  readonly current: number;
}) {
  return (
    <ol aria-label="Setup progress" className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {steps.map((step, index) => {
        const done = index < current;
        const active = index === current;

        return (
          <li
            key={step}
            aria-current={active ? "step" : undefined}
            className="flex items-center gap-2 text-xs"
          >
            <span
              className={cn(
                "flex size-6 items-center justify-center rounded-full border font-mono text-[11px]",
                done && "border-brand bg-brand text-brand-foreground",
                active && "border-foreground text-foreground",
                !done && !active && "text-muted-foreground",
              )}
            >
              {done ? <Check className="size-3.5" aria-label="Done" /> : index + 1}
            </span>
            <span className={cn(active ? "font-medium" : "text-muted-foreground")}>{step}</span>
            {index < steps.length - 1 ? (
              <span aria-hidden="true" className="h-px w-6 bg-border" />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
