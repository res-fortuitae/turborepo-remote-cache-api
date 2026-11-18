/** Normalize the destroy target before config or Alchemy can supply a default. */
export const requireDestroyStage = (args: readonly string[]) => {
  const optionsEnd = args.indexOf("--");
  const options = optionsEnd === -1 ? args : args.slice(0, optionsEnd);
  const stageIndex = options.findIndex((arg) => arg === "--stage" || arg.startsWith("--stage="));
  const option = options[stageIndex];
  const separate = option === "--stage";
  const stage = separate ? options[stageIndex + 1] : option?.slice("--stage=".length);
  const end = stageIndex + (separate ? 2 : 1);
  if (
    !stage ||
    !/^[a-z0-9][a-z0-9_-]*$/i.test(stage) ||
    options.slice(end).some((arg) => arg === "--stage" || arg.startsWith("--stage="))
  ) {
    throw new Error("Destroy requires exactly one explicit --stage <name>");
  }
  return ["--stage", stage, ...args.slice(0, stageIndex), ...args.slice(end)];
};
