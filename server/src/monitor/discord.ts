const DISCORD_API = 'https://discord.com/api/v10';
const MESSAGE_LIMIT = 2_000;

type Fetcher = typeof fetch;

export class DiscordBot {
  readonly configured: boolean;
  readonly configurationError: string | null;

  constructor(
    private readonly token: string,
    private readonly channelId: string,
    private readonly fetcher: Fetcher = fetch,
  ) {
    this.configured = token !== '' && /^\d{17,20}$/.test(channelId);
    this.configurationError = token === '' && channelId === ''
      ? null
      : this.configured ? null : 'Set a bot token and a numeric channel ID';
  }

  async send(content: string): Promise<void> {
    if (!this.configured) throw new Error('discord_not_configured');
    const response = await this.fetcher(`${DISCORD_API}/channels/${this.channelId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: content.slice(0, MESSAGE_LIMIT),
        allowed_mentions: { parse: [] },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`discord_http_${response.status}`);
  }
}
