import config from "../deploy.config.ts";
import { resolveResidency } from "./residency.ts";

export const residency = resolveResidency(config);
