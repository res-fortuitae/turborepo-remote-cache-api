import { Schema } from "effect";

export class ClientAuthError extends Schema.TaggedError<ClientAuthError>()("ClientAuthError", {
  reason: Schema.Literals([
    "configuration",
    "permission",
    "missing_token",
    "provider",
    "policy_denied",
    "api_keys_disallowed",
    "unreachable",
    "invalid_response",
    "dpop",
    "login_required",
    "rate_limited",
  ]),
  message: Schema.String,
}) {}
