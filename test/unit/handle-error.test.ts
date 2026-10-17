import { afterEach, describe, expect, it, vi } from "vitest";
import { handleError } from "../../app/entry.server";

const args = (path = "/app/tickets") => ({
  request: new Request(`https://shopcare.test${path}`),
  params: {},
  context: {},
}) as unknown as Parameters<typeof handleError>[1];

describe("handleError", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports an unexpected loader/action error", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    handleError(new Error("boom"), args());
    expect(error).toHaveBeenCalledWith("[error] area=route method=GET path=/app/tickets", expect.any(Error));
  });

  it("ignores route error responses, such as a 404 for an unknown URL", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const notFound = { status: 404, statusText: "Not Found", internal: true, data: "No route matches URL" };
    handleError(notFound, args("/json/version"));
    expect(error).not.toHaveBeenCalled();
  });
});
