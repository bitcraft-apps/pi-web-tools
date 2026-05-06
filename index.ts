import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { websearchTool } from "./src/websearch.js";
import { webfetchTool } from "./src/webfetch.js";

export default function (pi: ExtensionAPI) {
  pi.registerTool(websearchTool);
  pi.registerTool(webfetchTool);
}
