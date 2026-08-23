import { sessionMigrations } from "./index.ts";
export const apiVersion = sessionMigrations.apiVersion;
export const name = sessionMigrations.name;
export const version = sessionMigrations.version;
export const apply = sessionMigrations.apply;
