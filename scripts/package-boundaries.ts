import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as ts from "typescript-parser";

interface DependencyPolicy {
  readonly [consumer: string]: readonly string[] | undefined;
}

// Values are the packages a consumer may depend on, never the reverse.
export const dependencies: DependencyPolicy = {
  "@repo/shared": ["@repo/api-spec"],
  "@repo/api-spec": [],
  "@repo/deploy-config": [],
  "@repo/infra": [],
  "@repo/db": ["@repo/api-spec", "@repo/deploy-config"],
  "@repo/mailer": ["@repo/deploy-config"],
  "@repo/ratelimit": ["@repo/deploy-config"],
  "@repo/coordinator": ["@repo/api-spec", "@repo/deploy-config"],
  "@repo/audit": ["@repo/api-spec", "@repo/db"],
  "@repo/auth": [
    "@repo/api-spec",
    "@repo/deploy-config",
    "@repo/db",
    "@repo/mailer",
    "@repo/audit",
  ],
  "@repo/authz": ["@repo/api-spec", "@repo/db", "@repo/auth"],
  "@repo/credentials": [
    "@repo/api-spec",
    "@repo/deploy-config",
    "@repo/db",
    "@repo/auth",
    "@repo/coordinator",
  ],
  "@repo/oidc": ["@repo/api-spec", "@repo/deploy-config", "@repo/db"],
  "@repo/artifacts": [
    "@repo/api-spec",
    "@repo/deploy-config",
    "@repo/db",
    "@repo/authz",
    "@repo/credentials",
    "@repo/coordinator",
  ],
  "@repo/analytics": ["@repo/api-spec", "@repo/db"],
  "@repo/client-core": ["@repo/api-spec"],
  "@repo/config": [],
};

const entrypoints = new Set(["@repo/server", "@repo/dashboard", "@repo/cli", "@repo/action"]);

// Alchemy resolves a Worker's runtime bindings from the resource declarations it yields.
const infraHosts = new Set(["@repo/server"]);

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

interface Workspace {
  directory: string;
  manifest: Manifest;
}

function files(directory: string): string[] {
  return NodeFS.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (["node_modules", ".git", ".turbo", "vendor", "dist", ".alchemy"].includes(entry.name))
      return [];
    const path = NodePath.join(directory, entry.name);

    return entry.isDirectory() ? files(path) : /\.[cm]?[jt]sx?$/.test(path) ? [path] : [];
  });
}

export function checkBoundaries(root: string): string[] {
  const workspaces: Workspace[] = [];

  for (const parent of ["apps", "packages"]) {
    const directory = NodePath.join(root, parent);

    if (!NodeFS.existsSync(directory)) continue;

    for (const name of NodeFS.readdirSync(directory)) {
      const directory = NodePath.join(root, parent, name);
      const path = NodePath.join(directory, "package.json");

      if (!NodeFS.existsSync(path)) continue;
      const manifest: Manifest = JSON.parse(NodeFS.readFileSync(path, "utf8"));
      workspaces.push({ directory, manifest });
    }
  }

  const errors: string[] = [];
  const byName = new Map(workspaces.map((workspace) => [workspace.manifest.name, workspace]));
  const edges = new Map<string, Set<string>>();

  function edge(source: Workspace, target: string, location: string, tooling = false) {
    if (source.manifest.name === target) return;
    const name = source.manifest.name;

    if (tooling && target === "@repo/config") return;
    const allowed = dependencies[name];

    if (
      !byName.has(target) ||
      (!allowed && !entrypoints.has(name)) ||
      (allowed
        ? !allowed.includes(target)
        : target === "@repo/config" ||
          (target === "@repo/infra" && !infraHosts.has(name)) ||
          entrypoints.has(target))
    ) {
      errors.push(`${location}: forbidden dependency ${name} -> ${target}`);
    }

    const targets = edges.get(name) ?? new Set<string>();
    targets.add(target);
    edges.set(name, targets);
  }

  for (const workspace of workspaces) {
    const { manifest } = workspace;

    if (!dependencies[manifest.name] && !entrypoints.has(manifest.name)) {
      errors.push(`${manifest.name}: add an explicit package boundary policy`);
    }

    for (const field of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ] as const) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        if (name.startsWith("@repo/"))
          edge(
            workspace,
            name,
            `${manifest.name}/package.json (${field})`,
            field === "devDependencies",
          );
      }
    }

    for (const file of files(workspace.directory)) {
      const source = ts.createSourceFile(
        file,
        NodeFS.readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );

      const tooling =
        /(?:oxlint|oxfmt)\.config\.mts$/.test(file) ||
        file.startsWith(NodePath.join(root, "packages/config") + NodePath.sep);

      function specifier(value: string, node: ts.Node) {
        const location = `${NodePath.relative(root, file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;

        if (value.startsWith("@repo/")) {
          const target = value.split("/").slice(0, 2).join("/");
          edge(workspace, target, location, tooling);

          const declared = [
            manifest.dependencies,
            manifest.devDependencies,
            manifest.peerDependencies,
            manifest.optionalDependencies,
          ].some((deps) => deps?.[target]);

          if (target !== manifest.name && !declared)
            errors.push(`${location}: undeclared workspace dependency ${target}`);

          if (target !== "@repo/config" && value !== target)
            errors.push(`${location}: import ${target} through its public entry point`);
        } else if (value.startsWith(".") || NodePath.isAbsolute(value)) {
          const resolved = NodePath.resolve(NodePath.dirname(file), value);

          if (!resolved.startsWith(workspace.directory + NodePath.sep)) {
            // Existing server tooling reads the organization config at the root.
            const config = ["deploy.config.ts", "deploy.config.example.ts"].map((name) =>
              NodePath.join(root, name),
            );

            if (manifest.name !== "@repo/server" || !config.includes(resolved))
              errors.push(`${location}: relative import escapes workspace: ${value}`);
          }
        } else if (value.startsWith("#"))
          errors.push(`${location}: import aliases require an explicit boundary policy`);
      }

      function visit(node: ts.Node) {
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteralLike(node.moduleSpecifier)
        )
          specifier(node.moduleSpecifier.text, node);

        if (
          ts.isImportTypeNode(node) &&
          ts.isLiteralTypeNode(node.argument) &&
          ts.isStringLiteralLike(node.argument.literal)
        )
          specifier(node.argument.literal.text, node);

        if (
          ts.isExternalModuleReference(node) &&
          node.expression &&
          ts.isStringLiteralLike(node.expression)
        )
          specifier(node.expression.text, node);

        if (
          ts.isCallExpression(node) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === "require"))
        ) {
          const argument = node.arguments[0];

          if (argument && ts.isStringLiteralLike(argument)) specifier(argument.text, node);
          else if (file !== NodePath.join(root, "apps/server/scripts/config.ts"))
            errors.push(
              `${NodePath.relative(root, file)}: computed imports cannot be boundary checked`,
            );
        }

        ts.forEachChild(node, visit);
      }

      visit(source);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();

  function cycle(name: string, path: string[]) {
    if (visiting.has(name)) {
      errors.push(`dependency cycle: ${[...path, name].join(" -> ")}`);

      return;
    }

    if (visited.has(name)) return;
    visiting.add(name);

    for (const target of edges.get(name) ?? []) cycle(target, [...path, name]);
    visiting.delete(name);
    visited.add(name);
  }

  for (const name of edges.keys()) cycle(name, []);

  return errors;
}
