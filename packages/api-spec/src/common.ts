import * as Schema from "effect/Schema";

export const Id = Schema.NonEmptyString;

export const Ulid = Schema.String.check(Schema.isPattern(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/));

export const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/),
  Schema.makeFilter(
    (value: string) => {
      const milliseconds = Date.parse(value);

      return (
        Number.isFinite(milliseconds) &&
        new Date(milliseconds).toISOString().slice(0, 19) === value.slice(0, 19)
      );
    },
    { message: "Expected a valid UTC timestamp" },
  ),
);

export const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));
export const CacheScope = Schema.Literals(["read", "read write"]);
export const ProjectRole = Schema.Literals(["project:admin", "cache:write", "cache:read"]);

export const CiProvider = Schema.Literals([
  "github",
  "gitlab",
  "circleci",
  "buildkite",
  "bitbucket",
  "vercel",
  "aws-eks",
  "google",
  "azure",
  "custom",
]);

export const PaginationQuery = Schema.Struct({
  cursor: Schema.optional(Schema.NonEmptyString),
  limit: Schema.optional(PositiveInteger.check(Schema.isLessThanOrEqualTo(100))),
});

export const TimeRangeQuery = Schema.Struct({
  from: Timestamp,
  to: Timestamp,
});
