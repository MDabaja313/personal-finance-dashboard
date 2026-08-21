import { describe, expect, it } from "vitest";
import {
  AppError,
  dataIntegrity,
  forbidden,
  isAppError,
  notFound,
  unauthorized,
  unavailable,
} from "@/lib/errors";

describe("AppError", () => {
  it("preserves the code and message", () => {
    const error = new AppError("not_found", "Resource not found.");
    expect(error.code).toBe("not_found");
    expect(error.message).toBe("Resource not found.");
  });

  it("is an instanceof Error", () => {
    const error = new AppError("unavailable", "Service unavailable.");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AppError);
  });

  it("retains the original error as cause", () => {
    const original = new Error("raw driver error");
    const error = new AppError("data_integrity", "Data integrity check failed.", { cause: original });
    expect(error.cause).toBe(original);
  });

  it("has no cause when none is passed", () => {
    const error = new AppError("forbidden", "Not permitted.");
    expect(error.cause).toBeUndefined();
  });
});

describe("isAppError", () => {
  it("returns true for an AppError instance", () => {
    expect(isAppError(new AppError("unauthorized", "Not authenticated."))).toBe(true);
  });

  it("returns false for a plain Error", () => {
    expect(isAppError(new Error("plain"))).toBe(false);
  });

  it("returns false for non-error values", () => {
    expect(isAppError("a string")).toBe(false);
    expect(isAppError(null)).toBe(false);
    expect(isAppError(undefined)).toBe(false);
    expect(isAppError({ code: "not_found" })).toBe(false);
  });
});

describe("factories", () => {
  it("unauthorized() produces the unauthorized code with a default message", () => {
    const error = unauthorized();
    expect(error.code).toBe("unauthorized");
    expect(error.message.length).toBeGreaterThan(0);
  });

  it("forbidden() produces the forbidden code", () => {
    expect(forbidden().code).toBe("forbidden");
  });

  it("notFound() produces the not_found code", () => {
    expect(notFound().code).toBe("not_found");
  });

  it("dataIntegrity() produces the data_integrity code", () => {
    expect(dataIntegrity().code).toBe("data_integrity");
  });

  it("unavailable() produces the unavailable code", () => {
    expect(unavailable().code).toBe("unavailable");
  });

  it("factories accept a custom message and cause", () => {
    const original = new Error("connection reset");
    const error = unavailable("Custom message.", { cause: original });
    expect(error.message).toBe("Custom message.");
    expect(error.cause).toBe(original);
  });
});
