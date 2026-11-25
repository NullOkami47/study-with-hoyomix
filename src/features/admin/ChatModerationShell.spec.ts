import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import AdminShell from "./AdminShell.vue";
import { createAdminRepository } from "./client";

afterEach(() => {
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("restricted chat moderator shell", () => {
  it("offers only moderation when the verified account cannot access general administration", async () => {
    window.history.replaceState(null, "", "/admin#admin-chat");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          viewer: { role: "moderator" },
          reports: [],
          bans: [],
          filters: [],
          intervalMs: 1500,
        }),
      ),
    );
    const repository = createAdminRepository();
    vi.spyOn(repository, "checkSession").mockResolvedValue({
      status: "unauthorised",
    });
    const overview = vi.spyOn(repository, "getOverview");
    const wrapper = mount(AdminShell, { props: { repository } });
    await flushPromises();
    expect(wrapper.find("[data-chat-moderation]").exists()).toBe(true);
    expect(wrapper.find("[data-admin-nav-providers]").exists()).toBe(false);
    expect(overview).not.toHaveBeenCalled();
    wrapper.unmount();
  });
  it("keeps a regular user behind the existing authorisation gate", async () => {
    window.history.replaceState(null, "", "/admin#admin-chat");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "forbidden" }, { status: 403 })),
    );
    const repository = createAdminRepository();
    vi.spyOn(repository, "checkSession").mockResolvedValue({
      status: "unauthorised",
    });
    const wrapper = mount(AdminShell, { props: { repository } });
    await flushPromises();
    expect(wrapper.find("[data-chat-moderation]").exists()).toBe(false);
    expect(wrapper.find("[data-admin-unauthorized]").exists()).toBe(true);
    wrapper.unmount();
  });
});
