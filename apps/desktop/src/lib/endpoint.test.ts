import { describe, expect, it } from "vitest";
import { checkEndpoint } from "./endpoint";

const reply = (status: number, body: string) => async () => new Response(body, { status });

describe("checkEndpoint", () => {
  it("lists the models, sorted, and sends the key only as a bearer header to the address given", async () => {
    const seen: { url: string; auth?: string }[] = [];
    const r = await checkEndpoint(
      async (url, init) => {
        seen.push({ url, auth: (init.headers as Record<string, string>).authorization });
        return new Response(JSON.stringify({ data: [{ id: "swift-iq2_xs" }, { id: "alpha" }, { notAnId: 1 }] }), { status: 200 });
      },
      "http://127.0.0.1:47831/v1/",
      "sk-test",
    );
    expect(seen).toEqual([{ url: "http://127.0.0.1:47831/v1/models", auth: "Bearer sk-test" }]);
    expect(r).toMatchObject({ ok: true, status: 200, models: ["alpha", "swift-iq2_xs"] });
    expect(r.message).toContain("2 models");
  });

  it("explains a 401 with the server's own words and says to check the key", async () => {
    const r = await checkEndpoint(reply(401, '{"error":"Invalid API key"}'), "http://127.0.0.1:47831/v1", "");
    expect(r).toMatchObject({ ok: false, status: 401, models: [] });
    expect(r.message).toContain("Invalid API key");
    expect(r.message).toContain("Check the API key");
  });

  it("reads OpenAI-style error objects, and says a 404 may not be an OpenAI-compatible address", async () => {
    expect((await checkEndpoint(reply(429, '{"error":{"message":"slow down"}}'), "http://x/v1", "k")).message).toContain("slow down");
    expect((await checkEndpoint(reply(404, "not found"), "http://x", "k")).message).toContain("OpenAI-compatible");
  });

  it("reports an unreachable server, a reply that is not a model list, and OpenAI as the blank default", async () => {
    const down = await checkEndpoint(async () => Promise.reject(new Error("connection refused")), "http://127.0.0.1:1/v1", "");
    expect(down).toMatchObject({ ok: false, models: [] });
    expect(down.message).toContain("connection refused");
    expect((await checkEndpoint(reply(200, "<html>hi</html>"), "http://x/v1", "")).message).toContain("not with an OpenAI-style model list");
    let url = "";
    await checkEndpoint(async (u) => ((url = u), new Response('{"data":[]}', { status: 200 })), "  ", "");
    expect(url).toBe("https://api.openai.com/v1/models");
  });
});
