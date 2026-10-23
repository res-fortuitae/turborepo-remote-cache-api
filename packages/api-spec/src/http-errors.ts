import { HttpApiSchema } from "effect/http-api";
import {
  BadRequest,
  Conflict,
  Forbidden,
  InternalError,
  NotFound,
  RateLimited,
  ServiceUnavailable,
  Unauthorized,
} from "./errors.ts";

// Transport annotations stay separate from the reusable error classes.
export const ApiErrors = [
  BadRequest.pipe(HttpApiSchema.status(400)),
  Unauthorized.pipe(HttpApiSchema.status(401)),
  Forbidden.pipe(HttpApiSchema.status(403)),
  NotFound.pipe(HttpApiSchema.status(404)),
  Conflict.pipe(HttpApiSchema.status(409)),
  RateLimited.pipe(HttpApiSchema.status(429)),
  InternalError.pipe(HttpApiSchema.status(500)),
  ServiceUnavailable.pipe(HttpApiSchema.status(503)),
] as const;
