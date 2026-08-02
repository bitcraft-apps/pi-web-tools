import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { websearchTool } from "./src/websearch.js";
import { webfetchTool } from "./src/webfetch.js";

export default function (pi: ExtensionAPI) {
  pi.registerTool(websearchTool);
  pi.registerTool(webfetchTool);
}
