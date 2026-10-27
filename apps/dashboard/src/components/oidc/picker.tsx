"use client";

import * as React from "react";

import { cn } from "@repo/ui/lib/utils";
import { Field, FieldLabel } from "@repo/ui/components/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select";
import { ToggleGroup, ToggleGroupItem } from "@repo/ui/components/toggle-group";

type PickerProvider = {
  value: string;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
};

function ProviderPicker({
  providers,
  value,
  onValueChange,
  className,
}: {
  providers: PickerProvider[];
  value: string;
  onValueChange: (value: string) => void;
  className?: string;
}) {
  const labelId = React.useId();

  if (providers.length < 2) {
    return null;
  }

  const isSelect = providers.length > 3;

  return (
    <Field>
      <FieldLabel htmlFor={isSelect ? labelId : undefined} id={isSelect ? undefined : labelId}>
        Provider
      </FieldLabel>
      {isSelect ? (
        <Select
          items={providers}
          value={value}
          onValueChange={(providerId) => {
            if (typeof providerId === "string") {
              onValueChange(providerId);
            }
          }}
        >
          <SelectTrigger id={labelId} className={cn("w-full", className)}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {providers.map((provider) => (
                <SelectItem key={provider.value} value={provider.value}>
                  {provider.icon ? <provider.icon /> : null} {provider.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      ) : (
        <div className="w-full min-w-0 overflow-x-auto">
          <ToggleGroup
            variant="outline"
            value={[value]}
            aria-labelledby={labelId}
            onValueChange={([providerId]) => {
              if (typeof providerId === "string") {
                onValueChange(providerId);
              }
            }}
            className={cn("w-max", className)}
          >
            {providers.map((provider) => (
              <ToggleGroupItem key={provider.value} value={provider.value}>
                {provider.icon ? <provider.icon /> : null} {provider.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      )}
    </Field>
  );
}

export { ProviderPicker };
export type { PickerProvider };
