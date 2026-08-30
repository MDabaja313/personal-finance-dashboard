import { describe, expect, it } from "vitest";
import { securityHeaders } from "@/lib/security/headers";

function value(key: string): string | undefined {
  return securityHeaders.find((h) => h.key === key)?.value;
}

describe("securityHeaders", () => {
  it("sets X-Content-Type-Options to nosniff", () => {
    expect(value("X-Content-Type-Options")).toBe("nosniff");
  });

  it("denies framing outright", () => {
    expect(value("X-Frame-Options")).toBe("DENY");
  });

  it("limits the referrer sent cross-origin", () => {
    expect(value("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  it("locks down camera, microphone, geolocation and payment", () => {
    const policy = value("Permissions-Policy");
    expect(policy).toContain("camera=()");
    expect(policy).toContain("microphone=()");
    expect(policy).toContain("geolocation=()");
    expect(policy).toContain("payment=()");
  });

  it("sets no Content-Security-Policy and no Strict-Transport-Security — both deliberately left to Vercel/documented as absent", () => {
    expect(value("Content-Security-Policy")).toBeUndefined();
    expect(value("Strict-Transport-Security")).toBeUndefined();
  });

  it("carries no duplicate header keys", () => {
    const keys = securityHeaders.map((h) => h.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
