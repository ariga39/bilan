import handler from "@tanstack/react-start/server-entry";

import { app } from "./worker/app";
import type { Env } from "./worker/types";

export default {
  fetch(request: Request, env: Env): Response | Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/api/")) {
      return app.fetch(request, env);
    }
    return handler.fetch(request);
  },
};
