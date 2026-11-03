import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { translatorFor } from "@/lib/i18n";
import { agentPrompt } from "@/lib/agent-prompt";
import NavigationStatus from "@/components/navigation-status";

const link = vi.hoisted(() => ({ pending: false }));
vi.mock("next/link", () => ({ useLinkStatus: () => link }));

describe("agent entry", () => {
  it("preserves deployment subpaths in both localized prompts", () => {
    const base = "https://example.test/artifact-site/";
    const en = agentPrompt(base, translatorFor("en"));
    const zh = agentPrompt(base, translatorFor("zh-CN"));
    for (const prompt of [en, zh]) {
      expect(prompt.match(/https:\/\/\S+/)?.[0]).toBe("https://example.test/artifact-site/for-agents.md");
      expect(prompt).not.toContain("{url}");
    }
    expect(en).not.toBe(zh);
  });

  it("reserves a navigation indicator and announces only active pending navigation", () => {
    const render = () => renderToStaticMarkup(createElement(NavigationStatus));
    link.pending = false;
    expect(render()).toContain('class="nav-pending"');
    expect(render()).toContain('aria-hidden="true"');
    expect(render()).not.toContain('role="status"');
    link.pending = true;
    expect(render()).toContain('class="nav-pending is-pending"');
    expect(render()).toContain('role="status"');
    expect(render()).toContain('aria-label="Loading…"');
    expect(render()).not.toContain('aria-hidden');
  });
});
