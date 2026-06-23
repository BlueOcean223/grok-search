import { applyChatModelProviderDefaults } from "./config.js";
import { authHeaders, requestJson } from "./providers.js";
import { searchPrompt } from "./prompts.js";

function pad(value) {
  return String(value).padStart(2, "0");
}

export function getLocalTimeContext(date = new Date()) {
  const weekdaysCn = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Local";
  return [
    "[Current Time Context]",
    `- Date: ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} (${weekdaysCn[date.getDay()]})`,
    `- Time: ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
    `- Timezone: ${timezone}`,
    "",
  ].join("\n");
}

export function platformPrompt(platform) {
  return platform
    ? `\n\nYou should search the web for the information you need, and focus on these platform: ${platform}\n`
    : "";
}

function extractMessageContent(data) {
  const choice = Array.isArray(data?.choices) ? data.choices[0] : null;
  return choice?.message?.content || choice?.text || "";
}

export async function searchGrok(query, options, config) {
  const model = applyChatModelProviderDefaults(options.model || config.grokModel, config);
  const endpoint = `${config.grokApiUrl.replace(/\/+$/, "")}/chat/completions`;
  const data = await requestJson(endpoint, {
    headers: authHeaders(config.grokApiKey),
    body: {
      model,
      messages: [
        { role: "system", content: searchPrompt },
        { role: "user", content: getLocalTimeContext() + query + platformPrompt(options.platform) },
      ],
      stream: false,
    },
    timeoutMs: 120_000,
    config,
    retry: true,
  });

  const content = extractMessageContent(data);
  if (!content.trim()) throw new Error("Grok 返回空内容");

  return {
    model,
    content,
    endpoint: "chat/completions",
    raw: data,
  };
}
