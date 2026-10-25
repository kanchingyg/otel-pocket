export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

export function assertLoopbackLlmBaseUrl(baseUrl: string): void {
  if (process.env.OTEL_POCKET_ALLOW_REMOTE_LLM === "1") return;
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new Error(`Invalid LLM baseUrl: ${baseUrl}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`LLM baseUrl must be http(s): ${baseUrl}`);
  }
  if (!isLoopbackHost(u.hostname)) {
    throw new Error(
      `Non-loopback LLM baseUrl blocked (${u.hostname}). Set OTEL_POCKET_ALLOW_REMOTE_LLM=1 to allow.`,
    );
  }
}
