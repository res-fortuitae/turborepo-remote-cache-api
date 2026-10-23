import * as NodeURL from "node:url";
import { checkBoundaries } from "./package-boundaries.ts";

const errors = checkBoundaries(NodeURL.fileURLToPath(new URL("../", import.meta.url)));

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Package boundaries passed.");
}
