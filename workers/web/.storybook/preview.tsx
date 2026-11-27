import { install } from "@sinonjs/fake-timers";
import type { Preview } from "@storybook/react-vite";

import "../src/client/index.css";

// The dashboard renders relative sample ages; pin Date for every story.
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
};

export default preview;
