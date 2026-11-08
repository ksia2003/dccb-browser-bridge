/**
 * Tool: close — the AI is done with a work space (`pc-browser close`, 6.0.0).
 *
 * args:
 *   workspace  the work space (default "default")
 *
 * Its tabs close now; one the person has in front of them stays and becomes theirs.
 * Returns { closed: [tab ids] }.
 */
import { register, type ToolArgs } from "../registry";
import { closeWorkspaceTabs } from "../pipe";

register("close", async (args: ToolArgs) => ({ closed: await closeWorkspaceTabs(args.workspace) }));
