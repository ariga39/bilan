import type { BalanceSnapshotInput } from "@bilan/shared";
import { z } from "zod";

import type { Env } from "../types";

export class PullError extends Error {
  override readonly name = "PullError";
}

export interface PullAdapter {
  readonly producerId: string;
  readonly provider: BalanceSnapshotInput["provider"];
  readonly providerLabel: string;
  readonly displayName: string;
  readonly expectedIntervalSeconds: number;
  isEnabled(env: Env): boolean;
  pull(env: Env, sampledAt: string, fetchImpl?: typeof fetch): Promise<Array<BalanceSnapshotInput>>;
}

const decimal = z
  .union([z.number(), z.string().trim().min(1)])
  .transform(Number)
  .pipe(z.number().finite());

const optionalDecimal = decimal
  .nullable()
  .optional()
  .transform((value) => value ?? null);

const openRouterCreditsSchema = z.object({
  data: z.object({
    total_credits: z.number().finite(),
    total_usage: z.number().finite(),
  }),
});

const deepSeekBalanceSchema = z.object({
  is_available: z.boolean().optional(),
  balance_infos: z
    .array(
      z.object({
        currency: z.string().regex(/^[A-Za-z]{3}$/u),
        total_balance: decimal,
        topped_up_balance: optionalDecimal,
        granted_balance: optionalDecimal,
      }),
    )
    .min(1),
});

function wasTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

async function requestJson<T>(
  url: string,
  apiKey: string,
  providerLabel: string,
  schema: z.ZodType<T>,
  invalidMessage: string,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  let response: Response;

  try {
    response = await fetchImpl(url, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      // Workerd rejects redirect "error". "manual" keeps the Authorization
      // header from being forwarded; the response.ok guard below rejects 3xx.
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    if (wasTimeout(error)) {
      throw new PullError(`${providerLabel} request timed out`);
    }
    throw new PullError(`${providerLabel} request failed`);
  }

  if (!response.ok) {
    throw new PullError(`${providerLabel} request failed (HTTP ${response.status})`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new PullError(`${providerLabel} response was not valid JSON`);
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new PullError(invalidMessage);
  }
  return parsed.data;
}

const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";
const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";

export const openRouterAdapter: PullAdapter = {
  producerId: "pull-openrouter",
  provider: "openrouter",
  providerLabel: "OpenRouter",
  displayName: "OpenRouter balance",
  expectedIntervalSeconds: 1800,
  isEnabled: (env) => (env.OPENROUTER_API_KEY ?? "") !== "",
  async pull(env, sampledAt, fetchImpl = fetch) {
    const apiKey = env.OPENROUTER_API_KEY ?? "";
    const credits = await requestJson(
      OPENROUTER_CREDITS_URL,
      apiKey,
      "OpenRouter",
      openRouterCreditsSchema,
      "OpenRouter response missing credit fields",
      fetchImpl,
    );

    return [
      {
        provider: "openrouter",
        account: "default",
        currency: "USD",
        sampled_at: sampledAt,
        total_balance: credits.data.total_credits - credits.data.total_usage,
        topped_up_balance: null,
        granted_balance: null,
        cumulative_usage: credits.data.total_usage,
        credit_limit: credits.data.total_credits,
        is_available: null,
      },
    ];
  },
};

export const deepSeekAdapter: PullAdapter = {
  producerId: "pull-deepseek",
  provider: "deepseek",
  providerLabel: "DeepSeek",
  displayName: "DeepSeek balance",
  expectedIntervalSeconds: 1800,
  isEnabled: (env) => (env.DEEPSEEK_API_KEY ?? "") !== "",
  async pull(env, sampledAt, fetchImpl = fetch) {
    const apiKey = env.DEEPSEEK_API_KEY ?? "";
    const balance = await requestJson(
      DEEPSEEK_BALANCE_URL,
      apiKey,
      "DeepSeek",
      deepSeekBalanceSchema,
      "DeepSeek response contained an invalid balance",
      fetchImpl,
    );
    const isAvailable = balance.is_available ?? null;

    return balance.balance_infos.map((info) => ({
      provider: "deepseek",
      account: "default",
      currency: info.currency.toUpperCase(),
      sampled_at: sampledAt,
      total_balance: info.total_balance,
      topped_up_balance: info.topped_up_balance,
      granted_balance: info.granted_balance,
      cumulative_usage: null,
      credit_limit: null,
      is_available: isAvailable,
    }));
  },
};

export const pullAdapters: ReadonlyArray<PullAdapter> = [openRouterAdapter, deepSeekAdapter];
