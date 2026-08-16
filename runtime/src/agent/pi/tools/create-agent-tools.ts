import type { AgentTool, ExecutionEnv } from "@earendil-works/pi-agent-core";

import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createFindTool } from "./find.js";
import { createGrepTool } from "./grep.js";
import { createLsTool } from "./ls.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";

export function createAgentTools(env: ExecutionEnv): AgentTool[] {
  return [
    createReadTool(env),
    createLsTool(env),
    createGrepTool(env),
    createFindTool(env),
    createWriteTool(env),
    createEditTool(env),
    createBashTool(env),
  ] as unknown as AgentTool[];
}
