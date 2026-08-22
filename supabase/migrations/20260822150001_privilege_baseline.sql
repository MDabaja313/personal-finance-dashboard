-- Phase 4, migration 1: privilege baseline.
--
-- Establishes the `private` schema (system-internal functions and roles,
-- never exposed through the Data API — it is deliberately absent from
-- `[api] schemas` in supabase/config.toml) and a default-privilege
-- posture so that a function created in `public` or `private` without
-- its own explicit per-function revoke still isn't reachable by
-- `anon`/`authenticated` by default.
--
-- Creates no tables, policies, or functions.
--
-- Verified empirically against the actual local Postgres 17.6 image
-- (Supabase CLI 2.115.0), not assumed:
--
-- PostgreSQL's built-in initial privilege for a new function grants
-- EXECUTE to PUBLIC. `ALTER DEFAULT PRIVILEGES` has two independent
-- scopes for a given role: a per-schema scope (`IN SCHEMA x`) and a
-- global scope (no `IN SCHEMA`, i.e. `FOR ROLE <role>` alone). A
-- per-schema REVOKE cannot remove a privilege supplied by the built-in
-- global default — it has nothing to act against, since the built-in
-- default is not itself a `pg_default_acl` row. Confirmed by direct
-- test: `ALTER DEFAULT PRIVILEGES IN SCHEMA private REVOKE EXECUTE ON
-- FUNCTIONS FROM PUBLIC;` left new functions in `private` fully
-- PUBLIC-executable, while the equivalent GLOBAL form —
-- `ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON
-- FUNCTIONS FROM PUBLIC;`, used below — correctly locked down new
-- functions in both a fresh scratch schema and in `private`
-- (`proacl` became `{postgres=X/postgres}`, `has_function_privilege`
-- false for `anon`/`authenticated` in both).
--
-- This global default-privileges change is scoped to role `postgres`
-- only (`FOR ROLE postgres`) — it changes what *this migration role*'s
-- future objects default to, not the database-wide built-in default,
-- and it does not affect `postgres`'s own EXECUTE right (the owner
-- always retains full rights on its own objects).
--
-- This remains a defense-in-depth layer, not the sole protection.
-- `private` additionally has no `USAGE` grant for `anon`/`authenticated`
-- at all (revoked below), which independently blocks real invocation of
-- anything in that schema regardless of function-level EXECUTE state —
-- confirmed by an actual `SET ROLE authenticated; SELECT
-- private.<fn>();` call, which fails with "permission denied for schema
-- private". And every sensitive function, in either schema, still gets
-- its own direct, per-function `REVOKE EXECUTE ON FUNCTION <exact
-- signature> FROM PUBLIC, anon, authenticated;` immediately after
-- `CREATE FUNCTION` — kept unconditionally, regardless of this
-- default-privileges configuration, since it is what makes the
-- intended posture verifiable per-function rather than inferred from
-- migration-ordering.

create schema if not exists private;

revoke all on schema private from public, anon, authenticated;

-- Global-scope (no IN SCHEMA) default privilege for role postgres:
-- every function this role creates from now on, in any schema, defaults
-- to no PUBLIC execute — the correct form, per the finding above.
alter default privileges for role postgres
  revoke execute on functions from public;
