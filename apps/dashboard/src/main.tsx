import { StrictMode } from "react";
// oxlint-disable-next-line t3code/require-disposable-render -- The browser entry point owns its React root for the page lifetime.
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";

// Set the initial theme before React paints, including when storage is unavailable.
let dark = matchMedia("(prefers-color-scheme: dark)").matches;

try {
  const saved = localStorage.getItem("remote-cache-theme");

  if (saved === "light" || saved === "dark") dark = saved === "dark";
} catch {
  // Private browser policies can disable storage; the system preference still works.
}

document.documentElement.classList.toggle("dark", dark);

const root = document.getElementById("root");

if (root === null) throw new Error("Dashboard root is missing");

// oxlint-disable-next-line t3code/require-disposable-render -- This is the browser entry point; the React root owns the page lifetime.
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
