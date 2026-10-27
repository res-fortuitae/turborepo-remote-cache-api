import { useState } from "react";
import { Moon, Sun } from "lucide-react";
import { Button } from "@repo/ui/components/button";

export function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));

  function toggle() {
    const next = !dark;
    document.documentElement.classList.toggle("dark", next);
    setDark(next);

    try {
      localStorage.setItem("remote-cache-theme", next ? "dark" : "light");
    } catch {
      // A blocked storage write should not prevent switching themes.
    }
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={`Switch to ${dark ? "light" : "dark"} theme`}
      onClick={toggle}
    >
      {dark ? <Sun /> : <Moon />}
    </Button>
  );
}
