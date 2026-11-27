import type { Meta, StoryObj } from "@storybook/react-vite";

import { App } from "@/App";

import type { StorybookScenario } from "./fetch-mock";

const meta = {
  title: "Dashboard",
  component: App,
  parameters: {
    layout: "fullscreen",
    bilanScenario: "populated",
  },
  render: () => <App />,
} satisfies Meta<typeof App>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Populated: Story = {};

/** The same dashboard with the mobile viewport preset applied. */
export const PopulatedMobile: Story = {
  name: "Populated (mobile)",
  globals: { viewport: { value: "mobile" } },
};

export const Loading: Story = {
  parameters: { bilanScenario: "loading" satisfies StorybookScenario },
};

export const Empty: Story = {
  parameters: { bilanScenario: "empty" satisfies StorybookScenario },
};

export const Failure: Story = {
  parameters: { bilanScenario: "failure" satisfies StorybookScenario },
};
