import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
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
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ChatModeration", () => {
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
