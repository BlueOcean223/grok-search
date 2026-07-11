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
