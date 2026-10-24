# Shared UI

`@repo/ui` owns the web design system: shadcn **Mira**, Base UI primitives,
Lucide icons, and neutral semantic tokens with light/dark themes. Components were
generated with the official shadcn CLI 4.22.1 using `style: base-mira`. The CLI
cannot detect Bun-only projects for `init`/`apply`, so the package uses shadcn's
[manual setup](https://ui.shadcn.com/docs/installation/manual) and registry `add`.
Both package and dashboard `components.json` files point at this shared system.

```tsx
import { Button } from "@repo/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@repo/ui/components/card";
import { cn } from "@repo/ui/lib/utils";
```

Import `@repo/ui/styles.css` once from the consuming application's stylesheet.
That stylesheet must scan its own source with Tailwind's `@source` directive;
the shared stylesheet already scans the UI components. The font tokens use
Inter Variable and JetBrains Mono Variable. The dashboard bundles their Latin
font files from Fontsource locally, without third-party requests.

Add components from the repository root:

```sh
bunx --bun shadcn@4.22.1 add @shadcn/input --cwd packages/ui
```

Use semantic colors and built-in variants. Shared components, tokens, and utilities
belong here; page layout and product behavior belong in `apps/dashboard`. This
package cannot depend on backend/domain workspaces. Only `components/*`,
`lib/utils`, and `styles.css` are public exports; importing `src/*` is forbidden.
Components are consumed directly as TypeScript source, without a separate build.

The source is derived from [shadcn/ui](https://github.com/shadcn-ui/ui), under its
[MIT license](https://github.com/shadcn-ui/ui/blob/main/LICENSE.md). Local adaptations
keep focus rings inside controls and forward Tabs orientation. Web dark selectors
are retained; the Uniwind-specific lint rule is suppressed only in those generated
components. `cn` is the official shadcn class-merging utility. Fontsource fonts
retain their OFL licenses in their packages.
