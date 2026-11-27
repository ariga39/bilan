import { install } from "@sinonjs/fake-timers";
import type { Preview } from "@storybook/react-vite";

import "../src/client/index.css";
import { installScenarioFetch, resolveStorybookScenario } from "../src/client/stories/fetch-mock";

// The dashboard derives its default month and renders relative sample ages, so
// pin Date for every story. Timers stay real for Storybook and play functions.
install({ now: Date.UTC(2026, 10, 27, 12, 0, 0), toFake: ["Date"] });

const preview: Preview = {
  parameters: {
    layout: "fullscreen",
    viewport: {
      options: {
        desktop: {
          name: "Desktop (1440 × 900)",
          styles: { width: "1440px", height: "900px" },
          type: "desktop",
        },
        mobile: {
          name: "Mobile (390 × 844)",
          styles: { width: "390px", height: "844px" },
          type: "mobile",
        },
      },
    },
  },
  initialGlobals: {
    viewport: { value: "desktop" },
  },
  decorators: [
    (Story, context) => {
      const scenarioValue: unknown = context.parameters.bilanScenario;
      installScenarioFetch(resolveStorybookScenario(scenarioValue));
      return <Story />;
    },
  ],
};

export default preview;
