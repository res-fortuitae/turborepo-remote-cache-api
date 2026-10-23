import { HttpApiMiddleware } from "effect/http-api";
import { ApiErrors } from "./http-errors.ts";

/** Host supplies session/credential authentication and authorization for each route. */
export class ApiAuthorization extends HttpApiMiddleware.Service<ApiAuthorization>()(
  "@repo/api-spec/ApiAuthorization",
  { error: ApiErrors },
) {}
