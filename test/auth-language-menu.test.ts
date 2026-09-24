import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
const auth = read("src/components/auth-button.tsx");
const css = read("src/app/globals.css");
function declarations(selector: string, from = 0) {
  const start = css.indexOf(selector, from);
  const body = start < 0 ? "" : css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  return new Map(body.split(";").map(part => part.trim()).filter(Boolean).map(part => {
    const colon = part.indexOf(":");
    return [part.slice(0, colon).trim(), part.slice(colon + 1).trim()];
  }));
}

describe("account language submenu", () => {
  it("opens a secondary radio menu on click instead of showing inline tiles", () => {
    expect(auth).toContain("const [languageOpen, setLanguageOpen] = useState(false)");
    expect(auth).toContain('aria-expanded={languageOpen}');
    expect(auth).toContain('role="menuitemradio"');
    expect(auth).toContain('className="auth-language-menu"');
    expect(declarations(".auth-language-menu").get("position")).toBe("absolute");
    expect(declarations('.auth-menu-item[aria-expanded="true"] .auth-menu-tail').get("opacity")).toBe("1");
    expect(declarations(".site-header .auth-menu").get("width")).toBe("min(200px, calc(100vw - 24px))");
    const email = declarations(".site-header .auth-menu-id");
    expect(email.get("white-space")).toBe("nowrap");
    expect(email.get("font-size")).toBe("12px");
    expect(email.get("letter-spacing")).toBe("-.01em");
    expect(css).toMatch(/@media \(max-width: 600px\)[\s\S]*?\.auth-language-menu \{ top: calc\(100% \+ 4px\); right: 0; \}/);
    expect(css).toMatch(/@media \(hover: none\)\s*\{\s*\.auth-menu-tail\s*\{[^}]*opacity:\s*1/);
    expect(auth).toContain('className="auth-menu-id" title={user.email}');
    expect(auth).toContain('href="/me" onClick={closeMenu}');
    expect(auth).toContain('href="/notifications" onClick={closeMenu}');
    expect(css).not.toContain(".auth-language-options { display: grid");
  });
});
