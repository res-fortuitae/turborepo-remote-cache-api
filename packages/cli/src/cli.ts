import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { deviceLogin } from "./device.ts";
import { linkProject, logout, whoami, adminRequest } from "./account.ts";
import { runAuthCommand } from "./commands.ts";
import { adminPurge } from "./purge.ts";
import { runDoctor } from "./doctor.ts";

const textFlag = (name: string) => Flag.String(name).pipe(Flag.withDefault(""));
const common = {
  api: textFlag("api"),
  team: textFlag("team"),
  project: textFlag("project"),
  audience: textFlag("audience"),
  strict: Flag.Boolean("strict").pipe(Flag.withDefault(false)),
  unbound: Flag.Boolean("unbound-tokens").pipe(Flag.withDefault(false)),
};
const run = (task: () => Promise<unknown>) =>
  Effect.tryPromise({
    try: task,
    catch: () => new Error("Command failed. Check login, flags, instance URL, and permissions."),
  });
const flags = (value: {
  api: string;
  team: string;
  project: string;
  audience: string;
  strict: boolean;
  unbound: boolean;
}) => [
  ...Object.entries({
    api: value.api,
    team: value.team,
    project: value.project,
    audience: value.audience,
  }).flatMap(([key, value]) => (value ? [`--${key}`, value] : [])),
  ...(value.strict ? ["--strict"] : []),
  ...(value.unbound ? ["--unbound-tokens"] : []),
];
const authCommands = ["exec", "env", "proxy", "proxy-stop", "token", "ci-auth"].map((mode) =>
  Command.make(
    mode,
    {
      ...common,
      format: textFlag("format"),
      state: textFlag("state"),
      refresh: Flag.Boolean("refresh").pipe(Flag.withDefault(false)),
      command: Argument.String("command").pipe(Argument.variadic()),
    },
    (value) =>
      run(async () => {
        process.exitCode = await runAuthCommand([
          mode,
          ...flags(value),
          ...(value.format ? ["--format", value.format] : []),
          ...(value.state ? ["--state", value.state] : []),
          ...(value.refresh ? ["--refresh"] : []),
          ...(value.command.length ? ["--", ...value.command] : []),
        ]);
      }),
  ),
);
const adminGroups = ["projects", "keys", "policies"].map((kind) =>
  Command.make(kind).pipe(
    Command.withSubcommands(
      (kind === "projects"
        ? ["list", "get", "create", "update", "delete"]
        : kind === "keys"
          ? ["list", "create", "revoke"]
          : ["list", "create", "update", "delete", "test"]
      ).map((operation) =>
        Command.make(
          operation,
          {
            team: textFlag("team"),
            project: textFlag("project"),
            id: textFlag("id"),
            json: textFlag("json"),
          },
          (options) => run(() => adminRequest(kind, operation, options)),
        ),
      ),
    ),
  ),
);
const admin = Command.make("admin").pipe(
  Command.withSubcommands([
    ...adminGroups,
    Command.make(
      "purge",
      {
        project: Argument.String("project"),
        filter: textFlag("filter"),
        job: textFlag("job"),
        confirm: Flag.Boolean("confirm").pipe(Flag.withDefault(false)),
      },
      (options) =>
        run(async () => {
          const args = [
            options.project,
            ...(options.filter ? ["--filter", options.filter] : []),
            ...(options.job ? ["--job", options.job] : []),
            ...(options.confirm ? ["--confirm"] : []),
          ];
          console.log(
            JSON.stringify(
              await adminPurge(args, {
                server: Bun.env.TURBO_API,
                cookie: Bun.env.TCACHE_SESSION_COOKIE,
              }),
              null,
              2,
            ),
          );
        }),
    ),
  ]),
);
export const cli = Command.make("tcache").pipe(
  Command.withSubcommands([
    Command.make("login", { api: textFlag("api") }, ({ api }) =>
      run(() => deviceLogin(api || Bun.env.TCACHE_API || Bun.env.TURBO_API || "")),
    ),
    Command.make("logout", {}, () => run(logout)),
    Command.make("whoami", {}, () => run(whoami)),
    Command.make(
      "link",
      {
        api: textFlag("api"),
        team: textFlag("team"),
        project: textFlag("project"),
        force: Flag.Boolean("force").pipe(Flag.withDefault(false)),
      },
      (options) => run(() => linkProject(options)),
    ),
    ...authCommands,
    Command.make(
      "doctor",
      {
        server: Flag.Boolean("server").pipe(Flag.withDefault(false)),
        api: textFlag("api"),
        json: Flag.Boolean("json").pipe(Flag.withDefault(false)),
        policy: Flag.Boolean("policy").pipe(Flag.withDefault(false)),
        project: textFlag("project"),
        url: Argument.String("url").pipe(Argument.withDefault("")),
      },
      (options) => run(() => runDoctor(options)),
    ),
    admin,
  ]),
);
export const runCli = (args: readonly string[]) =>
  Command.runWith(cli, { version: "0.1.0" })(args).pipe(Effect.provide(BunServices.layer));
