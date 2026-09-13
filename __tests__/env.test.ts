import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  getEncryptionKeyHex,
  getMetaGraphApiVersion,
  isEmailAllowedToSignIn,
  requireEnv,
  getRedisUrl,
} from "../lib/env";

beforeEach(() => {
  vi.unstubAllEnvs();
});

describe("Redis configuration", () => {
  it.each([
    "redis://default:secret@proxy.rlwy.net:12345",
    "redis://default:secret@redis.railway.internal:6379",
    "rediss://default:secret@redis.example.com:6380/1",
    "redis://[::1]:6379",
  ])("accepts a resolved address: %s", (url) => {
    vi.stubEnv("REDIS_URL", url);
    expect(getRedisUrl()).toBe(url);
  });

  it.each([
    "redis://default:secret@$:6379",
    "redis://default:secret@${{RAILWAY_TCP_PROXY_DOMAIN}}:12345",
    "${{Redis.REDIS_PUBLIC_URL}}",
    "https://redis.example.com",
  ])("rejects invalid addresses without leaking credentials: %s", (url) => {
    vi.stubEnv("REDIS_URL", url);
    expect(getRedisUrl).toThrow("REDIS_URL must be a resolved");
    expect(getRedisUrl).not.toThrow("secret");
  });
});

describe("environment helpers", () => {
  it("requires missing variables", () => {
    expect(() => requireEnv("MISSING_TEST_ENV")).toThrow(
      "MISSING_TEST_ENV environment variable is required"
    );
  });

  it("validates the encryption key format", () => {
    vi.stubEnv("ENCRYPTION_KEY", "not-hex");
    expect(() => getEncryptionKeyHex()).toThrow(
      "ENCRYPTION_KEY must be a 32-byte hex string"
    );
  });

  it("defaults Meta Graph API version in one place", () => {
    expect(getMetaGraphApiVersion()).toBe("v25.0");
    vi.stubEnv("META_GRAPH_API_VERSION", "v26.0");
    expect(getMetaGraphApiVersion()).toBe("v26.0");
  });
});

describe("sign-in allowlist", () => {
  it("allows everyone when ALLOWED_EMAILS is unset", () => {
    expect(isEmailAllowedToSignIn("anyone@example.com")).toBe(true);
  });

  it("allows everyone when ALLOWED_EMAILS is empty or only separators", () => {
    vi.stubEnv("ALLOWED_EMAILS", "  , ,  ");
    expect(isEmailAllowedToSignIn("anyone@example.com")).toBe(true);
  });

  it("only allows listed addresses once ALLOWED_EMAILS is set", () => {
    vi.stubEnv("ALLOWED_EMAILS", "owner@example.com,team@example.com");
    expect(isEmailAllowedToSignIn("owner@example.com")).toBe(true);
    expect(isEmailAllowedToSignIn("team@example.com")).toBe(true);
    expect(isEmailAllowedToSignIn("stranger@example.com")).toBe(false);
  });

  it("ignores case and surrounding whitespace on both sides", () => {
    vi.stubEnv("ALLOWED_EMAILS", "  Owner@Example.com , team@example.com ");
    expect(isEmailAllowedToSignIn("OWNER@example.COM")).toBe(true);
  });

  it("rejects a missing address when the list is set", () => {
    vi.stubEnv("ALLOWED_EMAILS", "owner@example.com");
    expect(isEmailAllowedToSignIn(null)).toBe(false);
    expect(isEmailAllowedToSignIn(undefined)).toBe(false);
    expect(isEmailAllowedToSignIn("")).toBe(false);
  });
});
