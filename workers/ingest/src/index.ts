import { app } from "./app";
import { runScheduledPulls } from "./scheduled";
import type { Env } from "./types";

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },
  async scheduled(
    controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    await runScheduledPulls(controller, env);
  },
} satisfies ExportedHandler<Env>;
