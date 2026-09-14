// Every locale dictionary, registered on import. Feature areas own their own file under
// src/locales/zh-CN/ (one per area, so parallel work never conflicts); this index just pulls them in.
// Importing this module anywhere is enough — i18n-server.ts and locale-provider.tsx both do.
import { registerMessages } from "@/lib/i18n";
import { zhCN } from "./zh-CN";

registerMessages("zh-CN", zhCN);
