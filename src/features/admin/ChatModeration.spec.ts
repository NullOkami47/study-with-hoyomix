import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatModeration from "./ChatModeration.vue";
import { usePreferences } from "../../stores/preferences";

const snapshot = (role = "admin") => ({
  viewer: { role },
  reports: [
    {
      id: "r1",
      messageId: "m1",
      reason: "Spam",
      content: "<script>bad</script>",
      userId: "u2",
      displayName: "Other student",
      createdAt: new Date().toISOString(),
    },
  ],
  bans: [],
  filters: [],
  intervalMs: 1500,
});
beforeEach(() => usePreferences().setLocale("en"));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ChatModeration", () => {
  const retentionUrl = "/api/chat/moderation/retention-policy";
  const retentionForm = "[data-chat-retention]";
  const retentionInput = "[data-chat-retention-days]";
  const retentionSaved = "[data-chat-retention-saved]";
  const retentionAck = "[data-chat-retention-acknowledge]";
  const retentionSubmit = "[data-chat-retention-save]";

  function retentionNetwork(options: {
    role?: string;
    days?: number;
    get?: () => Promise<Response>;
    patch?: (init: RequestInit) => Promise<Response>;
  } = {}) {
    const requests: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      requests.push({ url, init });
      if (url === retentionUrl) {
        if (init.method === "PATCH") return options.patch!(init);
        if (options.get) return options.get();
        return Response.json({ retentionDays: options.days ?? 30, revision: 2, hiddenBefore: 0 });
      }
      return Response.json(snapshot(options.role ?? "owner"));
    });
    return requests;
  }

  it("loads the authoritative Owner retention policy without changing the sending interval or writing on load", async () => {
    usePreferences().setLocale("en");
    const requests = retentionNetwork();
    const wrapper = mount(ChatModeration);
    await flushPromises();
    expect(wrapper.find(retentionForm).exists()).toBe(true);
    expect((wrapper.get(retentionInput).element as HTMLInputElement).value).toBe("30");
    expect(wrapper.get(retentionSaved).text()).toContain("30");
    expect(wrapper.get("[data-chat-moderation-settings] input").element).toHaveProperty("value", "1500");
    expect(requests.map(({ url, init }) => [url, init.method ?? "GET"])).toEqual([
      ["/api/chat/moderation", "GET"], [retentionUrl, "GET"],
    ]);
    expect(requests[1].init.credentials).toBe("same-origin");
    expect(wrapper.get(retentionForm).text()).toContain("cannot recover expired messages");
    wrapper.unmount();
  });

  it.each(["moderator", "admin"])("never requests or renders Owner retention controls for %s", async (role) => {
    const requests = retentionNetwork({ role });
    const wrapper = mount(ChatModeration);
    await flushPromises();
    expect(wrapper.find(retentionForm).exists()).toBe(false);
    expect(requests.some(({ url }) => url === retentionUrl)).toBe(false);
    wrapper.unmount();
  });

  it("requires acknowledgement for a shorter period and changes the saved value only after server confirmation", async () => {
    let settle!: (response: Response) => void;
    const requests = retentionNetwork({ patch: () => new Promise((resolve) => { settle = resolve; }) });
    const wrapper = mount(ChatModeration);
    await flushPromises();
    await wrapper.get(retentionInput).setValue(7);
    expect(wrapper.get(retentionSaved).text()).toContain("30");
    expect(wrapper.get(retentionSubmit).attributes("disabled")).toBeDefined();
    await wrapper.get(retentionForm).trigger("submit");
    expect(requests.filter(({ init }) => init.method === "PATCH")).toHaveLength(0);
    expect(wrapper.get(retentionAck).element).toHaveProperty("checked", false);
    expect(wrapper.get(retentionForm).text()).toContain("bounded batches");
    await wrapper.get(retentionAck).setValue(true);
    await wrapper.get(retentionForm).trigger("submit");
    await wrapper.get(retentionForm).trigger("submit");
    const patches = requests.filter(({ init }) => init.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0].init.credentials).toBe("same-origin");
    expect(patches[0].init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(patches[0].init.body))).toEqual({ retentionDays: 7, expectedRevision: 2 });
    expect(wrapper.get(retentionSaved).text()).toContain("30");
    expect(wrapper.get(retentionSubmit).attributes("disabled")).toBeDefined();
    settle(Response.json({ retentionDays: 7, revision: 3 }));
    await flushPromises();
    expect(wrapper.get(retentionSaved).text()).toContain("7");
    expect(wrapper.get(`${retentionForm} [role="status"]`).text()).toContain("confirmed");
    wrapper.unmount();
  });

  it.each([0, 31, 1.5, ""])("rejects invalid retention value %s even when submitted programmatically", async (days) => {
    const requests = retentionNetwork();
    const wrapper = mount(ChatModeration);
    await flushPromises();
    await wrapper.get(retentionInput).setValue(days);
    if (wrapper.find(retentionAck).exists()) await wrapper.get(retentionAck).setValue(true);
    await wrapper.get(retentionForm).trigger("submit");
    expect(wrapper.get(retentionSubmit).attributes("disabled")).toBeDefined();
    expect(requests.filter(({ init }) => init.method === "PATCH")).toHaveLength(0);
    wrapper.unmount();
  });

  it("locks moderation actions while a retention save is pending and refreshes after the next permitted action", async () => {
    let settle!: (response: Response) => void;
    const requests = retentionNetwork({
      patch: () => new Promise((resolve) => { settle = resolve; }),
    });
    const wrapper = mount(ChatModeration);
    await flushPromises();
    await wrapper.get("[data-chat-moderation-reason]").setValue("Review");
    await wrapper.get(retentionInput).setValue(7);
    await wrapper.get(retentionAck).setValue(true);
    await wrapper.get(retentionForm).trigger("submit");
    await wrapper.get("[data-chat-moderation-settings]").trigger("submit");
    await wrapper.get("[data-chat-moderation-delete]").trigger("click");
    await wrapper.get("[data-chat-moderation-versions]").trigger("click");
    await flushPromises();
    expect(requests.filter(({ init }) => init.method === "POST")).toHaveLength(0);
    expect(requests.some(({ url }) => url.includes("/messages/"))).toBe(false);
    expect(wrapper.get("[data-chat-moderation]").attributes("aria-busy")).toBe("true");
    for (const control of wrapper.findAll("button, input, select")) {
      expect(control.attributes("disabled"), control.html()).toBeDefined();
    }
    settle(Response.json({ retentionDays: 7, revision: 3 }));
    await flushPromises();
    expect(wrapper.get("[data-chat-moderation]").attributes("aria-busy")).toBe("false");
    expect(wrapper.get("[data-chat-moderation-reason]").element).toHaveProperty("value", "Review");
    await wrapper.get("[data-chat-moderation-settings]").trigger("submit");
    await flushPromises();
    expect(requests.filter(({ init }) => init.method === "POST")).toHaveLength(1);
    expect(requests.filter(({ url, init }) => url === "/api/chat/moderation" && !init.method)).toHaveLength(2);
    expect(wrapper.get(retentionSaved).text()).toContain("7");
    wrapper.unmount();
  });

  it("allows extending the period without shortening acknowledgement and sends the loaded revision", async () => {
    const requests = retentionNetwork({ days: 7, patch: async () => Response.json({ retentionDays: 30, revision: 3 }) });
    const wrapper = mount(ChatModeration);
    await flushPromises();
    await wrapper.get(retentionInput).setValue(30);
    expect(wrapper.find(retentionAck).exists()).toBe(false);
    await wrapper.get(retentionForm).trigger("submit");
    await flushPromises();
    expect(JSON.parse(String(requests.find(({ init }) => init.method === "PATCH")!.init.body))).toEqual({ retentionDays: 30, expectedRevision: 2 });
    expect(wrapper.get(retentionSaved).text()).toContain("30");
    wrapper.unmount();
  });

  it.each([409, 503, 200])("keeps the saved policy on an unconfirmed save (%s) and never retries automatically", async (status) => {
    const requests = retentionNetwork({ patch: async () => Response.json({ error: "unconfirmed" }, { status }) });
    const wrapper = mount(ChatModeration);
    await flushPromises();
    await wrapper.get(retentionInput).setValue(7);
    await wrapper.get(retentionAck).setValue(true);
    await wrapper.get(retentionForm).trigger("submit");
    await flushPromises();
    expect(wrapper.get(`${retentionForm} [role="alert"]`).text()).toContain(status === 409 ? "Refresh" : "not been confirmed");
    expect(wrapper.find(`${retentionForm} [role="status"]`).exists()).toBe(false);
    expect(wrapper.get(retentionSaved).text()).toContain("30");
    expect(wrapper.get(retentionInput).element).toHaveProperty("value", "7");
    expect(requests.filter(({ init }) => init.method === "PATCH")).toHaveLength(1);
    if (status === 409) {
      await wrapper.get(retentionForm).trigger("submit");
      expect(requests.filter(({ init }) => init.method === "PATCH")).toHaveLength(1);
      await wrapper.get("header button").trigger("click");
      await flushPromises();
      expect(wrapper.get(retentionInput).element).toHaveProperty("value", "30");
    }
    wrapper.unmount();
  });

  it("does not invent a saved policy when loading it fails", async () => {
    retentionNetwork({ get: async () => Response.json({ error: "unavailable" }, { status: 503 }) });
    const wrapper = mount(ChatModeration);
    await flushPromises();
    expect(wrapper.find(retentionSaved).exists()).toBe(false);
    expect(wrapper.find(`${retentionForm} [role="alert"]`).exists()).toBe(true);
    expect(wrapper.get(retentionSubmit).attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });

  it("renders reports as text and submits an acknowledged moderation action", async () => {
    usePreferences().setLocale("en");
    const actions: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        if (init?.method === "POST") actions.push(JSON.parse(init.body));
        return Response.json(snapshot());
      }),
    );
    const wrapper = mount(ChatModeration);
    await flushPromises();
    expect(wrapper.text()).toContain("<script>bad</script>");
    expect(wrapper.find("script").exists()).toBe(false);
    await wrapper
      .get("[data-chat-moderation-reason]")
      .setValue("Repeated spam");
    await wrapper.get("[data-chat-moderation-delete]").trigger("click");
    await flushPromises();
    expect(actions).toEqual([
      { action: "delete", messageId: "m1", reason: "Repeated spam" },
    ]);
    wrapper.unmount();
  });

  it("denies unavailable accounts without rendering privileged controls", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "forbidden" }, { status: 403 })),
    );
    const wrapper = mount(ChatModeration);
    await flushPromises();
    expect(wrapper.find("[data-chat-moderation-delete]").exists()).toBe(false);
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("restricts moderator interface to reports and bans", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(snapshot("moderator"))),
    );
    const wrapper = mount(ChatModeration);
    await flushPromises();
    expect(wrapper.find("[data-chat-moderation-settings]").exists()).toBe(
      false,
    );
    expect(wrapper.find("[data-chat-moderation-filters]").exists()).toBe(false);
    expect(wrapper.find("[data-chat-moderation-delete]").exists()).toBe(true);
    wrapper.unmount();
  });

  it("loads protected message versions only after an explicit review action", async () => {
    usePreferences().setLocale("en");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) =>
        String(url).includes("/messages/")
          ? Response.json({
              message: { content: "Current original" },
              versions: [
                {
                  content: "Earlier original",
                  createdAt: new Date().toISOString(),
                },
              ],
            })
          : Response.json(snapshot()),
      ),
    );
    const wrapper = mount(ChatModeration);
    await flushPromises();
    expect(wrapper.text()).not.toContain("Earlier original");
    await wrapper.get("[data-chat-moderation-versions]").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("Current original");
    expect(wrapper.text()).toContain("Earlier original");
    wrapper.unmount();
  });

  it("keeps failed mutations visible and prevents duplicate concurrent submissions", async () => {
    let settle: ((r: Response) => void) | undefined;
    let posts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        if (init?.method === "POST") {
          posts++;
          return new Promise<Response>((resolve) => {
            settle = resolve;
          });
        }
        return Response.json(snapshot());
      }),
    );
    const wrapper = mount(ChatModeration);
    await flushPromises();
    await wrapper.get("[data-chat-moderation-reason]").setValue("Review");
    await wrapper.get("[data-chat-moderation-delete]").trigger("click");
    await wrapper.get("[data-chat-moderation-delete]").trigger("click");
    expect(posts).toBe(1);
    settle!(Response.json({ error: "failed" }, { status: 503 }));
    await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    expect(wrapper.text()).toContain("Spam");
    wrapper.unmount();
  });
});
