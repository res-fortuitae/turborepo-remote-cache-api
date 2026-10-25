import { DatabaseTest } from "@repo/db/testing";
import { Layer } from "effect";
import { AuthorizationLive } from "./authorization.ts";

/** Authoritative session/org decisions over a fresh migrated test database. */
export const AuthorizationTest = AuthorizationLive.pipe(Layer.provideMerge(DatabaseTest));
