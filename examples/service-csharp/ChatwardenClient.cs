// A small client of the Chatwarden service API (/v1) over HttpClient and System.Text.Json, for a game server written in C#.
// It seats and unseats players, checks lines, reports, reads notices, asks what a player may do, and mutes. It sends the service key as the bearer, an
// Idempotency-Key on the calls whose retry would be judged twice (a line and a report), waits for Retry-After on a 429, retries a network error or a 5xx
// a few times with a growing wait, and never retries any other 4xx. A refusal is an answer: Reply.Status is 200 and the body says ok:false. A refusal
// reason this client does not know is "unknown" (the API only ever adds reasons). Never log the key.
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace Chatwarden.Sample;

/// <summary>One answer: the HTTP status, the JSON text as the service sent it, and whether it is a replay of an earlier call with the same Idempotency-Key.</summary>
public sealed record Reply(int Status, string Body, bool Replay, HttpResponseHeaders? Headers = null)
{
    public bool Ok => Status == 200;
    public JsonDocument Json() => JsonDocument.Parse(string.IsNullOrEmpty(Body) ? "{}" : Body);
}

public sealed class ChatwardenClient : IDisposable
{
    /// <summary>The refusal reasons this client knows. Anything else is reported as "unknown".</summary>
    public static readonly string[] KnownReasons =
    {
        "empty", "length", "rate", "gate", "restricted", "blocked", "profanity", "banned", "slow_mode", "flood", "duplicate", "probation", "link",
        "personal_info", "filter", "locked", "new_account", "account_too_new", "phrases_only", "phrase_unknown", "unknown",
    };

    private readonly HttpClient http;
    private readonly string key;
    private readonly int retries;

    public ChatwardenClient(string baseUrl, string key, int retries = 3, HttpClient? http = null)
    {
        if (string.IsNullOrWhiteSpace(baseUrl)) throw new ArgumentException("baseUrl is required", nameof(baseUrl));
        if (string.IsNullOrWhiteSpace(key)) throw new ArgumentException("a service key is required", nameof(key));
        this.http = http ?? new HttpClient();
        this.http.BaseAddress = new Uri(baseUrl.TrimEnd('/') + "/");
        this.key = key;
        this.retries = retries;
    }

    public void Dispose() => http.Dispose();

    private static string E(string id) => Uri.EscapeDataString(id);

    /// <summary>A JSON body of the fields that have a value (the service refuses a field that is null).</summary>
    private static Dictionary<string, object?> Body(params (string Name, object? Value)[] fields) =>
        fields.Where(f => f.Value is not null).ToDictionary(f => f.Name, f => f.Value);

    /// <summary>The refusal reason of an answer, as this client knows it: a reason it does not know is "unknown".</summary>
    public static string ReasonOf(JsonElement refused)
    {
        var reason = refused.ValueKind == JsonValueKind.Object && refused.TryGetProperty("reason", out var r) ? r.GetString() : null;
        return reason is not null && Array.IndexOf(KnownReasons, reason) >= 0 ? reason : "unknown";
    }

    private async Task<Reply> Send(HttpMethod method, string path, object? body = null, bool idempotent = false)
    {
        var payload = body is null ? null : JsonSerializer.Serialize(body);
        var idempotencyKey = idempotent ? Guid.NewGuid().ToString("N") : null;
        var wait = TimeSpan.FromMilliseconds(100);
        var waitedForRateLimit = false;
        for (var attempt = 0; ; attempt++)
        {
            try
            {
                using var request = new HttpRequestMessage(method, path.TrimStart('/'));
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
                if (idempotencyKey is not null) request.Headers.Add("Idempotency-Key", idempotencyKey);
                if (payload is not null) request.Content = new StringContent(payload, Encoding.UTF8, "application/json");
                using var response = await http.SendAsync(request);
                var text = await response.Content.ReadAsStringAsync();
                var status = (int)response.StatusCode;
                if (response.StatusCode == HttpStatusCode.TooManyRequests && !waitedForRateLimit)
                {
                    // The service says how long to wait: do, once, then try again.
                    waitedForRateLimit = true;
                    var seconds = response.Headers.RetryAfter?.Delta?.TotalSeconds ?? 1;
                    await Task.Delay(TimeSpan.FromSeconds(Math.Clamp(seconds, 1, 30)));
                    continue;
                }
                if (status >= 500 && attempt < retries)
                {
                    await Task.Delay(wait);
                    wait *= 2;
                    continue;
                }
                return new Reply(status, text, response.Headers.Contains("idempotent-replay"), response.Headers);
            }
            catch (HttpRequestException) when (attempt < retries)
            {
                await Task.Delay(wait);
                wait *= 2;
            }
        }
    }

    public Task<Reply> Handshake() => Send(HttpMethod.Get, "/v1");

    /// <summary>Seat a player (who: clientKey and/or accountId, optionally ip). The answer carries the restriction they are under, or null.</summary>
    public Task<Reply> Seat(string room, string seat, object who, string handle, IDictionary<string, string>? tags = null) =>
        Send(HttpMethod.Put, $"/v1/rooms/{E(room)}/seats/{E(seat)}", Body(("who", who), ("handle", handle), ("tags", tags)));

    public Task<Reply> Unseat(string room, string seat) => Send(HttpMethod.Delete, $"/v1/rooms/{E(room)}/seats/{E(seat)}");

    public Task<Reply> CloseRoom(string room) => Send(HttpMethod.Delete, $"/v1/rooms/{E(room)}");

    /// <summary>Check a line a player typed. Broadcast line.text to every seat except those in hiddenFor, or tell the author the refusal.</summary>
    public Task<Reply> CheckLine(string room, string seat, string text) =>
        Send(HttpMethod.Post, $"/v1/rooms/{E(room)}/seats/{E(seat)}/lines", new { text }, idempotent: true);

    /// <summary>Report another player. No report id comes back.</summary>
    public Task<Reply> Report(string room, string seat, string target, string? lineId = null, string? reason = null) =>
        Send(HttpMethod.Post, $"/v1/rooms/{E(room)}/seats/{E(seat)}/reports", Body(("target", target), ("lineId", lineId), ("reason", reason)), idempotent: true);

    public Task<Reply> PendingNotices(object who) => Send(HttpMethod.Post, "/v1/notices/pending", new { who });

    public Task<Reply> Ack(string id, object who) => Send(HttpMethod.Post, $"/v1/notices/{E(id)}/ack", new { who });

    public Task<Reply> Record(object who) => Send(HttpMethod.Post, "/v1/record", new { who });

    public Task<Reply> Restriction(object who) => Send(HttpMethod.Post, "/v1/restriction", new { who });

    /// <summary>The login and matchmaking check. kind is join, create, public or matchmaking.</summary>
    public Task<Reply> DoorsCheck(string kind, object who) => Send(HttpMethod.Post, "/v1/doors/check", new { kind, who });

    public Task<Reply> NamesCheck(string name) => Send(HttpMethod.Post, "/v1/names/check", new { name });

    public Task<Reply> Mute(string room, string seat, string target) =>
        Send(HttpMethod.Put, $"/v1/rooms/{E(room)}/seats/{E(seat)}/mutes/{E(target)}");

    public Task<Reply> Mutes(string room, string seat) => Send(HttpMethod.Get, $"/v1/rooms/{E(room)}/seats/{E(seat)}/mutes");
}
