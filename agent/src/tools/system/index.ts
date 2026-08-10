import { ToolRegistry } from "../registry.js";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createFindTool } from "./find.js";
import { createGrepTool } from "./grep.js";
import { createLsTool } from "./ls.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";

export function createSystemToolRegistry(options: {
  cwd: string;
  outputDirectory: string;
  activeToolNames?: readonly string[];
}) {
  return new ToolRegistry([
    createReadTool(options.cwd),
    createLsTool(options.cwd),
    createGrepTool(options.cwd),
    createFindTool(options.cwd),
    createWriteTool(options.cwd),
    createEditTool(options.cwd),
    createBashTool(options.cwd, options.outputDirectory),
  ], options.activeToolNames);
}
