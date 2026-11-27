import type { QueryClient } from "@tanstack/react-query";
import { HeadContent, Outlet, Scripts, createRootRouteWithContext } from "@tanstack/react-router";

import appCss from "../client/index.css?url";
import type { DashboardDataSource } from "../query/dashboard";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
  dataSource: DashboardDataSource;
}>()({
  head: () => ({
    meta: [
      { charSet: "utf8" },
      { name: "viewport", content: "width=device-width, initial-scale=1.0" },
      { name: "theme-color", content: "#fafafa" },
      {
        name: "description",
        content: "Read-only balances, quotas, and token usage dashboard.",
      },
      { title: "bilan" },
    ],
    links: [
      // oxlint-disable-next-line typescript/no-unsafe-assignment -- Vite CSS URL
      { rel: "stylesheet", href: appCss },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
}
