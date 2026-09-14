// Simplified Chinese. Keys are the English source strings exactly as written in code.
// One file per feature area — add a new area file here rather than growing a single dictionary.
import type { Messages } from "@/lib/i18n";
import { common } from "./common";
import { components } from "./components";
import { editor } from "./editor";
import { pages } from "./pages";
import { agentGuide } from "./agent-guide";
import { admin } from "./admin";

export const zhCN: Messages = {
  ...common,
  ...components,
  ...editor,
  ...pages,
  ...admin,
  ...agentGuide,
};
